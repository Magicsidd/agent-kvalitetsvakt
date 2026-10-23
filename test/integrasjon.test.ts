import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { startLegacyServer, type LegacyHandle } from "../src/integrasjon/legacyServer.ts";
import { BookingAdapter, BookingFeil, normaliserTelefon } from "../src/integrasjon/bookingAdapter.ts";

// Onsdag 21. oktober 2026 kl. 09:00, klinikktid.
const naa = () => new Date("2026-10-21T09:00:00Z");
let legacy: LegacyHandle;

before(async () => {
  legacy = await startLegacyServer(0, { seed: 7, now: naa });
});
after(() => legacy.close());

test("normaliserer norske telefonnumre", () => {
  assert.equal(normaliserTelefon("+47 405 39 105"), "40539105");
  assert.equal(normaliserTelefon("0047 40539105"), "40539105");
  assert.equal(normaliserTelefon("405 39 105"), "40539105");
  assert.throws(() => normaliserTelefon("12345"), BookingFeil);
});

test("finner ledige tider, aldri i fortiden og aldri i helgen", async () => {
  const a = new BookingAdapter({ baseUrl: legacy.url, now: naa });
  const tider = await a.finnLedigeTider({ behandling: "undersokelse", fraDato: "2026-10-20", maks: 30 });
  assert.ok(tider.length > 0);
  for (const t of tider) {
    assert.ok(t.start > "2026-10-21T09:00", `${t.start} er i fortiden`);
    const dag = new Date(`${t.start}:00Z`).getUTCDay();
    assert.ok(dag !== 0 && dag !== 6, `${t.start} er i helgen`);
  }
});

test("akutt får bare de reserverte akutttidene", async () => {
  const a = new BookingAdapter({ baseUrl: legacy.url, now: naa });
  const tider = await a.finnLedigeTider({ behandling: "akutt", fraDato: "2026-10-22", maks: 20 });
  for (const t of tider) assert.ok(["08:00", "13:00"].includes(t.start.slice(11)), t.start);
});

test("booker, finner og avbestiller, og stopper sletting på feil nummer", async () => {
  legacy.reset(7);
  const a = new BookingAdapter({ baseUrl: legacy.url, now: naa });
  const [ledig] = await a.finnLedigeTider({ behandling: "tannrens", fraDato: "2026-10-22" });
  const b = await a.book({ behandling: "tannrens", start: ledig!.start, navn: "Kari Nordmann", telefon: "+47 911 22 333" });
  assert.deepEqual((await a.finnBestillinger("91122333")).map((x) => x.id), [b.id]);

  await assert.rejects(a.avbestill({ id: b.id, telefon: "40000000" }), (e: BookingFeil) => e.kode === "FINNES_IKKE");
  assert.equal(legacy.state.bookings.size, 1);

  await a.avbestill({ id: b.id, telefon: "91122333" });
  assert.equal(legacy.state.bookings.size, 0);
});

test("dobbeltbooking av samme tid gir OPPTATT", async () => {
  legacy.reset(7);
  const a = new BookingAdapter({ baseUrl: legacy.url, now: naa });
  const [ledig] = await a.finnLedigeTider({ behandling: "undersokelse", fraDato: "2026-10-22" });
  await a.book({ behandling: "undersokelse", start: ledig!.start, navn: "Ola", telefon: "40000001" });
  await assert.rejects(
    a.book({ behandling: "undersokelse", start: ledig!.start, navn: "Per", telefon: "40000002" }),
    (e: BookingFeil) => e.kode === "OPPTATT",
  );
});

test("mistet svar etter lagring gir ikke dobbel booking", async () => {
  const ustabil = await startLegacyServer(0, { seed: 3, now: naa, lostResponseRate: 1 });
  try {
    const a = new BookingAdapter({ baseUrl: ustabil.url, now: naa, timeoutMs: 300 });
    const [ledig] = await a.finnLedigeTider({ behandling: "undersokelse", fraDato: "2026-10-22" });
    const b = await a.book({ behandling: "undersokelse", start: ledig!.start, navn: "Kari", telefon: "40000003" });
    assert.equal(ustabil.state.bookings.size, 1);
    assert.equal(b.id, [...ustabil.state.bookings.keys()][0]!.toString());
  } finally {
    await ustabil.close();
  }
});

test("lesekall prøver igjen ved 503", async () => {
  const ustabil = await startLegacyServer(0, { seed: 11, now: naa, failFirst: 2 });
  try {
    const hendelser: string[] = [];
    const a = new BookingAdapter({ baseUrl: ustabil.url, now: naa,  onHendelse: (h) => hendelser.push(h.type) });
    const tider = await a.finnLedigeTider({ behandling: "undersokelse", fraDato: "2026-10-22", maks: 3 });
    assert.equal(tider.length, 3);
    assert.ok(hendelser.includes("nytt_forsok"));
  } finally {
    await ustabil.close();
  }
});
