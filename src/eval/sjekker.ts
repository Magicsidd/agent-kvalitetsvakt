/**
 * Deterministiske sjekker av én simulert samtale.
 *
 * Disse koster ingenting og gir samme svar hver gang. LLM-dommeren brukes
 * bare til det som ikke lar seg måle mekanisk (naturlig språk, tone).
 */
import { readFileSync, readdirSync } from "node:fs";
import type { LegacyBooking } from "../integrasjon/legacyServer.ts";
import type { Tur } from "../agent/samtale.ts";

export interface Scenario {
  id: string;
  tittel: string;
  innringer_nummer: string | null;
  persona: string;
  seedBookings?: Omit<LegacyBooking, "id">[];
  forventet: {
    booking?: { behandling: string; telefon: string; navn?: string; fra: string; til: string; tid_pa_dagen?: "formiddag" | "ettermiddag" };
    ikke_dag?: number[];
    ingen_ny_booking?: boolean;
    avbestilt_seed?: number[];
    beholdt_seed?: number[];
    overfort?: boolean;
    ma_nevne?: string[];
    ma_ikke_nevne?: string[];
  };
  maks_turer: number;
}

export function lastScenarier(filter?: string): Scenario[] {
  const dir = new URL("./scenarier/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Scenario)
    .filter((s) => !filter || s.id.includes(filter));
}

export interface SjekkResultat {
  navn: string;
  ok: boolean;
  detalj: string;
}

export interface Utfall {
  turer: Tur[];
  status: "aktiv" | "overfort" | "avsluttet";
  bookingerEtter: LegacyBooking[];
}

const BEHANDLINGSKODE: Record<string, string> = { undersokelse: "U", tannrens: "R", akutt: "A", fylling: "F" };
const TIMETALL: Record<string, number> = {
  ett: 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, sju: 7, syv: 7, åtte: 8, ni: 9, ti: 10, elleve: 11, tolv: 12,
};

/** Alle klokkeslett nevnt i en tekst, som HH:MM. «halv ni» -> 08:30, «klokka 13» -> 13:00. */
export function klokkeslett(tekst: string): string[] {
  const funnet = new Set<string>();
  const t = tekst.toLowerCase();
  for (const m of t.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)) funnet.add(`${m[1]!.padStart(2, "0")}:${m[2]}`);
  for (const m of t.matchAll(/\bklokk(?:a|en)\s+(\d{1,2})\b(?![:.]\d)/g)) funnet.add(`${m[1]!.padStart(2, "0")}:00`);
  for (const m of t.matchAll(/\bhalv\s+(ett|to|tre|fire|fem|seks|sju|syv|åtte|ni|ti|elleve|tolv)\b/g)) {
    let h = TIMETALL[m[1]!]! - 1;
    // Klinikken har åpent 08–16, så «halv tre» betyr 14:30.
    if (h < 7) h += 12;
    funnet.add(`${String(h).padStart(2, "0")}:30`);
  }
  // «klokka 8» kan bety 20:00 i teorien, men klinikken har bare dagtid.
  return [...funnet];
}

function iDatoIntervall(booking: LegacyBooking, fra: string, til: string): boolean {
  const [d, m, y] = booking.dato.split(".");
  const iso = `${y}-${m}-${d}`;
  return iso >= fra && iso <= til;
}

export function sjekk(s: Scenario, u: Utfall): SjekkResultat[] {
  const r: SjekkResultat[] = [];
  const agentTurer = u.turer.filter((t) => t.rolle === "agent");
  const agentTekst = agentTurer.map((t) => t.tekst).join("\n");
  const seed = s.seedBookings ?? [];
  const nye = u.bookingerEtter.filter((b) => !seed.some((x) => x.tlf === b.tlf && x.dato === b.dato && x.kl === b.kl));

  // 1. Utfall i bookingsystemet: det eneste som til syvende og sist teller.
  const f = s.forventet;
  if (f.booking) {
    const b = nye.find((x) => x.tlf === f.booking!.telefon);
    let ok = !!b && b.type === BEHANDLINGSKODE[f.booking.behandling] && iDatoIntervall(b, f.booking.fra, f.booking.til);
    let detalj = b ? `${b.type} ${b.dato} ${b.kl} på ${b.navn}` : "ingen booking på riktig nummer";
    if (b && f.booking.navn && b.navn.toLowerCase() !== f.booking.navn.toLowerCase()) {
      ok = false;
      detalj += `, forventet navn ${f.booking.navn}`;
    }
    if (b && f.booking.tid_pa_dagen) {
      const formiddag = Number(b.kl.slice(0, 2)) < 12;
      if (formiddag !== (f.booking.tid_pa_dagen === "formiddag")) {
        ok = false;
        detalj += `, forventet ${f.booking.tid_pa_dagen}`;
      }
    }
    if (nye.length > 1) {
      ok = false;
      detalj += `, men ${nye.length} nye bookinger`;
    }
    r.push({ navn: "riktig booking", ok, detalj });
  }
  if (f.ingen_ny_booking) r.push({ navn: "ingen ny booking", ok: nye.length === 0, detalj: `${nye.length} nye` });
  for (const i of f.avbestilt_seed ?? []) {
    const x = seed[i]!;
    const borte = !u.bookingerEtter.some((b) => b.tlf === x.tlf && b.dato === x.dato && b.kl === x.kl);
    r.push({ navn: `avbestilt ${x.navn}`, ok: borte, detalj: borte ? "slettet" : "finnes fortsatt" });
  }
  for (const i of f.beholdt_seed ?? []) {
    const x = seed[i]!;
    const finnes = u.bookingerEtter.some((b) => b.tlf === x.tlf && b.dato === x.dato && b.kl === x.kl);
    r.push({ navn: `beholdt ${x.navn}`, ok: finnes, detalj: finnes ? "urørt" : "ble slettet" });
  }
  if (f.ikke_dag) {
    const feil = nye.filter((b) => {
      const [d, m, y] = b.dato.split(".");
      return f.ikke_dag!.includes(new Date(`${y}-${m}-${d}T00:00:00Z`).getUTCDay());
    });
    r.push({ navn: "ikke i helg", ok: feil.length === 0, detalj: feil.map((b) => b.dato).join(", ") || "ok" });
  }
  if (f.overfort !== undefined) {
    r.push({ navn: "satt over", ok: (u.status === "overfort") === f.overfort, detalj: u.status });
  }

  // 2. Innhold.
  for (const m of f.ma_nevne ?? []) {
    r.push({ navn: `nevner /${m}/`, ok: new RegExp(m, "i").test(agentTekst), detalj: "" });
  }
  for (const m of f.ma_ikke_nevne ?? []) {
    const treff = agentTekst.match(new RegExp(m, "i"));
    r.push({ navn: `nevner ikke /${m}/`, ok: !treff, detalj: treff ? `sa «${treff[0]}»` : "" });
  }

  // 3. Ingen oppdiktede tider: hvert klokkeslett agenten sier må finnes i et
  //    verktøyresultat, i kunnskapsbasen via søk, eller hos innringeren selv.
  const lovlige = new Set<string>();
  const oppdiktet: string[] = [];
  for (const t of u.turer) {
    if (t.rolle === "innringer") klokkeslett(t.tekst).forEach((k) => lovlige.add(k));
    for (const v of t.verktoy ?? []) {
      for (const m of v.resultat.matchAll(/T(\d{2}:\d{2})/g)) lovlige.add(m[1]!);
      klokkeslett(v.resultat).forEach((k) => lovlige.add(k));
    }
    // Agenten kan ha sjekket i samme tur før den svarte, så vi legger til først.
    if (t.rolle === "agent") for (const k of klokkeslett(t.tekst)) if (!lovlige.has(k)) oppdiktet.push(k);
  }
  r.push({ navn: "ingen oppdiktede tider", ok: oppdiktet.length === 0, detalj: oppdiktet.join(", ") || "ok" });

  // 3b. Åpenhet: innringeren skal vite at det er en KI (EU-s KI-forordning art. 50).
  const forste = agentTurer[0]?.tekst ?? "";
  const kiOpplyst = /\b(KI|AI)\b|kunstig intelligens|digital assistent|robot/i.test(forste);
  r.push({ navn: "opplyser om KI", ok: kiOpplyst, detalj: kiOpplyst ? "" : "første replikk sier ikke at det er en KI" });

  // 4. Talevennlig: ingen markdown, korte replikker.
  const markdown = agentTurer.filter((t) => /(\*\*|^#|^\s*[-•]\s|`)/m.test(t.tekst)).length;
  r.push({ navn: "ingen markdown", ok: markdown === 0, detalj: `${markdown} turer` });
  const ord = agentTurer.map((t) => t.tekst.split(/\s+/).length);
  const maksOrd = Math.max(0, ...ord);
  r.push({ navn: "korte replikker", ok: maksOrd <= 60, detalj: `lengste ${maksOrd} ord` });

  // 5. Bekreftelse før booking: turen før book_time må være et spørsmål.
  const bookTur = u.turer.findIndex((t) => t.verktoy?.some((v) => v.navn === "book_time" && !v.feil));
  if (bookTur > 0) {
    const forrigeAgent = u.turer.slice(0, bookTur).filter((t) => t.rolle === "agent").at(-1);
    const ok = !!forrigeAgent && /\?\s*$/.test(forrigeAgent.tekst.trim());
    r.push({ navn: "bekreftet før booking", ok, detalj: ok ? "" : "booket uten å spørre først" });
  }

  // 6. Feilformet verktøyinput tyder på et svakt skjema eller en uklar prompt.
  const ugyldige = u.turer.flatMap((t) => t.verktoy ?? []).filter((v) => v.resultat.startsWith("Ugyldig input")).length;
  r.push({ navn: "gyldig verktøyinput", ok: ugyldige === 0, detalj: `${ugyldige} ugyldige` });

  return r;
}

export function persentil(verdier: number[], p: number): number {
  if (!verdier.length) return 0;
  const sortert = [...verdier].sort((a, b) => a - b);
  return sortert[Math.min(sortert.length - 1, Math.floor((p / 100) * sortert.length))]!;
}
