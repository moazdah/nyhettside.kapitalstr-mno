# Pålitelig nyhetsmotor

Denne endringen beholder GitHub-planene og dagens horisontale live-bar. Fullartikler
forblir i gjennomgangsmodus (`EDITORIAL_AUTOPUBLISH_V1=false`). Live-meldinger har en
separat innstilling i admin, `live_publish_enabled`, på som standard. Hovedbryteren
stopper fortsatt begge motorene.

## Databasemigrasjon og verifisering

`002_news_engine.sql` må migreres før koden aktiveres. Den legger til jobbkø,
publiseringsbryter og originalt kildetidspunkt; ingen artikler endres eller slettes.
Workflow `News engine isolated validation` kontrollerer identiteten til den eksisterende
Neon-testgrenen, at den ikke er produksjon, atomisk migrasjon, samtidige arbeidere,
utløpt lås, gjenopptakelse, retry-grense, samt 30-sekunders polling i Chromium mot testdata.
Produksjonsforbindelsen brukes bare til å kontrollere at endepunktet er forskjellig.

`engine_jobs` lagrer pending/running/retry/done/failed. Unik kind+slot hindrer doble
planlagte jobber. Én lease per motortype, 330 sekunder, beskytter arbeid som kan kjøre
inntil 300 sekunder. Gammelt eierskap kan ikke lagre checkpoint eller publisere feed.
Publisering har atomisk duplikatkontroll og trimming til 12 aktive meldinger. Retry
beholder samme radar-ID og publiseringstid. Kildetid lagres separat; utledet dato fra
URL eller tilfeldig time-element godtas ikke som original publiseringstid.

Eksterne HTTP-/modellkall er at-least-once: et avbrudd før lagring kan gjenta et kall
og koste ekstra. Databaselagringen er idempotent. Markedsoppdateringer er upserts.
Feil på et steg prøves inntil fem ganger, med 30–150 sekunders ventetid. Etter det
vises jobben som failed; den slettes ikke automatisk. Saksarbeid har i tillegg sine
allerede eksisterende lease- og retry-regler.

Admin viser siste vellykkede puls, siste fullførte redaksjonsrunde, jobbstatus og
siste jobbfeil. Live-forsinkelse måles fra vellykket fullføring, minus femminuttersmålet.
10 minutter uten puls gir varselstatus; 15 minutter gir rødt varsel. Natt og avslått
motor utløser ikke forsinkelsesvarsel. Ved åpning 06:00 gis 15 minutter oppstartsrom.

## Senere aktivering av Vercel Cron

Ingen betalt plan eller ny cron er aktivert i denne endringen. `/api/cron/engine`
avviser uautentiserte kall og gjør ingen arbeid med mindre `NEWS_SCHEDULER=vercel`.
Når dette er satt, returnerer de gamle cron-endepunktene `scheduler_replaced`.

Etter vellykket isolert test og valgt Vercel-plan:

1. Bekreft migrasjon 002 i produksjon og `EDITORIAL_AUTOPUBLISH_V1=false`.
2. Legg `{"path":"/api/cron/engine","schedule":"* * * * *"}` i `crons` i vercel.json.
3. Sett `NEWS_SCHEDULER=vercel`, behold CRON_SECRET, og deploy samlet.
4. Kontroller fremdrift, vellykket live-puls og forsinkelse i admin. Hver wake-up
   behandler ett lagret steg per motor; avbrutte jobber plukkes opp av neste wake-up.
5. Først etter bekreftet drift deaktiveres GitHub-tidsplanene. Ved rollback fjernes
   NEWS_SCHEDULER og cron-oppføringen; dagens GitHub-planer tar over igjen.

Nye live-pulser opprettes hver femte UTC-minutt, nye artikkelrunder hver time innenfor
06:00–23:59 Europe/Oslo. UTC-slotter skiller de to like klokkeslettene ved vintertid.
Dette gjenoppretter uferdige jobber, men lager ikke historiske nyhetsrunder for alle
wake-ups som aldri nådde serveren. Stillstand oppdages av forsinkelsesvarslet.
