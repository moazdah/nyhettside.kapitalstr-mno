# Kapitalstrøm v4.1 — Norges Bank + rentevakt

Denne versjonen bygger videre på v4 og legger til overvåking av Norges Banks styringsrente.

## Nytt i v4.1

- Beholder valutakursadapteren for USD/NOK, EUR/NOK, GBP/NOK, SEK/NOK, DKK/NOK og CHF/NOK.
- Ny egen adapter for **styringsrenten**.
- Leser Norges Banks offisielle styringsrenteside først, med API-serien som reserve/bekreftelse.
- Lagrer styringsrenten i `markets` som `NOKPOLICY`.
- Viser styringsrenten i ticker/markedsdata med endring i prosentpoeng.
- Første kjøring oppretter bare referanseverdien.
- Dersom styringsrenten senere endres, opprettes automatisk:
  - et `raw_items`-element,
  - et artikkelutkast med score 100 og `tall_validert = true`,
  - en `feed`-melding med status `draft`.
- **Ingenting autopubliseres ennå.** Redaktøren må fortsatt godkjenne.
- Ny beskyttet endpoint: `GET /api/cron/norges-bank` med `Authorization: Bearer $CRON_SECRET`.
- Redaksjon → Kilder & automatikk får egne knapper for «Oppdater alt nå» og «Sjekk renten nå».

## Viktig om automatisk frekvens

Koden er klar for automatiske sjekker, men høyfrekvent tidsplan er ikke lagt i `vercel.json` i denne pakken. Det er med vilje, slik at et Hobby-prosjekt ikke blokkeres av en cron-plan som kjører oftere enn abonnementet tillater. Neste steg er å opprette `CRON_SECRET`, teste endpointet og velge scheduler.

## Testflyt

1. Deploy denne versjonen.
2. Logg inn på `/redaksjon`.
3. Åpne **Kilder & automatikk**.
4. Trykk **Sjekk renten nå**.
5. Første kjøring skal registrere dagens styringsrente uten å opprette breaking-utkast.
6. Kontroller at `Styringsrente` vises på forsiden og i redaksjonspanelet.
7. Opprett deretter `CRON_SECRET` før automatisk scheduler aktiveres.
