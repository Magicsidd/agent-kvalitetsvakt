# Agent-kvalitetsvakt

Verktøyene rundt en norsk AI-telefonagent: det som gjør at en bedrift tør å slå den på, og at selgeren får kunder ut av demoen. Agenten her er bare et testobjekt. Stemme og telefoni hører hjemme i en plattform som Vapi eller LiveKit.

- **Kvalitetsvakt.** Claude spiller vanskelige innringere mot agenten. Hver samtale sjekkes automatisk mot fagsystemet og vurderes av en LLM-dommer, og du kan sammenligne før og etter en endring i prompt eller modell.
- **Kvalitetsrapport til kunden.** Én side som lages automatisk fra testene: hva agenten løste, hva som er sjekket og hva som justeres neste uke. Kan sendes før lansering og hver uke etterpå. [Eksempel (PDF)](docs/kvalitetsrapport.pdf).
- **Demo 2.0.** En bedrift limer inn nettadressen sin og tester agenten. Etter samtalen ser de oppsummeringen og hva som mangler i kunnskapsbasen, og kan booke en gjennomgang.
- **Leads til selgeren.** Den som booker, havner i dashbordet med samtalen, det de spurte om og det agenten ikke kunne svare på.
- **Live overvåking og oppsummering.** Pågående samtaler med risikoflagg, «hvisk» fra en ansatt midt i samtalen, og oppsummering med SMS-forslag etter hver samtale.
- **Compliance.** Agenten sier at den er en KI og verifiserer innringeren før den gir ut bookinger. Fødselsnumre maskeres i loggen, og utgående salgssamtaler sjekkes mot lovlige ringetider og helligdager.

Skrevet i TypeScript med Claude API. Prosjektet har 42 tester, og CI kjører typesjekk og tester på hver push.

Siste kjøring av kvalitetsvakten: 24 av 24 testsamtaler bestått (8 scenarier, 3 forsøk hver). Alle kjøringer, hva som ble rettet underveis og forbehold står i [docs/eval](docs/eval/README.md).

![Live overvåking med risikoflagg](docs/skjermbilder/live-overvaking.png)

Video, to minutter: [docs/demo.mp4](docs/demo.mp4)

## Kom i gang

```bash
npm install
cp .env.example .env          # legg inn ANTHROPIC_API_KEY
npm start                     # http://localhost:3000 og /dashbord
```

Bruk Chrome eller Edge for norsk talegjenkjenning i nettleseren. Du kan også skrive i stedet for å snakke.

```bash
npm test                      # 42 tester, ingen API-nøkkel trengs
npm run typecheck
npm run eval                  # kvalitetsvakt: 8 scenarier mot ekte modell
npm run eval -- --gjentak 3   # hvert scenario tre ganger (modeller er ikke deterministiske)
npm run eval -- --ustabil     # bookingsystemet feiler og mister svar underveis
npm run nettlesertest         # røyktest av frontenden i Chromium (CHROMIUM_PATH=...)
npm run rapport               # kvalitetsrapport som HTML og PDF fra en eval-kjøring
```

## Arkitektur

```mermaid
flowchart LR
  subgraph Klient
    N[Nettleser<br/>tale inn/ut]
    V[Vapi<br/>telefoni]
    D[Dashbord]
  end
  subgraph Server
    WS[/ws og /vapi/]
    S[Samtale<br/>verktøyløkke]
    P[Profil<br/>prompt + verktøy]
    R[Risikoflagg]
    O[Oppsummering]
    L[(Samtalelogg<br/>maskert)]
  end
  subgraph Integrasjoner
    A[Booking-adapter]
    LS[Legacy-system]
    K[Kunnskapsbase<br/>BM25]
    H[Trygg henting<br/>nettside]
  end
  N --> WS
  V --> WS
  WS --> S
  P --> S
  S -->|Claude API| C((Claude))
  S --> A --> LS
  S --> K
  H --> K
  S --> R --> D
  S --> L --> O
  D -->|hvisk| S
```

| Mappe | Innhold |
|---|---|
| `src/agent/` | Samtaleløkken, profiler (prompt, hilsen, verktøy) og verktøyene med strenge skjemaer |
| `src/integrasjon/` | Det simulerte fagsystemet og adapteren som temmer det |
| `src/kunnskap/`, `src/nettside/` | Kunnskapssøk, og nettside til kunnskapsbase med SSRF-vern |
| `src/eval/` | Scenarier, simulert innringer, deterministiske sjekker og LLM-dommer |
| `src/innsikt/`, `src/compliance/` | Oppsummering, kvalitetsrapport, leads, risikoflagg, maskering, ringetider og helligdager |
| `src/server/` | HTTP, WebSocket, Vapi-endepunkt, logg og ratebegrensning |

## Designvalg

**Egen verktøyløkke i stedet for SDK-ens tool runner.** Løkken måler modell og verktøy hver for seg, strømmer tekst til talesyntesen mens modellen skriver, og stopper med en gang agenten setter over. Hele svaret, også tenkeblokkene, går uendret tilbake i historikken. Alle verktøyresultater fra én runde sendes i én melding, så modellen fortsetter å kalle verktøy parallelt.

**Verktøy med to lag skjema.** Modellen får strenge JSON-skjemaer (`strict: true`), og hver input valideres i tillegg med Zod før noe kjøres. En feilformet booking når aldri fagsystemet. Profilen bestemmer hvilke verktøy agenten har, og serveren avviser alt annet, også om modellen prøver.

**Fagsystemet er fiendtlig, adapteren er vennlig.** Se [docs/legacy-api.md](docs/legacy-api.md). Feil som tekst blir til typede feil. Lesekall prøves på nytt, mens booking aldri gjentas blindt: adapteren sjekker først om et mistet svar faktisk ble lagret. Sletting krever eierskap, selv om fagsystemet ikke gjør det.

**Latens er en funksjon.** Hilsenen er fast tekst, så første replikk ikke venter på modellen. Den stabile delen av systemprompten caches, og dato og nummervisning ligger etter cache-grensen. Effort står på `low` for samtalen. Svaret leses opp setning for setning mens det skrives, og tekst før et verktøykall («jeg skal sjekke») blir naturlig fyll. Hver tur logger tid til første ord, modelltid og verktøytid.

**Kvalitetsvakten tester det som teller.** Sjekkene ser på fagsystemet etter samtalen (ble riktig time booket, på riktig nummer, uten dobbeltbooking?), ikke bare på teksten. De fanger også klokkeslett agenten nevner som ikke kom fra et verktøy, booking uten bekreftelse, manglende KI-opplysning, lekkasje av andre pasienters data og markdown som ville blitt lest høyt. Klokka er fast i evalueringen, så «neste uke» betyr det samme hver gang. LLM-dommeren vurderer bare det som ikke kan måles mekanisk, og foreslår én konkret forbedring per samtale.

**Hvisk går i systemkanalen.** En instruks fra en ansatt sendes som systemmelding midt i samtalen, ikke som brukertekst. Den får riktig autoritet, bryter ikke prompt-cachen, og innringeren kan ikke etterligne den.

**Tekst fra nettsider er data, ikke instrukser.** Nettsideagenten får sidens innhold inn som avgrenset data, og prompten sier eksplisitt at instrukser der skal ignoreres.

## Sikkerhet

| Trussel | Tiltak | Hvor |
|---|---|---|
| SSRF via «lim inn nettadresse» | Bare http/https og port 80/443, ingen brukernavn eller passord i URL-en, alle DNS-svar sjekkes, tilkoblingen låses til sjekket IP (ingen DNS rebinding), hver omdirigering sjekkes på nytt, tidsavbrudd, størrelsesgrense, bare HTML | `src/nettside/trygHent.ts` |
| Misbruk og kostnad | Ratebegrensning per IP på samtaler, nettsideagent og oppsummering, Vapi-endepunktet lukket uten delt hemmelighet, grenser på body og WebSocket | `src/server/` |
| XSS | Håndhevet CSP uten `unsafe-inline`, all tekst settes med `textContent` | `src/server/main.ts`, `public/` |
| Clickjacking, sniffing, lekkasje | `frame-ancestors 'none'`, `nosniff`, `no-referrer`, `Permissions-Policy`, ingen `x-powered-by` | `src/server/main.ts` |
| Utlevering av andres data | Oppslag på et annet nummer enn det det ringes fra krever fullt navn. Sletting krever eierskap | `src/agent/verktoy.ts` |
| Personopplysninger i logg | Gyldige fødselsnumre (mod 11) maskeres før noe skrives til disk | `src/innsikt/risiko.ts` |
| Promptinjeksjon | Avvises i prompten, flagges live og testes i et eget scenario | `src/eval/scenarier/08-*.json` |
| Åpent dashbord | Valgfritt `DASHBORD_TOKEN` for API og live-strøm | `src/server/main.ts` |
| Hemmeligheter | Bare i `.env` (ignorert av git), aldri i frontend | `.env.example` |

## Vapi

Pek en Vapi-assistent sin «Custom LLM»-URL til `https://<din-server>/vapi`, og sett `VAPI_SECRET` på begge sider. Uten `VAPI_SECRET` er endepunktet lukket. Vapi tar seg av telefoni, tale til tekst og talesyntese. Agenten her svarer i OpenAI-format med strømming, så Vapi kan begynne å snakke før svaret er ferdig. Endepunktet følger Vapis dokumenterte format, men er ikke testet mot en ekte Vapi-konto i dette repoet.

## Begrensninger og neste steg

- Nettleserens tale (Web Speech API) varierer mye i kvalitet. I drift brukes Vapi eller LiveKit med en god norsk stemme, avbrytbarhet (barge-in) og ekte telefoni.
- Verifiseringen er enkel (nummervisning eller fullt navn). Neste steg er BankID midt i samtalen.
- Samtaler og evalueringer lagres som JSON-filer. I drift hører de hjemme i Postgres med EU-hosting, og med lagringstid styrt av databehandleravtalen.
- Kunnskapssøket er BM25. Det holder for små kunnskapsbaser, mens store bør over på embeddings bak samme grensesnitt.

## Lisens

MIT. Klinikken og alle personer i scenariene er oppdiktet.
