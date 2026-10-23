/**
 * Kjører alle scenarier: simulert innringer mot agenten, med et eget
 * bookingsystem per samtale og fast klokke, så resultatene kan sammenlignes
 * mellom kjøringer.
 *
 *   npm run eval                       alle scenarier én gang
 *   npm run eval -- --gjentak 3        hver tre ganger (LLM-er er ikke deterministiske)
 *   npm run eval -- --scenario akutt   bare scenarier med «akutt» i id-en
 *   npm run eval -- --ustabil          bookingsystemet feiler og mister svar
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { Samtale, anthropicKlient, type Tur } from "../agent/samtale.ts";
import { startLegacyServer } from "../integrasjon/legacyServer.ts";
import { Kunnskapsbase } from "../kunnskap/sok.ts";
import { InnringerSimulator, LEGGER_PA } from "./simulator.ts";
import { vurder, type Vurdering } from "./dommer.ts";
import { lastScenarier, persentil, sjekk, type Scenario, type SjekkResultat } from "./sjekker.ts";

// Onsdag 21. oktober 2026 kl. 09:00. Fast, så «neste uke» betyr det samme hver gang.
const EVAL_NAA = () => new Date("2026-10-21T09:00:00Z");

export interface EvalResultat {
  scenario: string;
  tittel: string;
  forsok: number;
  status: string;
  turer: Tur[];
  sjekker: SjekkResultat[];
  vurdering: Vurdering | null;
  bestod: boolean;
  feil?: string;
}

async function kjorEn(s: Scenario, forsok: number, opts: { ustabil: boolean }, client: Anthropic, kb: Kunnskapsbase): Promise<EvalResultat> {
  const legacy = await startLegacyServer(0, {
    seed: 42,
    now: EVAL_NAA,
    seedBookings: s.seedBookings,
    flakyRate: opts.ustabil ? 0.15 : 0,
    lostResponseRate: opts.ustabil ? 0.3 : 0,
  });
  const samtale = new Samtale({
    llm: anthropicKlient(client),
    legacyUrl: legacy.url,
    kb,
    now: EVAL_NAA,
    innringerNummer: s.innringer_nummer ?? undefined,
    id: `eval-${s.id}-${forsok}`,
  });
  const sim = new InnringerSimulator(s.persona, client);
  let feil: string | undefined;

  try {
    samtale.hilsen();
    for (let i = 0; i < s.maks_turer && samtale.status === "aktiv"; i++) {
      const replikk = await sim.neste(samtale.turer);
      const ren = replikk.replace(LEGGER_PA, "").trim();
      if (replikk.includes(LEGGER_PA)) {
        // «Ja, det stemmer, ha det» i én replikk: agenten hører de siste ordene
        // før linja brytes, og skal fortsatt booke på ja-et.
        if (ren) await samtale.svar(ren);
        break;
      }
      await samtale.svar(ren);
    }
  } catch (e) {
    feil = e instanceof Error ? e.message : String(e);
  }

  const sjekker = sjekk(s, { turer: samtale.turer, status: samtale.status, bookingerEtter: [...legacy.state.bookings.values()] });
  await legacy.close();
  const vurdering = feil ? null : await vurder(s, samtale.turer, client).catch(() => null);
  const bestod = !feil && sjekker.every((x) => x.ok) && (!vurdering || (vurdering.oppgave_lost >= 4 && vurdering.sikkerhet >= 4));
  return { scenario: s.id, tittel: s.tittel, forsok, status: samtale.status, turer: samtale.turer, sjekker, vurdering, bestod, feil };
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string" },
      gjentak: { type: "string", default: "1" },
      parallell: { type: "string", default: "4" },
      ustabil: { type: "boolean", default: false },
    },
  });
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error("Mangler ANTHROPIC_API_KEY. Kopier .env.example til .env og fyll inn.");
    process.exit(1);
  }

  const scenarier = lastScenarier(values.scenario);
  const gjentak = Number(values.gjentak);
  const jobber = scenarier.flatMap((s) => Array.from({ length: gjentak }, (_, i) => ({ s, forsok: i + 1 })));
  const client = new Anthropic();
  const kb = Kunnskapsbase.fraFil();
  const resultater: EvalResultat[] = [];

  console.log(`Kjører ${jobber.length} samtaler (${scenarier.length} scenarier × ${gjentak}) med ${config.model}, effort ${config.effort}${values.ustabil ? ", ustabilt bookingsystem" : ""}\n`);
  const ko = [...jobber];
  await Promise.all(
    Array.from({ length: Number(values.parallell) }, async () => {
      for (let jobb = ko.shift(); jobb; jobb = ko.shift()) {
        const r = await kjorEn(jobb.s, jobb.forsok, { ustabil: values.ustabil! }, client, kb);
        resultater.push(r);
        const feilede = r.sjekker.filter((x) => !x.ok).map((x) => `${x.navn}${x.detalj ? ` (${x.detalj})` : ""}`);
        const v = r.vurdering;
        console.log(
          `${r.bestod ? "✓" : "✗"} ${r.scenario.padEnd(22)} #${r.forsok}  ${String(r.turer.length).padStart(2)} turer` +
            (v ? `  dommer ${v.oppgave_lost}/${v.naturlig_norsk}/${v.effektivitet}/${v.sikkerhet}` : "") +
            (r.feil ? `  FEIL: ${r.feil}` : "") +
            (feilede.length ? `\n    ${feilede.join("\n    ")}` : ""),
        );
      }
    }),
  );

  const latens = resultater.flatMap((r) => r.turer.flatMap((t) => (t.maling ? [t.maling.totalMs] : [])));
  const forsteLyd = resultater.flatMap((r) => r.turer.flatMap((t) => (t.maling?.forsteTekstMs ? [t.maling.forsteTekstMs] : [])));
  const forbruk = resultater.flatMap((r) => r.turer.map((t) => t.forbruk)).filter(Boolean);
  const oppsummering = {
    bestatt: resultater.filter((r) => r.bestod).length,
    totalt: resultater.length,
    latens_p50_ms: persentil(latens, 50),
    latens_p95_ms: persentil(latens, 95),
    forste_tekst_p50_ms: persentil(forsteLyd, 50),
    tokens_inn: forbruk.reduce((s, f) => s + f!.input, 0),
    tokens_ut: forbruk.reduce((s, f) => s + f!.output, 0),
    tokens_cache_lest: forbruk.reduce((s, f) => s + f!.cacheLest, 0),
  };

  console.log(
    `\n${oppsummering.bestatt}/${oppsummering.totalt} bestått.  Svartid p50 ${oppsummering.latens_p50_ms} ms, p95 ${oppsummering.latens_p95_ms} ms.` +
      `  Første tekst p50 ${oppsummering.forste_tekst_p50_ms} ms.`,
  );

  mkdirSync(`${config.dataDir}/evals`, { recursive: true });
  const fil = `${config.dataDir}/evals/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(
    fil,
    JSON.stringify({ kjort: new Date().toISOString(), modell: config.model, effort: config.effort, ustabil: values.ustabil, oppsummering, resultater }, null, 2),
  );
  console.log(`Lagret ${fil}. Se dashbordet: npm start, så http://localhost:${config.port}/dashbord`);
  process.exit(oppsummering.bestatt === oppsummering.totalt ? 0 : 1);
}

main();
