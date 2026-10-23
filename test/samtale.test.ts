import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { Samtale, tilTale, type LlmKlient } from "../src/agent/samtale.ts";
import { startLegacyServer, type LegacyHandle } from "../src/integrasjon/legacyServer.ts";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
const naa = () => new Date("2026-10-21T09:00:00Z");
let legacy: LegacyHandle;
before(async () => (legacy = await startLegacyServer(0, { seed: 7, now: naa })));
after(() => legacy.close());

function melding(content: unknown[], stop_reason: string): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "test", content, stop_reason,
    stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

/** Spiller av ferdige svar og husker hva den fikk. */
function skriptetLlm(svar: Anthropic.Beta.BetaMessage[]) {
  const kall: Params[] = [];
  const llm: LlmKlient = {
    async lag(params, onTekst) {
      kall.push(structuredClone(params));
      const m = svar.shift();
      if (!m) throw new Error("Tom for svar");
      for (const b of m.content) if (b.type === "text") onTekst?.(b.text);
      return m;
    },
  };
  return { llm, kall };
}

test("kjører verktøy og sender resultatet tilbake med riktig id", async () => {
  const { llm, kall } = skriptetLlm([
    melding([{ type: "tool_use", id: "tu_1", name: "finn_ledige_tider",
      input: { behandling: "tannrens", fra_dato: "2026-10-22", tid_pa_dagen: "hele_dagen" } }], "tool_use"),
    melding([{ type: "text", text: "Jeg har ledig torsdag. Passer det?" }], "end_turn"),
  ]);
  const s = new Samtale({ llm, legacyUrl: legacy.url, now: naa });
  s.hilsen();
  const tur = await s.svar("Jeg vil bestille tannrens");

  assert.equal(tur.tekst, "Jeg har ledig torsdag. Passer det?");
  assert.equal(tur.verktoy?.[0]?.navn, "finn_ledige_tider");
  assert.equal(tur.verktoy?.[0]?.feil, false);
  assert.equal(tur.maling?.runder, 2);

  const andre = kall[1]!.messages;
  const resultat = andre.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
  assert.equal(resultat[0]!.tool_use_id, "tu_1");
  assert.match(String(resultat[0]!.content), /si_det_slik/);
  // Hilsenen er med i første brukermelding, så modellen ikke hilser på nytt.
  assert.match(String(andre[0]!.content), /Nordstjerna/);
});

test("ugyldig verktøyinput når aldri bookingsystemet", async () => {
  const { llm } = skriptetLlm([
    melding([{ type: "tool_use", id: "tu_1", name: "book_time",
      input: { behandling: "tannrens", start: "i morgen", navn: "K", telefon: "1" } }], "tool_use"),
    melding([{ type: "text", text: "Beklager, kan du gjenta?" }], "end_turn"),
  ]);
  legacy.reset(7);
  const s = new Samtale({ llm, legacyUrl: legacy.url, now: naa });
  const tur = await s.svar("Book meg inn");
  assert.equal(tur.verktoy?.[0]?.feil, true);
  assert.equal(legacy.state.bookings.size, 0);
});

test("overføring stopper løkken og lagrer notatet", async () => {
  const { llm, kall } = skriptetLlm([
    melding([
      { type: "text", text: "Jeg setter deg over nå." },
      { type: "tool_use", id: "tu_1", name: "sett_over_til_ansatt",
        input: { grunn: "ber om menneske", oppsummering: "Vil klage på regning" } },
    ], "tool_use"),
  ]);
  const s = new Samtale({ llm, legacyUrl: legacy.url, now: naa });
  const tur = await s.svar("Jeg vil snakke med et menneske");
  assert.equal(s.status, "overfort");
  assert.equal(s.overforingsnotat, "Vil klage på regning");
  assert.equal(kall.length, 1);
  assert.equal(tur.tekst, "Jeg setter deg over nå.");
  await assert.rejects(s.svar("Hallo?"));
});

test("avvisning gir et trygt svar i stedet for tom tekst", async () => {
  const { llm } = skriptetLlm([melding([], "refusal")]);
  const s = new Samtale({ llm, legacyUrl: legacy.url, now: naa });
  const tur = await s.svar("...");
  assert.match(tur.tekst, /sette deg over/);
});

test("tilTale fjerner markdown", () => {
  assert.equal(tilTale("**Hei!**\n- torsdag\n- fredag"), "Hei! torsdag fredag");
});

test("oppslag på andres nummer krever riktig fullt navn", async () => {
  legacy.reset(7, [{ dato: "27.10.2026", kl: "1030", type: "R", navn: "Lise Berg", tlf: "92233444" }]);
  const sporring = (navn: string) =>
    melding([{ type: "tool_use", id: "tu_1", name: "finn_bestillinger", input: { telefon: "922 33 444", navn } }], "tool_use");
  const ferdig = melding([{ type: "text", text: "ok" }], "end_turn");

  const { llm } = skriptetLlm([sporring(""), ferdig, sporring("Lise Berg"), ferdig]);
  const s = new Samtale({ llm, legacyUrl: legacy.url, now: naa, innringerNummer: "900 00 001" });
  const uten = await s.svar("Slå opp 922 33 444");
  assert.match(uten.verktoy![0]!.resultat, /"bestillinger":\[\]/);
  const med = await s.svar("Hun heter Lise Berg");
  assert.match(med.verktoy![0]!.resultat, /Lise Berg/);

  const eier = skriptetLlm([sporring(""), ferdig]);
  const s2 = new Samtale({ llm: eier.llm, legacyUrl: legacy.url, now: naa, innringerNummer: "+4792233444" });
  assert.match((await s2.svar("Hvilke timer har jeg?")).verktoy![0]!.resultat, /Lise Berg/);
});

test("nettsideprofil får ikke bruke bookingverktøy, og lagrer beskjed", async () => {
  const { nettsideProfil } = await import("../src/agent/prompt.ts");
  const { llm, kall } = skriptetLlm([
    melding([
      { type: "tool_use", id: "tu_1", name: "book_time", input: { behandling: "tannrens", start: "2026-10-22T10:00", navn: "Kari", telefon: "91122333" } },
      { type: "tool_use", id: "tu_2", name: "ta_imot_beskjed", input: { navn: "Kari Nordmann", telefon: "+47 911 22 333", beskjed: "Vil ha tilbud" } },
    ], "tool_use"),
    melding([{ type: "text", text: "Beskjeden er lagret." }], "end_turn"),
  ]);
  const s = new Samtale({ llm, profil: nettsideProfil("Eksempel AS", "Vi selger sykler"), now: naa });
  assert.match(s.hilsen().tekst, /KI-assistent/);
  const tur = await s.svar("Jeg vil ha tilbud");
  assert.equal(tur.verktoy!.find((v) => v.navn === "book_time")!.feil, true);
  assert.deepEqual(s.beskjeder, [{ navn: "Kari Nordmann", telefon: "91122333", beskjed: "Vil ha tilbud" }]);
  const verktoyNavn = (kall[0]!.tools ?? []).map((t) => (t as { name: string }).name);
  assert.ok(!verktoyNavn.includes("book_time"));
});

test("hvisk fra veileder går som systemmelding rett etter brukermeldingen", async () => {
  const { llm, kall } = skriptetLlm([
    melding([{ type: "text", text: "Hei!" }], "end_turn"),
    melding([{ type: "text", text: "Jeg kan tilby 10 prosent rabatt." }], "end_turn"),
  ]);
  const s = new Samtale({ llm, legacyUrl: legacy.url, now: naa });
  await s.svar("Hei");
  s.hvisk("Tilby 10 prosent rabatt på tannrens");
  await s.svar("Det er dyrt");
  const meldinger = kall[1]!.messages;
  assert.equal(meldinger.at(-2)!.role, "user");
  assert.equal(meldinger.at(-1)!.role, "system");
  assert.match(String(meldinger.at(-1)!.content), /10 prosent/);
});
