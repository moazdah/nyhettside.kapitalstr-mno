# Kapitalstrøm v2 — Neon koblet til Next.js

Denne versjonen erstatter hardkodede forside-, feed- og markedsdata med data fra Neon Postgres via `DATABASE_URL`.

## Krever i Vercel

- `DATABASE_URL` fra Neon-integrasjonen

## Datadrevet nå

- Forsideartikler fra `articles` (`status = 'live'`)
- Siste nytt fra `feed`
- Markedsdata fra `markets`
- Dynamiske artikkelsider på `/artikkel/[slug]`
- Helsesjekk på `/api/health`

## Deploy

Last prosjektfilene opp til GitHub-repoets rot. Vercel deployer automatisk fra `main`.
