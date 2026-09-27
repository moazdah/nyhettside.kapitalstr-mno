# Redaksjonell desk, flere hurtigspor og drift over tid

Denne leveransen tar de seks gjenstående punktene etter at automatisk publisering ble
slått på 27. september 2026. Alt er additivt: ingen artikler, URL-er eller
publiseringstider slettes eller skrives om. Databaseendringen er `004_newsroom_desk.sql`.

## 1. Tidsstyring og måling fra kilde til synlig sak

**Status for Vercel-planen:** Kontoen står fortsatt på **Hobby** (kontrollert via Vercel-API
27. september). Hobby tillater bare cron én gang per døgn, så minuttkjøring på Vercel kan
ikke aktiveres før planen er oppgradert. Oppgraderingen er et kjøp som eieren må gjøre selv.

Inntil videre:

- Ny workflow `fast-track.yml` holder en GitHub-runner i live i ca. 16 minutter og sjekker
  alle offisielle kilder **hvert minutt** (hverdager 04–21 UTC). En forsinket eller tapt
  GitHub-start rammer derfor ikke lenger hvert femte minutt, men bare overgangen mellom to
  kjøringer. Repoet er offentlig, så minuttene er gratis.
- AI-utdyping kjøres i bakgrunnen i samme løkke, slik at den ikke forsinker neste kildesjekk.
- Hver kjøring lagres i `scheduler_ticks`. Admin og `/api/health` viser median, 95-persentil
  og lengste opphold mellom kjøringer siste døgn.
- Kilde → synlig måles per hendelse: `source_published_at` (kildens egen tid) →
  `first_published_at` (publisert) → `visible_verified_at` (produksjonen henter selv den
  offentlige artikkelsiden over HTTP og registrerer første vellykkede svar). Median,
  90-persentil og verste tid for siste 30 dager vises i admin og `/api/health`.
- `vercel.json` har nå en daglig driftskontroll (tillatt på Hobby) som ekstra, uavhengig puls.

**Aktivering etter oppgradering til Vercel Pro** (ett trinn, ingen kodeendring):

1. Erstatt innholdet i `vercel.json` med `vercel.cron-ready.json` (minuttkall til
   `/api/cron/engine` og driftskontroll hvert tiende minutt).
2. Sett `NEWS_SCHEDULER=vercel` for Production i Vercel, behold `CRON_SECRET`, og deploy.
3. `/api/cron/engine` kjører da hurtigsporet først, deretter utdyping, live-puls,
   redaksjonsrunde og driftsvurdering. GitHub-hurtigsporet svarer `scheduler_replaced` og
   avslutter seg selv. Driftsvakten på GitHub fortsetter som uavhengig kontroll.
4. Sammenlign målingene i admin før og etter. Ved rollback: fjern `NEWS_SCHEDULER` og
   cron-oppføringen, så tar GitHub over igjen. Minuttcron er heller ingen hard sanntidsgaranti.

## 2. Én redaksjonell prioritering

`lib/desk/priority.mjs` vurderer alle saker – hurtigspor, vanlige artikler og live-meldinger –
på fire eksplisitte akser (0–100): **norsk relevans, nyhetsverdi, aktualitet og
leserinteresse**. Vektet sum gir én deskscore som bestemmer:

| Score | Plassering | Banner (SISTE) | Live-melding |
| --- | --- | --- | --- |
| ≥ 82 | Hovedsak (`lead`) | Bare offisielle hurtigsaker, og bare når de er ferske | Ja, når saken er fersk |
| 66–81 | Toppsak (`top`) | Nei | Ja, når saken er fersk |
| < 66 | Vanlig (`standard`) | Nei | Bare ≥ 60 |

Forsiden sorterer på lagret deskscore minus to poeng per time, pluss 15 poeng mens et banner
er aktivt. Manuell pin overstyrer som før. Vurderingen lagres på artikkelen
(`priority_score`, `placement`, `desk_assessment` med begrunnelser), så valget kan etterprøves.
Den vanlige utvelgelsen bruker samme vurdering, pluss kildetroverdighet.

**Flere kilder om samme hendelse samles i samme sak.** Når utvelgelsen eller live-pulsen finner
en hendelse som allerede er publisert (for eksempel en rentebeslutning fra hurtigsporet), blir
funnet lagt til som kilde på den eksisterende saken i stedet for en ny artikkel eller en ny
live-melding. Motstridende tall i titlene (4,25 mot 4,50) regnes aldri som samme sak.
Artikkelsiden viser «Kilder i saken». Hurtigsaker får en `story_key`
(f.eks. `ssb:kpi:2026M08`) som hindrer dobbeltpublisering også ved ny URL.

## 3. Hurtigspor for flere kilder

| Kilde | Hva | Kortmelding | AI-utdyping |
| --- | --- | --- | --- |
| Norges Bank | Rentebeslutning | Som før | Ja, verifisert |
| SSB | KPI og KPI-JAE (tolvmånedersvekst) | Tallene ordrett fra statistikkbanken, med forrige måned | Nei – tallene er selve saken |
| Oslo Børs | Resultater og innsideinformasjon fra ca. 40 store selskaper | Utsteder + meldingens tittel i anførselstegn | Ja, verifisert mot meldingsteksten |

- SSB leses fra det åpne API-et (PxWebApi, JSON-stat 2). Variabelkoder finnes fra tabellens
  egne etiketter, så en omdøpt kode stopper saken i stedet for å gi feil tall. Første gang en
  periode sees, publiseres den bare hvis den er under tre timer gammel.
- Oslo Børs: invitasjoner, innsidehandler, tilbakekjøp, finanskalender og flagging filtreres
  bort. Meldinger eldre enn to timer publiseres ikke. Tall kommer først gjennom den separate,
  verifiserte utdypingen; mangler lesbar meldingstekst, blir kortmeldingen stående alene.
- Hver kilde har eget vindu (norsk tid) og egen kretsbryter: feil gir økende pause
  (20 s → 5 min) uten å stoppe de andre kildene.
- `Fast-track sources live check` kjører parserne mot de ekte kildene (uten database,
  publisering eller AI). Den kjøres ved endring og ukentlig, og **må være grønn før merge**,
  fordi utviklingsmiljøet ikke hadde nettilgang til SSB og Euronext.

## 4. «Saken oppsummert» på vanlige artikler

Vanlige AI-artikler får inntil fire punkter fra faktapakken. Bare fakta som allerede har
bestått research med ordrett kildeutdrag tas med – det gjøres ikke noe nytt AI-kall.
Opplysninger som må krediteres, får «ifølge …». AI-vurderingen kopieres aldri inn i
oppsummeringen; den står som før i en egen, merket blokk, og oppsummeringsboksen sier
eksplisitt at vurderingen ikke er bekreftet fakta. Migrasjonen fyller inn punkter for
eksisterende verifiserte artikler.

## 5. Automatisk bildevalg

1. Redaksjonens eget bildebibliotek (`image_library`, `origin='editor'`) – bruksrett avklart av
   redaksjonen – brukes først.
2. Ellers søkes Wikimedia Commons for et kjent motiv (Norges Bank, SSB, Oslo Børs, store
   selskaper, olje, sentralbanker, kronen). Bildet godtas bare med fri lisens lest fra filens
   egne metadata (CC0, offentlig eie, CC BY/BY-SA), minst 1200 px, og uten varemerke- eller
   personvernsbegrensning. Kreditering lagres som «Foto: Navn / Wikimedia Commons (lisens)»
   med lenke til bruksvilkår.
3. Uten godkjent bilde brukes en gjennomført reservevisning: seksjonsfarge, seksjonsnavn og
   hovedtallet fra tittelen når det finnes. Artikkelsiden viser da teksten uten bildeflate.

Bilder velges etter publisering og kan aldri forsinke eller stoppe en sak. Et bilde valgt av
redaktør erstattes aldri.

## 6. Drift som tåler lengre problemer

- Raske forsøk er uendret (fem forsøk, 30–150 s).
- Utdypingsjobber som har brukt opp de raske forsøkene, gjenopplives med økende pause
  (10, 20, 40, 80, 160, 320 minutter ≈ 10,5 timer) før de gis opp.
- Varsler (`ops_alerts`, ett åpent varsel per problem, løses automatisk ved friskmelding):
  kilde nede i 20 min (kritisk etter 60), jobb gjenopplives (advarsel), alle forsøk brukt opp
  (kritisk), og tidsstyringen har stoppet i vaktens åpningstid (kritisk).
- `ops-watchdog.yml` kjører hvert tiende minutt. Nye varsler leveres én gang: workflowen feiler
  slik at GitHub sender e-post til repo-eieren, og hvis `ALERT_WEBHOOK_URL` er satt i Vercel
  (Slack/Teams/Discord-kompatibel) sendes de dit også. Svarer ikke produksjonen, feiler
  workflowen også.
- Admin viser åpne varsler, status per kilde, kretsbryter og målingene fra punkt 1.

## Utrulling

1. `Prepare newsroom desk schema (migration 004)` kjører testene, migrerer den kjente,
   isolerte Neon-testgrenen, gjør en syntetisk hurtigpublisering der og rydder opp, og migrerer
   deretter produksjon med kontroll av at brytere og artikkelantall er uendret.
2. `Fast-track sources live check` må være grønn.
3. Merge til `main`. Vercel deployer. Fra da overtar `fast-track.yml` for den gamle rentevakten.

## Kjente begrensninger

- Minuttkjøring på Vercel krever oppgradering; GitHub-løkken gir minuttkadens, men starten av
  hver løkke kan fortsatt forsinkes av GitHub.
- Deskscoren er en regelmodell. Den er forklarbar og testet, men ikke kalibrert mot faktisk
  lesertrafikk ennå.
- Sammenslåing bygger på titler og tall. Svært ulikt formulerte titler om samme hendelse kan
  fortsatt bli egne saker.
- Commons-bilder er generiske motivbilder (bygg, anlegg), ikke nyhetsfoto fra hendelsen.
