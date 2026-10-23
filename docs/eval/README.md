# Eval-resultater

Første kjøringer av kvalitetsvakten mot ekte modell, 21. oktober 2026. `claude-opus-5-5` med effort low som agent, simulator og dommer. Hver kjøring er 8 scenarier × 3 forsøk (`npm run eval -- --gjentak 3`).

| Kjøring | Kode | Bestått | Svartid p50 | p95 | Første tekst p50 |
|---|---|---|---|---|---|
| 1 | før rettelser | 16/24 | 2,9 s | 7,1 s | 2,0 s |
| 2 | rettelser runde 1 | 22/24 | 3,1 s | 6,1 s | 1,9 s |
| 3 | + scenario 07 endret | 19/24 | 2,7 s | 5,4 s | 1,8 s |
| 4 | endelig kode | 24/24 | 2,5 s | 5,8 s | 1,7 s |

Fullstendige rapporter med alle samtaler, sjekker og dommervurderinger:
[før rettelser](2026-10-21-for-rettelser.json) og [etter rettelser](2026-10-21-etter-rettelser.json).

## Hva som ble funnet og rettet

I agenten:
- Den tenkte høyt på engelsk i teksten som skulle leses opp.
- Den skrev markdown (fet skrift). Turene lagres nå slik de blir sagt.
- Den henviste pustevansker til legevakten i stedet for 113.
- Den tilbød oppslag på en annen voksens nummer mot fullt navn. Nå avslår den.
- Den lot en booking ligge når innringeren sa «ja, ha det» i samme replikk.

I testoppsettet:
- Dommeren så bare de første 200 tegnene av verktøyresultatet, og trodde derfor at agenten diktet opp tider som sto lenger ned i lista.
- Innringerens siste replikk før den la på ble aldri sendt til agenten.
- Scenario 07 (medisinsk råd) forbød all booking. Agenten henviste til legevakten og booket akutttime etter et tydelig ja, som er riktig. Forventningen ble endret til at 113 og legevakt må nevnes, og booking er tillatt. Det gjør scenarioet mildere på ett punkt.

## Forbehold

- Bare én kjøring på endelig kode. Mellom kjøringene varierte resultatet fra 19 til 24, så LLM-støy er stor med 3 forsøk per scenario.
- Samme modell er agent, innringer og dommer. En annen dommermodell ville gitt et mer uavhengig mål.
- Svartid per tur er for høy for telefon. Første tekst kommer etter ca. 1,7 s, og talesyntesen kan starte da, men p95 for hele turen er rundt 5–6 s.
- Kost for agentdelen er ca. 0,05 USD per samtale (4–5 agentturer, Opus 5.5 med prompt caching), regnet fra tokenbruken i siste kjøring.
