/**
 * Verktøyene agenten kan kalle. Hvert verktøy har et strengt JSON-skjema for
 * modellen og et Zod-skjema som valideres før noe kjøres, så en feilformet
 * input aldri når bookingsystemet.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { BEHANDLINGER, BookingAdapter, BookingFeil, normaliserTelefon, type Bestilling } from "../integrasjon/bookingAdapter.ts";
import type { Kunnskapsbase } from "../kunnskap/sok.ts";
import { lesbarTid } from "../tid.ts";

type BetaTool = Anthropic.Beta.BetaTool;

const dato = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const tidspunkt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

export const SKJEMA = {
  finn_ledige_tider: z.object({
    behandling: z.enum(BEHANDLINGER),
    fra_dato: dato,
    tid_pa_dagen: z.enum(["formiddag", "ettermiddag", "hele_dagen"]),
  }),
  book_time: z.object({
    behandling: z.enum(BEHANDLINGER),
    start: tidspunkt,
    navn: z.string().min(2),
    telefon: z.string().min(8),
  }),
  finn_bestillinger: z.object({ telefon: z.string().min(8), navn: z.string() }),
  avbestill_time: z.object({ bestillings_id: z.string().min(1), telefon: z.string().min(8), navn: z.string() }),
  sok_kunnskap: z.object({ sporsmal: z.string().min(2) }),
  sett_over_til_ansatt: z.object({ grunn: z.string(), oppsummering: z.string() }),
  ta_imot_beskjed: z.object({ navn: z.string().min(2), telefon: z.string().min(8), beskjed: z.string().min(2) }),
  avslutt_samtale: z.object({}),
} as const;

export type VerktoyNavn = keyof typeof SKJEMA;

function verktoy(name: VerktoyNavn, description: string, properties: Record<string, unknown>): BetaTool {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  };
}

const behandling = { type: "string", enum: [...BEHANDLINGER], description: "Hvilken behandling timen gjelder." };

export const VERKTOY: BetaTool[] = [
  verktoy("finn_ledige_tider", "Finner ledige timer fra og med en dato (opptil 14 dager fram). Bruk alltid dette før du foreslår tider.", {
    behandling,
    fra_dato: { type: "string", description: "Første dato å lete fra, YYYY-MM-DD." },
    tid_pa_dagen: { type: "string", enum: ["formiddag", "ettermiddag", "hele_dagen"] },
  }),
  verktoy("book_time", "Booker en time. Bare etter at innringeren har bekreftet behandling, tid, navn og nummer.", {
    behandling,
    start: { type: "string", description: "Starttid fra finn_ledige_tider, YYYY-MM-DDTHH:MM." },
    navn: { type: "string", description: "Fullt navn på pasienten." },
    telefon: { type: "string", description: "Mobilnummer, åtte siffer." },
  }),
  verktoy("finn_bestillinger", "Finner kommende bestillinger på et mobilnummer. Er det ikke nummeret det ringes fra, må fullt navn på pasienten oppgis.", {
    telefon: { type: "string", description: "Mobilnummeret innringeren oppgir." },
    navn: { type: "string", description: "Fullt navn på pasienten, eller tom streng hvis ukjent." },
  }),
  verktoy("avbestill_time", "Avbestiller en bestilling. Krever at bestillingen hører til nummeret, og samme navnekrav som finn_bestillinger.", {
    bestillings_id: { type: "string" },
    telefon: { type: "string" },
    navn: { type: "string", description: "Fullt navn på pasienten, eller tom streng hvis ukjent." },
  }),
  verktoy("sok_kunnskap", "Søker i klinikkens informasjon: åpningstider, priser, adresse, betaling, avbestillingsregler.", {
    sporsmal: { type: "string", description: "Spørsmålet med innringerens egne ord." },
  }),
  verktoy("sett_over_til_ansatt", "Setter samtalen over til en ansatt. Avslutter din del av samtalen.", {
    grunn: { type: "string" },
    oppsummering: { type: "string", description: "Kort oppsummering den ansatte får før de tar over." },
  }),
  verktoy("ta_imot_beskjed", "Lagrer en beskjed så noen ringer tilbake. Bare etter at innringeren har bekreftet navn og nummer.", {
    navn: { type: "string" },
    telefon: { type: "string", description: "Mobilnummer, åtte siffer." },
    beskjed: { type: "string", description: "Hva henvendelsen gjelder, kort." },
  }),
  verktoy("avslutt_samtale", "Avslutter samtalen etter at du har sagt ha det.", {}),
];

export function verktoyFor(navn: VerktoyNavn[]): BetaTool[] {
  return VERKTOY.filter((v) => navn.includes(v.name as VerktoyNavn));
}

export interface Beskjed {
  navn: string;
  telefon: string;
  beskjed: string;
}

export interface VerktoyKontekst {
  /** Bare profiler med booking har et bookingsystem. */
  adapter?: BookingAdapter;
  /** Verktøyene profilen har lov til å bruke. Alt annet avvises. */
  tillatt: VerktoyNavn[];
  onBeskjed?: (b: Beskjed) => void;
  kb: Kunnskapsbase;
  /** Nummeret det ringes fra, normalisert. Kommer fra telefonnettet, ikke fra innringeren. */
  innringerNummer?: string;
}

/**
 * Enkel verifisering: ringer man fra nummeret, er det godt nok. Ellers må
 * fullt navn stemme. I produksjon er dette stedet for BankID midt i samtalen.
 */
async function egneBestillinger(telefon: string, navn: string, ctx: VerktoyKontekst): Promise<Bestilling[]> {
  const liste = await ctx.adapter!.finnBestillinger(telefon);
  if (ctx.innringerNummer && normaliserTelefon(telefon) === ctx.innringerNummer) return liste;
  const oppgitt = navn.toLowerCase().split(/\s+/).filter(Boolean);
  return liste.filter((b) => {
    const deler = b.navn.toLowerCase().split(/\s+/);
    return deler.length > 0 && deler.every((d) => oppgitt.includes(d));
  });
}

export interface VerktoyResultat {
  innhold: string;
  feil: boolean;
  /** Signal til samtalen om å avslutte eller sette over. */
  slutt?: "overfort" | "avsluttet";
}

export async function kjorVerktoy(navn: string, input: unknown, ctx: VerktoyKontekst): Promise<VerktoyResultat> {
  if (!(navn in SKJEMA) || !ctx.tillatt.includes(navn as VerktoyNavn)) return { innhold: `Ukjent verktøy: ${navn}`, feil: true };
  const adapter = ctx.adapter;
  const trengerBooking = ["finn_ledige_tider", "book_time", "finn_bestillinger", "avbestill_time"].includes(navn);
  if (trengerBooking && !adapter) return { innhold: "Ingen bookingsystem er koblet til.", feil: true };
  const parsed = SKJEMA[navn as VerktoyNavn].safeParse(input);
  if (!parsed.success) {
    return { innhold: `Ugyldig input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, feil: true };
  }
  const a = parsed.data as Record<string, string>;

  try {
    switch (navn as VerktoyNavn) {
      case "finn_ledige_tider": {
        const tider = await adapter!.finnLedigeTider({
          behandling: a.behandling as never,
          fraDato: a.fra_dato!,
          tidPaDagen: a.tid_pa_dagen as never,
        });
        if (!tider.length) return { innhold: JSON.stringify({ ledige: [], merknad: "Ingen ledige tider i perioden." }), feil: false };
        return {
          innhold: JSON.stringify({ ledige: tider.map((t) => ({ start: t.start, si_det_slik: lesbarTid(t.start) })) }),
          feil: false,
        };
      }
      case "book_time": {
        const b = await adapter!.book({
          behandling: a.behandling as never, start: a.start!, navn: a.navn!, telefon: a.telefon!,
        });
        return { innhold: JSON.stringify({ booket: true, bestillings_id: b.id, tid: lesbarTid(b.start) }), feil: false };
      }
      case "finn_bestillinger": {
        const liste = await egneBestillinger(a.telefon!, a.navn ?? "", ctx);
        return {
          innhold: JSON.stringify({
            bestillinger: liste.map((b) => ({ bestillings_id: b.id, behandling: b.behandling, tid: lesbarTid(b.start), navn: b.navn })),
          }),
          feil: false,
        };
      }
      case "avbestill_time": {
        const egne = await egneBestillinger(a.telefon!, a.navn ?? "", ctx);
        if (!egne.some((b) => b.id === a.bestillings_id)) {
          return { innhold: JSON.stringify({ feil: "FINNES_IKKE", melding: "Fant ingen slik bestilling som innringeren kan endre." }), feil: true };
        }
        await adapter!.avbestill({ id: a.bestillings_id!, telefon: a.telefon! });
        return { innhold: JSON.stringify({ avbestilt: true }), feil: false };
      }
      case "sok_kunnskap": {
        const treff = ctx.kb.sok(a.sporsmal!);
        if (!treff.length) return { innhold: JSON.stringify({ treff: [], merknad: "Fant ikke noe om dette. Ikke gjett." }), feil: false };
        return { innhold: JSON.stringify({ treff: treff.map(({ tittel, tekst }) => ({ tittel, tekst })) }), feil: false };
      }
      case "ta_imot_beskjed": {
        const b = { navn: a.navn!.trim(), telefon: normaliserTelefon(a.telefon!), beskjed: a.beskjed!.trim() };
        ctx.onBeskjed?.(b);
        return { innhold: JSON.stringify({ lagret: true }), feil: false };
      }
      case "sett_over_til_ansatt":
        return { innhold: JSON.stringify({ satt_over: true }), feil: false, slutt: "overfort" };
      case "avslutt_samtale":
        return { innhold: JSON.stringify({ avsluttet: true }), feil: false, slutt: "avsluttet" };
    }
  } catch (e) {
    if (e instanceof BookingFeil) return { innhold: JSON.stringify({ feil: e.kode, melding: e.message }), feil: true };
    return { innhold: JSON.stringify({ feil: "UKJENT", melding: "Noe gikk galt i systemet." }), feil: true };
  }
  return { innhold: "Ukjent verktøy", feil: true };
}
