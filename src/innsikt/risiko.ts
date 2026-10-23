/**
 * Regler som flagger en samtale mens den pågår, så en ansatt kan følge med
 * og ta over. Bevisst enkle og forklarbare: hvert flagg sier hvorfor.
 */
import type { Tur } from "../agent/samtale.ts";

export interface Flagg {
  kode: "manipulasjon" | "helse" | "misfornoyd" | "vil_ha_menneske" | "systemfeil" | "treg" | "personnummer";
  alvor: "info" | "advarsel" | "kritisk";
  tekst: string;
}

const REGLER: { kode: Flagg["kode"]; alvor: Flagg["alvor"]; tekst: string; monster: RegExp }[] = [
  { kode: "manipulasjon", alvor: "kritisk", tekst: "Forsøk på å endre agentens instrukser", monster: /(ignorer|glem|overstyr).{0,40}(instruks|regler|beskjed)|system ?prompt|du er nå en|late som du/i },
  { kode: "helse", alvor: "kritisk", tekst: "Mulig akutt helseproblem", monster: /hevelse|hoven|feber|pustevansk|puste|bevisstløs|blør(er)? mye/i },
  { kode: "misfornoyd", alvor: "advarsel", tekst: "Misfornøyd innringer", monster: /klage|advokat|forbrukerrådet|svindel|forferdelig|elendig|sint|helt uakseptabelt/i },
  { kode: "vil_ha_menneske", alvor: "info", tekst: "Ber om å snakke med et menneske", monster: /menneske|ekte person|snakke med (en|noen) (ansatt|person)|ikke (en )?robot/i },
];

/** Gyldig norsk fødselsnummer (11 siffer, to kontrollsifre etter mod 11). */
export function erFodselsnummer(siffer: string): boolean {
  if (!/^\d{11}$/.test(siffer)) return false;
  const d = [...siffer].map(Number);
  const k = (vekter: number[]) => {
    const r = 11 - (vekter.reduce((s, v, i) => s + v * d[i]!, 0) % 11);
    return r === 11 ? 0 : r;
  };
  const k1 = k([3, 7, 6, 1, 8, 9, 4, 5, 2]);
  const k2 = k([5, 4, 3, 2, 7, 6, 5, 4, 3, 2]);
  return k1 !== 10 && k2 !== 10 && k1 === d[9] && k2 === d[10];
}

/** Bytter ut gyldige fødselsnumre med en plassholder før noe lagres. */
export function maskerPersonopplysninger(tekst: string): string {
  return tekst.replace(/\b(\d{6})\s?(\d{5})\b/g, (m, a, b) => (erFodselsnummer(a + b) ? "[fødselsnummer]" : m));
}

export function flaggForTur(tur: Tur): Flagg[] {
  const flagg: Flagg[] = [];
  if (tur.rolle === "innringer") {
    for (const r of REGLER) if (r.monster.test(tur.tekst)) flagg.push({ kode: r.kode, alvor: r.alvor, tekst: r.tekst });
    if (maskerPersonopplysninger(tur.tekst) !== tur.tekst) {
      flagg.push({ kode: "personnummer", alvor: "advarsel", tekst: "Innringeren sa et fødselsnummer (maskert i loggen)" });
    }
  } else {
    const feil = (tur.verktoy ?? []).filter((v) => v.feil);
    if (feil.length) flagg.push({ kode: "systemfeil", alvor: "advarsel", tekst: `Verktøy feilet: ${feil.map((v) => v.navn).join(", ")}` });
    if ((tur.maling?.totalMs ?? 0) > 4000) flagg.push({ kode: "treg", alvor: "info", tekst: `Svar tok ${(tur.maling!.totalMs / 1000).toFixed(1)} s` });
  }
  return flagg;
}
