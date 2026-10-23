/**
 * Kundeemner fra demosamtaler. Den som har testet agenten på sin egen nettside,
 * kan booke en gjennomgang etterpå, og selgeren får samtalen og oppsummeringen
 * med, så praten starter der testen sluttet.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Lead {
  id: string;
  tid: string;
  navn: string;
  epost: string;
  telefon: string;
  virksomhet: string;
  samtaleId: string;
  /** Hentet fra oppsummeringen, så selgeren ser hva testen viste uten å åpne samtalen. */
  kort: string;
  ubesvarte: string[];
  kunnskapshull: number;
}

export type LeadInn = Pick<Lead, "navn" | "epost" | "telefon" | "samtaleId">;

const EPOST = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Returnerer en feilmelding til brukeren, eller null hvis feltene er gyldige. */
export function validerLead(b: Record<string, unknown>): string | null {
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  if (!s("navn") || s("navn").length > 100) return "Skriv inn navnet ditt.";
  if (!EPOST.test(s("epost")) || s("epost").length > 200) return "Skriv inn en gyldig e-postadresse.";
  if (s("telefon").length > 30) return "Telefonnummeret er for langt.";
  if (!s("samtaleId")) return "Mangler samtale.";
  return null;
}

export function lagLeadLager(dir: string) {
  const fil = join(dir, "leads.json");
  const les = (): Lead[] => (existsSync(fil) ? JSON.parse(readFileSync(fil, "utf8")) : []);
  return {
    liste: () => les().reverse(),
    legg(inn: LeadInn, samtale: { profil?: { navn?: string }; oppsummering?: { kort?: string; ubesvarte_sporsmal?: string[]; kunnskapshull?: unknown[] } } | null): Lead {
      const o = samtale?.oppsummering;
      const lead: Lead = {
        id: randomUUID(),
        tid: new Date().toISOString(),
        navn: inn.navn.trim(),
        epost: inn.epost.trim(),
        telefon: (inn.telefon ?? "").trim(),
        virksomhet: samtale?.profil?.navn ?? "ukjent",
        samtaleId: inn.samtaleId,
        kort: o?.kort ?? "",
        ubesvarte: o?.ubesvarte_sporsmal ?? [],
        kunnskapshull: o?.kunnskapshull?.length ?? 0,
      };
      writeFileSync(fil, JSON.stringify([...les(), lead], null, 2));
      return lead;
    },
  };
}
