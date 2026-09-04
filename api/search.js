// Serverless-Funktion für Vercel: /api/search
// Nimmt die Fahrzeug-Suchanfrage vom Frontend entgegen, ruft damit sicher
// (mit geheimem API-Key) die Anthropic-API auf und gibt nur das Ergebnis zurück.
// Der API-Key steht NIEMALS im Frontend-Code, sondern nur hier als Umgebungsvariable.

// --- Einfacher Antwort-Cache ---
// Gleiche Anfragen (gleiches Modell/Baujahr/Motor bzw. gleiche HSN/TSN) werden
// für eine Weile zwischengespeichert, statt jedes Mal erneut die kostenpflichtige
// API-Anfrage auszulösen. Gleicher Hinweis wie beim Rate-Limiter: lebt nur,
// solange die Funktion "warm" ist. Für dauerhaftes Caching über Neustarts hinweg
// später z.B. Vercel KV oder Upstash Redis ergänzen.
const responseCache = new Map(); // key -> { data, expiresAt }
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 Stunden

function getCacheKey({ mode, model, year, engine, hsn, tsn }) {
  if (mode === 'hsn') {
    return `hsn:${String(hsn).trim().toLowerCase()}|${String(tsn).trim().toLowerCase()}`;
  }
  return `model:${String(model).trim().toLowerCase()}|${String(year || '').trim()}|${String(engine || '').trim().toLowerCase()}`;
}

function getCached(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  responseCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// --- Einfacher, bewusst simpler Rate-Limiter ---
// Hinweis: Dieser Speicher lebt nur, solange die Funktion "warm" ist (Vercel
// kann sie jederzeit neu starten -> Zähler springt dann zurück auf 0). Das ist
// ein bekannter, akzeptabler Kompromiss für den Start. Für einen robusteren
// Schutz später: Upstash Redis (kostenloses Tier reicht für den Anfang) mit
// @upstash/ratelimit einbinden.
const requestLog = new Map(); // ip -> [timestamps]
const MAX_REQUESTS_PER_HOUR = 15;

function isRateLimited(ip) {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < oneHour);
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > MAX_REQUESTS_PER_HOUR;
}

const SYSTEM_PROMPT = `Du bist ein Assistent für Gebrauchtwagen-Kaufberatung. Nutze Websuche (Foren, Testberichte, DEKRA-Report, TÜV-Report, Fachpresse) um für das angegebene Fahrzeugmodell/Motor konkrete, realistische Informationen zu sammeln.

Wenn HSN und TSN angegeben sind (statt Marke/Modell), identifiziere zuerst das Fahrzeug über diese offiziellen KBA-Schlüsselnummern (z.B. über kba.de oder Fachdatenbanken, die Schlüsselnummern auflösen).

Prüfe, ob das angegebene Baujahr (falls vorhanden) zur Produktionszeit dieses Modells passt.

Antworte AUSSCHLIESSLICH mit validem JSON, kein Markdown, keine Erklärung davor oder danach. Format:

{
  "identified_vehicle": "Marke, Modell, Motor/Variante wie identifiziert",
  "year_valid": true,
  "year_note": "falls year_valid false ist: kurzer Satz auf Deutsch mit den tatsächlichen Produktionsjahren dieses Modells, sonst leerer String",
  "weak_points": [{"title": "kurzer Titel", "description": "1-2 Sätze auf Deutsch"}],
  "maintenance": [{"item": "z.B. Ölwechsel", "interval": "z.B. alle 15.000 km / 1 Jahr"}],
  "recalls": [{"title": "kurzer Titel der Rückrufaktion", "date": "Jahr oder Monat/Jahr", "description": "1-2 Sätze auf Deutsch"}],
  "checklist": ["konkreter Prüfpunkt beim Besichtigen, spezifisch für dieses Modell/diesen Motor"],
  "comparable_models": [{"name": "Marke Modell Motor", "note": "1 kurzer Satz: warum vergleichbar"}]
}

Regeln:
- Konnte ein per HSN/TSN gesuchtes Fahrzeug nicht eindeutig identifiziert werden, setze "year_valid" auf false und "year_note" entsprechend.
- Wenn kein Baujahr angegeben wurde, setze "year_valid" auf true und "year_note" auf einen leeren String.
- Wenn das Baujahr angegeben, aber das Modell in diesem Jahr nachweislich nicht produziert wurde, setze "year_valid" auf false und fülle "year_note" mit den echten Produktionsjahren.
- Maximal 6 Einträge bei weak_points/maintenance/recalls/checklist, maximal 4 bei comparable_models.
- Nur real bekannte, plausible Informationen verwenden. Erfinde nichts, was nicht durch Recherche gestützt ist.
- "maintenance" muss Ölwechsel und, falls zutreffend, Zahnriemen ODER Steuerkette enthalten plus 1-3 weitere relevante Intervalle.
- "recalls" enthält nur echte, dokumentierte Rückrufaktionen (z.B. über kba.de). Wenn keine bekannt sind, leeres Array zurückgeben.
- "checklist" soll modellspezifisch sein, nicht generische Ratschläge.
- "comparable_models" sind echte, existierende Fahrzeuge in ähnlicher Klasse/Preissegment.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Nur POST-Anfragen erlaubt.' });
  }

  const { mode, model, year, engine, hsn, tsn } = req.body || {};

  let userRequest;
  if (mode === 'hsn') {
    if (!hsn || !tsn) {
      return res.status(400).json({ error: 'Bitte HSN und TSN angeben.' });
    }
    userRequest = `HSN: ${String(hsn).slice(0, 10)}\nTSN: ${String(tsn).slice(0, 10)}`;
  } else {
    if (!model) {
      return res.status(400).json({ error: 'Bitte mindestens Marke und Modell angeben.' });
    }
    userRequest = [
      `Modell: ${String(model).slice(0, 100)}`,
      year ? `Baujahr: ${String(year).slice(0, 20)}` : null,
      engine ? `Motor/Variante: ${String(engine).slice(0, 100)}` : null
    ].filter(Boolean).join('\n');
  }

  // Cache zuerst prüfen — ein Treffer kostet nichts und zählt nicht gegen das Rate-Limit.
  const cacheKey = getCacheKey({ mode, model, year, engine, hsn, tsn });
  const cached = getCached(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Zu viele Anfragen. Bitte später erneut versuchen.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server ist nicht korrekt konfiguriert (fehlender API-Key).' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userRequest }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('Anthropic API Fehler:', response.status, detail);
      return res.status(502).json({ error: 'Fehler bei der Suche (Status ' + response.status + '): ' + detail.slice(0, 200) });
    }

    const data = await response.json();
    const textBlocks = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const cleaned = textBlocks.replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      return res.status(502).json({ error: 'Antwort konnte nicht gelesen werden.' });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    setCached(cacheKey, parsed);
    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Serverfehler:', err.message);
    return res.status(500).json({ error: 'Etwas ist schiefgelaufen. Bitte später erneut versuchen.' });
  }
}
