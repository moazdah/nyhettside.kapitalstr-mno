# Kapitalstrøm v3 — redaksjonspanel

Denne versjonen bygger videre på Neon-integrasjonen og legger til et passordbeskyttet redaksjonspanel på `/redaksjon`.

## Nye deler

- `/redaksjon/login` — serververifisert innlogging
- `/redaksjon` — kø, forsideprioritering, publiserte saker, siste nytt og kilder
- Godkjenn / avvis utkast
- Arkiver publiserte saker
- Lås/frigi hovedsak
- Middleware som beskytter `/redaksjon/*`
- HTTP-only signert sesjonscookie

## Krever i Vercel

- `DATABASE_URL` (allerede koblet via Neon)
- `ADMIN_PASSWORD_HASH`

`ADMIN_PASSWORD_HASH` er SHA-256 av passordet. Åpne `tools/admin-password-hash.html` lokalt i nettleseren for å lage hashen uten å sende passordet noe sted.

## Merk

Dette følger prosjektets første auth-steg: ett delt redaksjonspassord. Før offentlig lansering bør dette byttes til egne brukere/roller.
