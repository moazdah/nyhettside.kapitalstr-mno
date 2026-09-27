# Automatisk hurtigdesk

Brukeren godkjente 27. september 2026 helautomatisk publisering. Dette erstatter
forrige utrullings krav om manuell gjennomgang. `editorial_settings` er nå eneste
publiseringsinnstilling; `EDITORIAL_AUTOPUBLISH_V1` er en utgått utrullingsvariabel.
Hovedbryter og artikkelbryter kontrolleres også inne i publiseringstransaksjonen.
Eksisterende kilde-, ferskhets-, faktapakke- og uavhengige utkastkontroller består.
Avslag gir ingen publisering. Gamle utkast massepubliseres ikke.

## Første hendelsestype: Norges Banks rentevedtak

Den faste, offisielle pressemeldingsfeeden leverer originalt publiseringstidspunkt.
Bare bankens daterte rentevedtak-URL aksepteres. Overskrift og beslutningstekst må
stemme om nivå, retning og tidligere nivå. Funn eldre enn to timer eller mer enn
ett minutt i fremtiden avvises. Kalenderen alene er aldri bevis for et vedtak.

Første versjon er en kort, regelbasert melding uten venting på AI. Artikkel,
feedmelding, hendelseslogg og utdypingsjobb lagres i samme transaksjon. Unik kilde-URL
og artikkelkobling hindrer duplikater, også ved samtidige arbeidere. Feed begrenses
til 12 aktive meldinger under samme lås som den ordinære live-motoren.

AI skriver 3–5 avsnitt og tre oppsummeringspunkter. En separat modellforespørsel
kontrollerer hver blokk mot kildeutdrag. Utdragene må finnes ordrett i kilden og
alle tall må finnes i kildeteksten. Godkjent utdyping erstatter teksten på samme
artikkeladresse og lagres som revisjon. Første publiseringstid endres aldri.
AI-kontroll reduserer risiko, men er ingen garanti mot alle innholdsmessige feil.
Feil beholder den verifiserte kortmeldingen og gjenforsøkes av den varige jobbkøen
(inntil fem forsøk). Revisjonene lagrer kontrollbevis. Ved uttømt budsjett vises feilen
og failed-jobben i admin; ingen usikker utdyping publiseres.

SISTE-markeringen og forsiderangeringen gjelder i to timer. Forsidebanner og åpen
artikkel oppdateres hvert tiende sekund, og ved retur til fanen. Puls respekterer
redusert bevegelse. Oppsummeringen kan åpnes av leseren. Uten bilde vises teksten
direkte, uten en tom fotoplassholder. Bildeutvelgelse og bredere deskprioritering er
senere arbeid. Prioritet for ordinære saker avtar nå med alder; manuell pin respekteres.

## Utrulling og tidsstyring

1. Isolert validering krever den kjente Neon-testgrenen og ulikt produksjonsendepunkt.
   Historisk vedtak spilles av med injisert klokke kun i testskript, aldri i HTTP-API.
2. `prepare-breaking-desk.mjs` krever identisk testet migrasjon 003 og bevarer brytere.
3. Etter deploy venter `activate-breaking-desk.mjs` på nøyaktig produksjonscommit før
   hovedbryter, artikkel-, live- og breaking-publisering settes på.
4. Eksisterende GitHub-rentevakt kaller nå offisiell watcher, etterfulgt av separat
   utdyping. Det gamle markedstallsoppslaget lager ikke lenger renteutkast.

**Bekreftet Vercel-plan: Hobby.** Dagens GitHub-plan søker hvert femte minutt på
hverdager 06–16 UTC, men oppstart kan bli vesentlig forsinket. Dette oppsettet kan
ikke love publisering innen 60 sekunder fra kilden. Måling av rask behandling etter
oppdagelse er ikke dokumentasjon på presis oppstart.

`vercel.cron-ready.json` er klargjort, men er ikke aktiv konfigurasjon. Etter valgt
plan med minuttkjøring (Vercel Pro): erstatt `vercel.json` med dette innholdet,
sett `NEWS_SCHEDULER=vercel`, behold CRON_SECRET og deploy. Verifiser hyppige vellykkede
kildesjekker, fremdrift og faktiske ende-til-ende-tider før GitHub-planer skrus av.
Vercel minuttkjøring er heller ingen hard sanntidsgaranti. Breaking-rutene er
idempotente ved overlapp mellom gammel og ny tidsstyring. Ved rollback fjernes
NEWS_SCHEDULER og cron-konfigurasjonen; GitHub-planene kan overta.

Produksjonens gamle rentenyheter blir ikke merket SISTE i ettertid. Admin viser
kildetid, oppdagelse, første publisering, utdyping og siste vellykkede kildesjekk.
Mer enn ti minutter uten kildesjekk innenfor vaktens åpningstid gir rødt varsel.
