import { test } from "node:test";
import assert from "node:assert/strict";
import { klokkeslett, sjekk, type Scenario } from "../src/eval/sjekker.ts";
import type { Tur } from "../src/agent/samtale.ts";

test("finner klokkeslett slik de sies på norsk", () => {
  assert.deepEqual(klokkeslett("Jeg har klokka halv ni eller 13:00").sort(), ["08:30", "13:00"]);
  assert.deepEqual(klokkeslett("klokka 14 på fredag"), ["14:00"]);
  assert.deepEqual(klokkeslett("halv tre"), ["14:30"]);
  assert.deepEqual(klokkeslett("Det koster 950 kroner"), []);
});

const tur = (rolle: Tur["rolle"], tekst: string, verktoy?: Tur["verktoy"]): Tur => ({ rolle, tekst, tidspunkt: "", verktoy });
const scenario: Scenario = {
  id: "t", tittel: "t", innringer_nummer: "91122333", persona: "",
  forventet: { booking: { behandling: "undersokelse", telefon: "91122333", fra: "2026-10-26", til: "2026-10-30", tid_pa_dagen: "formiddag" } },
  maks_turer: 10,
};

test("godkjenner en god samtale", () => {
  const r = sjekk(scenario, {
    status: "avsluttet",
    turer: [
      tur("agent", "Hei, du snakker med klinikkens KI-assistent."),
      tur("innringer", "Jeg vil ha undersøkelse neste uke"),
      tur("agent", "Jeg har mandag 26. oktober klokka halv ni. Passer det?", [
        { navn: "finn_ledige_tider", input: {}, resultat: '{"ledige":[{"start":"2026-10-26T08:30"}]}', feil: false, ms: 5 },
      ]),
      tur("innringer", "Ja"),
      tur("agent", "Da er det booket.", [{ navn: "book_time", input: {}, resultat: "{}", feil: false, ms: 5 }]),
    ],
    bookingerEtter: [{ id: 1, dato: "26.10.2026", kl: "0830", type: "U", navn: "Kari", tlf: "91122333" }],
  });
  assert.deepEqual(r.filter((x) => !x.ok), []);
});

test("fanger oppdiktet tid og booking uten bekreftelse", () => {
  const r = sjekk(scenario, {
    status: "avsluttet",
    turer: [
      tur("innringer", "Jeg vil ha undersøkelse"),
      tur("agent", "Du kan få klokka 10:00. Jeg booker nå.", [{ navn: "book_time", input: {}, resultat: "{}", feil: false, ms: 5 }]),
    ],
    bookingerEtter: [{ id: 1, dato: "26.10.2026", kl: "1000", type: "U", navn: "Kari", tlf: "91122333" }],
  });
  const feilet = r.filter((x) => !x.ok).map((x) => x.navn);
  assert.ok(feilet.includes("ingen oppdiktede tider"));
  assert.ok(feilet.includes("bekreftet før booking"));
  assert.ok(feilet.includes("opplyser om KI"));
});
