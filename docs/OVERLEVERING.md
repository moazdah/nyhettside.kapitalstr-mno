# Kapitalstrøm — overlevering til utviklingshjelp

Dette dokumentet beskriver et prosjekt som skal bygges. Designet er ferdig og ligger i
`Kapitalstrøm.dc.html` i dette repoet. Din oppgave er å bygge produksjonskoden — ikke
å redesigne grensesnittet.

---

## 1. Hva Kapitalstrøm er

En norsk økonominyhetsside der AI gjør det redaksjonelle grunnarbeidet, men et menneske
har siste ordet. AI-en henter fra offentlige kilder, vurderer hva som er viktig, skriver
utkast, og legger dem i en kø. Ingenting publiseres uten at redaktøren godkjenner.

Tre flater i samme applikasjon:

| Flate | Rute | Tilgang |
|---|---|---|
| Forside + seksjoner | `/`, `/markeder`, `/okonomi` … | Åpen |
| Artikkel | `/artikkel/[slug]` | Åpen |
| Redaksjonspanel | `/redaksjon` | Innlogget |

---

## 2. Teknisk oppsett som er bestemt

- **Next.js** (App Router) på **Vercel**
- **Postgres** — Supabase eller Vercel Postgres, ikke avgjort ennå
- **DeepSeek API** for scoring og skriving (valgt på pris)
- **Vercel Cron** for periodisk henting
- Hemmeligheter kun som miljøvariabler i Vercel. Aldri i repoet, aldri i klientkode.

Miljøvariabler som trengs:

```
DATABASE_URL
DEEPSEEK_API_KEY
CRON_SECRET          # beskytter /api/cron/* mot å kalles utenfra
ADMIN_PASSWORD_HASH  # se punkt 8
```

---

## 3. Datamodell

Nøkkelprinsippet: **én tabell for artikler, med statusfelt**. Panelet og forsiden leser
samme tabell — forsiden filtrerer på `status = 'live'`. Ingen speiling, ingen duplikater.

```sql
create table articles (
  id            bigserial primary key,
  slug          text unique not null,
  status        text not null default 'draft',   -- draft | live | arkivert | avvist
  tittel        text not null,
  undertittel   text,
  brodtekst     text not null,                   -- markdown
  seksjon       text not null,                   -- Markeder|Økonomi|Renter|Selskaper|Analyse
  forfatter     text,                             -- pseudonym eller "Kapitalstrøm AI"
  bilde_url     text,
  bilde_kreditt text,

  -- AI-metadata
  ai_score      int,                              -- 0–100, viktighet
  ai_begrunnelse text,                            -- én setning: hvorfor denne scoren
  ai_modell     text,                             -- f.eks. deepseek-chat
  tall_validert boolean default false,            -- se punkt 6
  valideringsnotat text,                          -- hva som ikke stemte, hvis noe

  -- forsideplassering
  pinned        boolean default false,            -- låst av redaktør, overstyrer score
  pinned_pos    int,

  kilde_id      bigint references sources(id),
  kilde_url     text,
  kilde_hentet  timestamptz,
  publisert_at  timestamptz,
  created_at    timestamptz default now()
);

create table sources (
  id        bigserial primary key,
  navn      text not null,          -- "Norges Bank", "NewsWeb", "SSB"
  type      text not null,          -- api | rss | scrape
  url       text not null,
  aktiv     boolean default true,
  intervall_min int default 15,
  sist_hentet timestamptz
);

create table raw_items (              -- alt som hentes, før scoring
  id        bigserial primary key,
  kilde_id  bigint references sources(id),
  ekstern_id text,                    -- kildens egen id, for deduplisering
  tittel    text,
  innhold   text,
  publisert timestamptz,
  url       text,
  behandlet boolean default false,
  unique (kilde_id, ekstern_id)
);

create table feed (                   -- "Siste nytt", korte meldinger uten artikkel
  id        bigserial primary key,
  tekst     text not null,
  seksjon   text,
  tidspunkt timestamptz default now(),
  status    text default 'live'
);

create table ai_usage (               -- kostnadskontroll, se punkt 7
  id        bigserial primary key,
  steg      text not null,            -- scoring | skriving
  modell    text,
  tokens_inn int,
  tokens_ut  int,
  kostnad_usd numeric(10,6),
  created_at timestamptz default now()
);

create table markets (                -- ticker og kursbokser
  id        bigserial primary key,
  symbol    text unique not null,     -- USDNOK, OSEBX, BTCNOK …
  navn      text not null,
  verdi     numeric,
  endring_pct numeric,
  historikk jsonb,                    -- [{t, v}] for sparkline
  oppdatert timestamptz
);
```

Marker gjerne `articles` med indekser på `(status, ai_score desc)` og `(seksjon, publisert_at desc)`.

---

## 4. Kildene, i prioritert rekkefølge

**1. Norges Bank — valutakurser.** Åpent API, ingen nøkkel, ferdig JSON/CSV over SDMX.
Enkleste kilden og gir umiddelbart ekte tall i tickeren. Start her.

**2. NewsWeb (Oslo Børs) — børsmeldinger.** Dette er nyhetsmotoren. Meldingene er
strukturerte, tidsstemplede og kategoriserte (kvartalsrapport, innsidehandel, flagging).
Sjekk om det finnes et offisielt API eller feed før du vurderer scraping, og respekter
vilkårene. Godt testmateriale for scoringen: man kan selv se om AI setter en resultatvarsel
over en endring i aksjeprogram.

**3. SSB — statistikk.** Åpent API (JSON-stat). Månedlig frekvens, lav hastverk. KPI og
arbeidsledighet er de mest nyhetsverdige tabellene.

Aksjekurser i sanntid er **ikke** gratis. Det er utredet og lagt til side. Kryptokurser er
gratis (f.eks. CoinGecko). Børsindekser må enten forsinkes, hentes fra en betalt kilde,
eller utelates i første versjon.

Hver kilde bør ha sin egen adapter som normaliserer til `raw_items`, slik at nye kilder
kan legges til uten å røre scoringen.

---

## 5. AI-kjeden — to kall, aldri ett

Dette er bevisst delt for å holde kostnaden nede. Den dyre operasjonen er å skrive
artikler, så vi skriver bare om det som faktisk er viktig.

**Kall 1 — scoring (billig, batch).** Send 10–30 rå-elementer samtidig, bare tittel og de
første par hundre tegnene av hvert. Be om ren JSON tilbake:

```json
[{"id": 412, "score": 87, "seksjon": "Renter", "begrunnelse": "…", "bildesok": "norges bank bygning"}]
```

Bruk JSON-modus / `response_format`, og valider strukturen før du skriver til databasen.
Ikke la modellen skrive prosa i dette steget.

**Kall 2 — skriving (dyrere, selektiv).** Kjør bare på elementer med score over terskel
(start på 60). Ett kall per artikkel, med fullteksten fra kilden. Modellen skal returnere
tittel, undertittel og brødtekst — og **ingen tall som ikke finnes i kildeteksten**. Det
siste er viktig nok å gjenta i systemprompten.

Artikler lagres alltid med `status = 'draft'`.

**Bilder:** AI-en foreslår søkeord (`bildesok` over), backend velger bilde fra eget arkiv
eller NTB. Modellen får aldri velge bilde direkte.

---

## 6. Tallvalidering

Før et utkast får ligge i køen som grønt: plukk ut alle tall fra `brodtekst` med regex, og
sjekk at hvert av dem finnes i kildeteksten. Stemmer alt, sett `tall_validert = true`.
Finnes det tall som ikke er i kilden, sett `false` og skriv hva som avviker i
`valideringsnotat`.

Panelet viser dette som `TALL VALIDERT` (grønn) eller `AVVIK I TALL` (rød). Saker med
avvik skal **aldri** kunne autopubliseres, uansett hvilke automatikkinnstillinger som er
satt.

---

## 7. Kostnadskontroll

Hvert DeepSeek-kall logges i `ai_usage` med tokens og beregnet kostnad. Panelets
høyrekolonne viser forbruk i dag og denne måneden mot et tak.

Logikk: når dagstaket nås, stopp skrivekallene men la scoringen gå videre (den er billig, og
redaktøren skal fortsatt se hva som skjer). Når månedstaket nås, stopp all AI og vis det
tydelig i panelet. Ingen stille overskridelse.

---

## 8. Innlogging

Startpunkt: ett delt passord for `/redaksjon`, verifisert serverside mot en hash i
miljøvariabel, med en signert cookie som sesjon. Enkelt og godt nok for én redaktør.

Bygg det likevel slik at det kan byttes til flere brukere med roller (skribent / redaktør)
uten å rive opp resten — altså sjekk rolle i en middleware, ikke spredt i hver rute.

---

## 9. Panelet — de fem fanene

Alt dette finnes ferdig designet i `Kapitalstrøm.dc.html`. Kort om hva hver fane gjør:

**Kø til godkjenning.** AI-utkast sortert etter score. Hver rad: score, seksjon, kilde,
klokkeslett, valideringsmerke, og knapper for å åpne, godkjenne eller avvise. Redaktøren
kan overstyre scoren manuelt når AI tar feil.

**Forsideprioritering.** Rekkefølgen følger score som standard. Flytter redaktøren en sak,
låses den (`pinned`) til den frigis igjen. Nivåene er Hovedsak (posisjon 1), Mellomstor
(2–3), og resten. Endringer slår ut på forsiden umiddelbart.

**Publisert.** Det som er live, med mulighet til å redigere eller arkivere.

**Siste nytt.** Korte meldinger som ikke blir egne artikler. Skrives direkte, publiseres
direkte.

**Kilder & automatikk.** Hvilke kilder som er aktive og hvor ofte de hentes. Hvor mye AI
får gjøre uten godkjenning — standard er at korte meldinger kan gå automatisk, fulle
artikler krever godkjenning, og saker med tallavvik blokkeres alltid.

Forhåndsvisning skal vise artikkelen slik den faktisk blir seende ut på forsiden, ikke som
et redigeringsskjema.

---

## 10. Cron-jobber

```
/api/cron/hent      hvert 15. min   henter alle aktive kilder → raw_items
/api/cron/score     hvert 15. min   scorer ubehandlede raw_items → articles (draft)
/api/cron/skriv     hvert 15. min   skriver utkast for score ≥ terskel
/api/cron/markeder  hvert 5. min    oppdaterer kurser og sparkline-historikk
```

Alle skal avvise kall uten riktig `CRON_SECRET`. Alle skal være idempotente — en jobb som
kjører to ganger skal ikke produsere duplikater. Dedupliseringen ligger i
`raw_items(kilde_id, ekstern_id)`.

---

## 11. Designet — les det, ikke gjenskap det

`Kapitalstrøm.dc.html` er en designfil, ikke produksjonskode. Den bruker et eget
komponentformat og skal **ikke** kjøres i produksjon. Bruk den som spesifikasjon for
utseende og oppførsel: åpne den i nettleser for å se den, og les markupen for å hente ut
farger, typografi, avstander og layout.

Visuelle verdier som skal beholdes:

```
Bakgrunn        #F8F7F3
Tekst           #151719
Dempet tekst    #65696D
Svakt dempet    #98A0A6
Aksent (marine) #082B45   hover #0B3A5C
Kantlinje       #DDDCD7
Grønn (opp)     #18794E
Rød (ned)       #B42318
Kort/flater     #FFFFFF

Overskrifter    Newsreader (serif)
Grensesnitt     IBM Plex Sans
Tall og kurser  IBM Plex Mono
```

Merk at tall alltid settes i mono. Det er gjennomgående i designet og en del av
uttrykket — kurser, klokkeslett, scores, tokenforbruk.

Layoutbredde er maks 1340 px med 32 px sidemarg. Brytepunkter ligger på 1080, 820 og
560 px. Ingen runde hjørner utover 3 px på knapper. Ingen skygger utover en svak på
åpne menyer. Uttrykket er tett, redaksjonelt og rolig — ikke dashbord-aktig.

Logoen ligger som PNG i repoet.

---

## 12. Rekkefølge jeg vil foreslå

1. Next.js-prosjekt på Vercel, tomt men deployet
2. Database og skjema
3. Norges Bank-adapteren og `markets` — første ekte tall på skjermen
4. Forsiden mot databasen, med testdata
5. Innlogging og panelet
6. NewsWeb-adapteren
7. Scoringskallet, mot et lite håndplukket sett børsmeldinger som testdata
8. Vurder om scoringen prioriterer riktig — juster prompt før du går videre
9. Skrivekallet og tallvalideringen
10. Cron og kostnadstak
11. SSB

Punkt 8 er verdt å bruke tid på. Hvis scoringen rangerer dårlig, blir resten av systemet
ubrukelig uansett hvor godt det er bygget.

---

## 13. Ting som ikke er bestemt

- Postgres hos Supabase eller Vercel
- Domenenavn
- Om artikkelbilder skal komme fra NTB-abonnement eller eget arkiv i starten
- Hvilke børsindekser som kan vises uten betalt datakilde
- Pseudonymene i designet (Kari Hansen, Henrik Olsen, Marius Berg, Ingrid Vollan) er
  plassholdere. Avklar hvordan AI-skrevne saker skal krediteres før publisering — det er
  et redaksjonelt spørsmål, ikke et teknisk.
