# Bookingsystemet (simulert legacy)

`src/integrasjon/legacyServer.ts` later som et gammelt fagsystem for en tannklinikk. Det er bevisst klønete, slik mange fagsystemer AI-agenter må snakke med faktisk er. Dette er det «vi fant ut» om API-et, og hvordan adapteren (`src/integrasjon/bookingAdapter.ts`) håndterer det.

| Endepunkt | Hva det gjør | Overraskelser |
|---|---|---|
| `GET /cgi-bin/ledig.pl?dato=dd.mm.yyyy&type=U` | Ledige tider én dag | Svarer `OK\n0800,0830`. Typekoder: U undersøkelse, R tannrens, A akutt, F fylling (to tider). Akutt har egne reserverte tider. |
| `POST /cgi-bin/bestill.pl` (form) | Booker | Svarer `OK 48213` eller `ERR 22 Opptatt`, alltid HTTP 200. Kan lagre bookingen og så miste svaret. |
| `GET /cgi-bin/finn.pl?tlf=40539105` | Bookinger på et nummer | Krever nøyaktig åtte siffer uten mellomrom eller +47. |
| `GET /cgi-bin/slett.pl?id=48213` | Sletter | Sletting med GET. Ingen eierskapssjekk: hvem som helst kan slette hvilken som helst id. |

Alle endepunkter kan svare 503 innimellom.

## Hvordan adapteren takler det

- **Feil som tekst i body** (`ERR <kode>`) blir til typede `BookingFeil` med en kode agenten kan handle på (`OPPTATT`, `PASSERT`, `UGYLDIG`, `FINNES_IKKE`, `UTILGJENGELIG`).
- **Lesekall** prøves på nytt ved 503 og tidsavbrudd, med økende pause.
- **Booking er ikke trygg å gjenta blindt.** Før hvert nytt forsøk slår adapteren opp om bookingen allerede finnes, så et mistet svar aldri gir dobbeltbooking. Testet i `test/integrasjon.test.ts`.
- **Sletting** krever at bookingen tilhører nummeret innringeren har oppgitt, selv om legacy ikke sjekker det. Er det ikke nummeret det ringes fra, må fullt navn stemme (`src/agent/verktoy.ts`). I produksjon er dette stedet for BankID.
- **Telefonnummer** normaliseres (`+47 405 39 105` → `40539105`) før det sendes.
- **Tid og dato** oversettes mellom `dd.mm.yyyy`/`HHMM` og ISO, og agenten får en ferdig setning å lese opp («torsdag 22. oktober kl. 08:30»).

Kjør `npm run eval -- --ustabil` for å se agenten jobbe mot et system som feiler og mister svar.
