/**
 * Simulert «legacy» bookingsystem for en tannklinikk.
 *
 * Det er bevisst klønete, slik fagsystemer ofte er i virkeligheten:
 * - feil returneres som HTTP 200 med «ERR <kode> <tekst>» i body
 * - datoer er dd.mm.yyyy, klokkeslett HHMM, tjenester har énbokstavskoder
 * - sletting skjer med GET
 * - det svarer av og til 503, og kan miste svaret etter at en booking er lagret
 *
 * Se docs/legacy-api.md for det vi «fant ut» om API-et.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { osloNaa } from "../tid.ts";

export type Tjenestekode = "U" | "R" | "A" | "F";

export interface LegacyBooking {
  id: number;
  dato: string; // dd.mm.yyyy
  kl: string; // HHMM
  type: Tjenestekode;
  navn: string;
  tlf: string; // 8 siffer
}

export interface LegacyOptions {
  seed?: number;
  /** Andel kall som får 503 (0–1). */
  flakyRate?: number;
  /** De første N kallene får 503 (for deterministiske tester). */
  failFirst?: number;
  /** Andel bookinger som lagres, men der svaret aldri kommer (0–1). */
  lostResponseRate?: number;
  /** Klokke, så tester og evalueringer er reproduserbare. */
  now?: () => Date;
  /** Bookinger som finnes fra start (f.eks. til avbestillingsscenarier). */
  seedBookings?: Omit<LegacyBooking, "id">[];
}

const SLOTS = [
  "0800", "0830", "0900", "0930", "1000", "1030", "1100",
  "1200", "1230", "1300", "1330", "1400", "1430", "1500", "1530",
];
/** Tider som holdes av til akutthjelp hver dag. */
const AKUTT_SLOTS = new Set(["0800", "1300"]);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function parseLegacyDato(dato: string): Date | null {
  const m = dato.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return d.getUTCDate() === Number(m[1]) ? d : null;
}

export class LegacyState {
  bookings = new Map<number, LegacyBooking>();
  private nextId = 48200;
  private seed: number;

  constructor(seed = 1, seedBookings: Omit<LegacyBooking, "id">[] = []) {
    this.seed = seed;
    for (const b of seedBookings) this.add(b);
  }

  add(b: Omit<LegacyBooking, "id">): LegacyBooking {
    const booking = { ...b, id: this.nextId++ };
    this.bookings.set(booking.id, booking);
    return booking;
  }

  /** Andre pasienter vi ikke ser: ca. 45 % av tidene er opptatt, deterministisk per dato. */
  private skjultOpptatt(dato: string, kl: string): boolean {
    return hash(`${this.seed}|${dato}|${kl}`) % 100 < 45;
  }

  erLedig(dato: string, kl: string): boolean {
    if (this.skjultOpptatt(dato, kl)) return false;
    for (const b of this.bookings.values()) {
      if (b.dato !== dato) continue;
      if (b.kl === kl) return false;
      // Fylling tar to tider.
      if (b.type === "F" && SLOTS[SLOTS.indexOf(b.kl) + 1] === kl) return false;
    }
    return true;
  }

  ledige(dato: string, type: Tjenestekode): string[] {
    const d = parseLegacyDato(dato)!;
    const dag = d.getUTCDay();
    if (dag === 0 || dag === 6) return [];
    return SLOTS.filter((kl, i) => {
      if (!this.erLedig(dato, kl)) return false;
      if (type === "A") return AKUTT_SLOTS.has(kl);
      if (AKUTT_SLOTS.has(kl)) return false;
      if (type === "F") {
        const neste = SLOTS[i + 1];
        // Fylling må ha neste tid ledig, og ikke krysse lunsj (1100 -> 1200).
        return !!neste && kl !== "1100" && this.erLedig(dato, neste) && !AKUTT_SLOTS.has(neste);
      }
      return true;
    });
  }
}

export interface LegacyHandle {
  url: string;
  state: LegacyState;
  close: () => Promise<void>;
  reset: (seed?: number, seedBookings?: Omit<LegacyBooking, "id">[]) => void;
}

export async function startLegacyServer(port = 0, opts: LegacyOptions = {}): Promise<LegacyHandle> {
  const now = opts.now ?? osloNaa;
  let state = new LegacyState(opts.seed ?? 1, opts.seedBookings);
  let rng = mulberry32(opts.seed ?? 1);
  let kallNr = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://legacy");
    const send = (body: string, status = 200) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    };

    if (kallNr++ < (opts.failFirst ?? 0) || (opts.flakyRate ?? 0) > rng()) return send("Service Unavailable", 503);

    if (url.pathname === "/cgi-bin/ledig.pl" && req.method === "GET") {
      const dato = url.searchParams.get("dato") ?? "";
      const type = url.searchParams.get("type") ?? "";
      if (!parseLegacyDato(dato)) return send("ERR 17 Ugyldig dato");
      if (!["U", "R", "A", "F"].includes(type)) return send("ERR 12 Ukjent type");
      return send(`OK\n${state.ledige(dato, type as Tjenestekode).join(",")}\n`);
    }

    if (url.pathname === "/cgi-bin/bestill.pl" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const f = new URLSearchParams(raw);
      const [dato, kl, type, navn, tlf] = ["dato", "kl", "type", "navn", "tlf"].map((k) => f.get(k) ?? "");
      if (!dato || !kl || !type || !navn || !tlf) return send("ERR 23 Mangler felt");
      const d = parseLegacyDato(dato);
      if (!d) return send("ERR 17 Ugyldig dato");
      if (!/^\d{8}$/.test(tlf)) return send("ERR 41 Ugyldig tlf");
      const start = new Date(d.getTime() + (Number(kl.slice(0, 2)) * 60 + Number(kl.slice(2))) * 60_000);
      if (start.getTime() < now().getTime()) return send("ERR 24 Tid passert");
      if (!state.ledige(dato, type as Tjenestekode).includes(kl)) return send("ERR 22 Opptatt");
      const b = state.add({ dato, kl, type: type as Tjenestekode, navn, tlf });
      // Lagret, men svaret forsvinner: klienten ser en timeout.
      if ((opts.lostResponseRate ?? 0) > rng()) return void req.socket.destroy();
      return send(`OK ${b.id}`);
    }

    if (url.pathname === "/cgi-bin/finn.pl" && req.method === "GET") {
      const tlf = url.searchParams.get("tlf") ?? "";
      if (!/^\d{8}$/.test(tlf)) return send("ERR 41 Ugyldig tlf");
      const rows = [...state.bookings.values()]
        .filter((b) => b.tlf === tlf)
        .map((b) => [b.id, b.dato, b.kl, b.type, b.navn].join(";"));
      return send(`OK\n${rows.join("\n")}\n`);
    }

    if (url.pathname === "/cgi-bin/slett.pl" && req.method === "GET") {
      const id = Number(url.searchParams.get("id"));
      return send(state.bookings.delete(id) ? "OK" : "ERR 31 Finnes ikke");
    }

    send("Not Found", 404);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${actual}`,
    get state() {
      return state;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    reset: (seed = opts.seed ?? 1, seedBookings = []) => {
      state = new LegacyState(seed, seedBookings);
      rng = mulberry32(seed);
    },
  };
}
