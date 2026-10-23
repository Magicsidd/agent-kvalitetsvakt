/**
 * Ren, typet adapter over det klønete legacy-API-et.
 *
 * Agenten skal aldri se «ERR 22» eller «0830». Den får domeneobjekter og
 * feil med en kode den kan handle på. Adapteren eier også det agenten ikke
 * skal måtte tenke på: tidsavbrudd, nye forsøk, telefonnormalisering og at
 * en booking aldri lagres to ganger når et svar forsvinner.
 */
import { isoDato, isoTid, osloNaa } from "../tid.ts";
import type { Tjenestekode } from "./legacyServer.ts";

export const BEHANDLINGER = ["undersokelse", "tannrens", "akutt", "fylling"] as const;
export type Behandling = (typeof BEHANDLINGER)[number];

const TIL_KODE: Record<Behandling, Tjenestekode> = { undersokelse: "U", tannrens: "R", akutt: "A", fylling: "F" };
const FRA_KODE: Record<Tjenestekode, Behandling> = { U: "undersokelse", R: "tannrens", A: "akutt", F: "fylling" };

export interface LedigTid {
  start: string; // YYYY-MM-DDTHH:MM, lokal tid
  behandling: Behandling;
}

export interface Bestilling {
  id: string;
  start: string;
  behandling: Behandling;
  navn: string;
}

export type FeilKode = "OPPTATT" | "UGYLDIG" | "PASSERT" | "FINNES_IKKE" | "UTILGJENGELIG";

export class BookingFeil extends Error {
  constructor(public kode: FeilKode, melding: string) {
    super(melding);
  }
}

export type AdapterHendelse =
  | { type: "kall"; sti: string; ms: number; status: number | "timeout" }
  | { type: "nytt_forsok"; sti: string; forsok: number }
  | { type: "gjenopprettet_booking"; id: string };

export interface AdapterOptions {
  baseUrl: string;
  timeoutMs?: number;
  forsok?: number;
  now?: () => Date;
  onHendelse?: (h: AdapterHendelse) => void;
}

const LEGACY_FEIL: Record<string, FeilKode> = {
  "12": "UGYLDIG", "17": "UGYLDIG", "22": "OPPTATT", "23": "UGYLDIG",
  "24": "PASSERT", "31": "FINNES_IKKE", "41": "UGYLDIG",
};

/** «+47 405 39 105», «0047 40539105», «405 39 105» -> «40539105». */
export function normaliserTelefon(input: string): string {
  let digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+47")) digits = digits.slice(3);
  else if (digits.startsWith("0047")) digits = digits.slice(4);
  digits = digits.replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) throw new BookingFeil("UGYLDIG", "Telefonnummeret må ha åtte siffer.");
  return digits;
}

function tilLegacyDato(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

function fraLegacy(dato: string, kl: string): string {
  const [d, m, y] = dato.split(".");
  return `${y}-${m}-${d}T${kl.slice(0, 2)}:${kl.slice(2)}`;
}

class Midlertidig extends Error {}

export class BookingAdapter {
  private timeoutMs: number;
  private forsok: number;
  private now: () => Date;

  constructor(private opts: AdapterOptions) {
    this.timeoutMs = opts.timeoutMs ?? 2500;
    this.forsok = opts.forsok ?? 3;
    this.now = opts.now ?? osloNaa;
  }

  private async kall(sti: string, init?: RequestInit): Promise<string[]> {
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(this.opts.baseUrl + sti, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      this.opts.onHendelse?.({ type: "kall", sti, ms: Math.round(performance.now() - t0), status: "timeout" });
      throw new Midlertidig("timeout");
    }
    const body = await res.text();
    this.opts.onHendelse?.({ type: "kall", sti, ms: Math.round(performance.now() - t0), status: res.status });
    if (res.status >= 500) throw new Midlertidig(`HTTP ${res.status}`);
    if (res.status !== 200) throw new BookingFeil("UTILGJENGELIG", `Uventet svar fra bookingsystemet (${res.status}).`);
    const err = body.match(/^ERR (\d+) (.*)/);
    if (err) throw new BookingFeil(LEGACY_FEIL[err[1]!] ?? "UTILGJENGELIG", err[2]!.trim());
    if (!body.startsWith("OK")) throw new BookingFeil("UTILGJENGELIG", "Uleselig svar fra bookingsystemet.");
    return body.trim().split("\n");
  }

  /** Lesekall er trygge å gjenta. */
  private async lesMedForsok(sti: string): Promise<string[]> {
    for (let i = 1; ; i++) {
      try {
        return await this.kall(sti);
      } catch (e) {
        if (!(e instanceof Midlertidig) || i >= this.forsok) {
          if (e instanceof Midlertidig) throw new BookingFeil("UTILGJENGELIG", "Bookingsystemet svarer ikke akkurat nå.");
          throw e;
        }
        this.opts.onHendelse?.({ type: "nytt_forsok", sti, forsok: i + 1 });
        await new Promise((r) => setTimeout(r, 150 * i));
      }
    }
  }

  async finnLedigeTider(p: {
    behandling: Behandling;
    fraDato: string;
    tilDato?: string;
    tidPaDagen?: "formiddag" | "ettermiddag" | "hele_dagen";
    maks?: number;
  }): Promise<LedigTid[]> {
    const naa = this.now();
    const fra = new Date(`${p.fraDato}T00:00:00Z`);
    const startDag = fra < naa ? new Date(`${isoDato(naa)}T00:00:00Z`) : fra;
    const til = p.tilDato ? new Date(`${p.tilDato}T00:00:00Z`) : new Date(startDag.getTime() + 13 * 86_400_000);
    const maks = p.maks ?? 6;
    const funnet: LedigTid[] = [];

    for (let d = startDag; d <= til && funnet.length < maks; d = new Date(d.getTime() + 86_400_000)) {
      const linjer = await this.lesMedForsok(
        `/cgi-bin/ledig.pl?dato=${tilLegacyDato(isoDato(d))}&type=${TIL_KODE[p.behandling]}`,
      );
      for (const kl of (linjer[1] ?? "").split(",").filter(Boolean)) {
        const start = fraLegacy(tilLegacyDato(isoDato(d)), kl);
        if (start <= isoTid(naa)) continue;
        const time = Number(kl.slice(0, 2));
        if (p.tidPaDagen === "formiddag" && time >= 12) continue;
        if (p.tidPaDagen === "ettermiddag" && time < 12) continue;
        funnet.push({ start, behandling: p.behandling });
        if (funnet.length >= maks) break;
      }
    }
    return funnet;
  }

  async finnBestillinger(telefon: string): Promise<Bestilling[]> {
    const tlf = normaliserTelefon(telefon);
    const linjer = await this.lesMedForsok(`/cgi-bin/finn.pl?tlf=${tlf}`);
    return linjer.slice(1).filter(Boolean).map((l) => {
      const [id, dato, kl, type, navn] = l.split(";");
      return { id: id!, start: fraLegacy(dato!, kl!), behandling: FRA_KODE[type as Tjenestekode], navn: navn! };
    });
  }

  /**
   * Booking er ikke trygg å gjenta blindt: legacy kan lagre bookingen og så
   * miste svaret. Før hvert nytt forsøk sjekker vi om den allerede finnes.
   */
  async book(p: { behandling: Behandling; start: string; navn: string; telefon: string }): Promise<Bestilling> {
    const tlf = normaliserTelefon(p.telefon);
    const navn = p.navn.trim();
    if (navn.length < 2) throw new BookingFeil("UGYLDIG", "Navn mangler.");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.start)) throw new BookingFeil("UGYLDIG", "Ugyldig tidspunkt.");
    const body = new URLSearchParams({
      dato: tilLegacyDato(p.start),
      kl: p.start.slice(11, 16).replace(":", ""),
      type: TIL_KODE[p.behandling],
      navn,
      tlf,
    });

    for (let i = 1; ; i++) {
      try {
        const [linje] = await this.kall("/cgi-bin/bestill.pl", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
        return { id: linje!.slice(3).trim(), start: p.start, behandling: p.behandling, navn };
      } catch (e) {
        if (!(e instanceof Midlertidig)) throw e;
        const eksisterende = (await this.finnBestillinger(tlf).catch(() => [])).find(
          (b) => b.start === p.start && b.behandling === p.behandling,
        );
        if (eksisterende) {
          this.opts.onHendelse?.({ type: "gjenopprettet_booking", id: eksisterende.id });
          return eksisterende;
        }
        if (i >= this.forsok) throw new BookingFeil("UTILGJENGELIG", "Bookingsystemet svarer ikke akkurat nå.");
        this.opts.onHendelse?.({ type: "nytt_forsok", sti: "/cgi-bin/bestill.pl", forsok: i + 1 });
        await new Promise((r) => setTimeout(r, 150 * i));
      }
    }
  }

  /**
   * Legacy lar hvem som helst slette hvilken som helst id. Vi krever at
   * bookingen tilhører telefonnummeret innringeren har oppgitt.
   */
  async avbestill(p: { id: string; telefon: string }): Promise<void> {
    const egne = await this.finnBestillinger(p.telefon);
    if (!egne.some((b) => b.id === p.id)) {
      throw new BookingFeil("FINNES_IKKE", "Fant ingen bestilling med det nummeret på dette telefonnummeret.");
    }
    for (let i = 1; ; i++) {
      try {
        await this.kall(`/cgi-bin/slett.pl?id=${encodeURIComponent(p.id)}`);
        return;
      } catch (e) {
        if (!(e instanceof Midlertidig)) throw e;
        // Slettingen kan ha gått gjennom selv om svaret uteble.
        const finnes = (await this.finnBestillinger(p.telefon)).some((b) => b.id === p.id);
        if (!finnes) return;
        if (i >= this.forsok) throw new BookingFeil("UTILGJENGELIG", "Bookingsystemet svarer ikke akkurat nå.");
        this.opts.onHendelse?.({ type: "nytt_forsok", sti: "/cgi-bin/slett.pl", forsok: i + 1 });
      }
    }
  }
}
