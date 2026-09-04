# Kaufcheck — Deployment

## Struktur
- `public/index.html` — die Website
- `api/search.js` — Serverfunktion, die sicher mit deinem Anthropic API-Key arbeitet

## Wichtig
Der API-Key darf NIEMALS in `public/index.html` stehen. Er gehört ausschließlich
in die Umgebungsvariable `ANTHROPIC_API_KEY` auf Vercel (siehe Anleitung im Chat).

## Cache
Identische Anfragen (gleiches Modell/Baujahr/Motor bzw. gleiche HSN/TSN) werden
24 Stunden zwischengespeichert und lösen dann keine erneute, kostenpflichtige
API-Anfrage aus. Lebt ebenfalls nur, solange die Funktion "warm" ist.

## Rate Limit
`api/search.js` begrenzt aktuell auf 15 Anfragen pro Stunde pro IP-Adresse.
Der Zähler lebt nur, solange die Funktion "warm" ist — für einen robusteren
Schutz später ggf. Upstash Redis ergänzen.
