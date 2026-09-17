# Kapitalstrøm v4.2 — Norges Bank + rentevakt + korrekt FX-enhet

Denne versjonen bygger videre på v4.1 og retter visningen av valutapar som Norges Bank leverer per 100 valutaenheter.

## Nytt i v4.2

- Beholder hele v4.1: Norges Bank-valutakurser, styringsrentevakt, redaksjonspanel og beskyttet cron-endpoint.
- Normaliserer **SEK, DKK og CHF** fra Norges Banks 100-enhetsnotering til vanlig kurs per 1 valutaenhet før verdien lagres i `markets`.
- Viser dermed for eksempel `SEK/NOK 0,9604` i stedet for `96,04`, og `DKK/NOK 1,4481` i stedet for `144,81`.
- Valutaendringen i prosent påvirkes ikke av normaliseringen.
- SEK/NOK og DKK/NOK vises med fire desimaler, lik de øvrige valutaparene.

## Test etter deploy

1. Logg inn på `/redaksjon`.
2. Åpne **Kilder & automatikk**.
3. Trykk **Oppdater alt nå**.
4. Åpne forsiden og kontroller at SEK/NOK, DKK/NOK og CHF/NOK vises per 1 valutaenhet.

Ingen databaseendring er nødvendig. Neste synk overskriver de eksisterende markedsverdiene med normaliserte verdier.
