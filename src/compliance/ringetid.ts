/**
 * Når er det lov å ringe forbrukere med telefonsalg?
 *
 * Forbudt på lørdager, søn- og helligdager, og på hverdager før kl. 09 og
 * etter kl. 21 (markedsføringsloven § 14 og regjeringen.no om telefonsalg).
 * Gjelder utgående salgssamtaler, ikke kundeservice innringeren selv starter.
 * I tillegg må nummeret sjekkes mot Reservasjonsregisteret før hver kampanje.
 */
import { isoDato } from "../tid.ts";

/** Påskedag etter den anonyme gregorianske algoritmen. */
export function paaskedag(aar: number): Date {
  const a = aar % 19, b = Math.floor(aar / 100), c = aar % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const maned = Math.floor((h + l - 7 * m + 114) / 31), dag = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(aar, maned - 1, dag));
}

export function helligdager(aar: number): Map<string, string> {
  const p = paaskedag(aar);
  const fraPaske = (dager: number) => isoDato(new Date(p.getTime() + dager * 86_400_000));
  const liste: [string, string][] = [
    [`${aar}-01-01`, "første nyttårsdag"],
    [fraPaske(-3), "skjærtorsdag"],
    [fraPaske(-2), "langfredag"],
    [fraPaske(0), "første påskedag"],
    [fraPaske(1), "andre påskedag"],
    [`${aar}-05-01`, "arbeidernes dag"],
    [`${aar}-05-17`, "grunnlovsdag"],
    [fraPaske(39), "Kristi himmelfartsdag"],
    [fraPaske(49), "første pinsedag"],
    [fraPaske(50), "andre pinsedag"],
    [`${aar}-12-25`, "første juledag"],
    [`${aar}-12-26`, "andre juledag"],
  ];
  // Dager kan falle sammen (andre pinsedag er 17. mai i 2027).
  const dager = new Map<string, string>();
  for (const [dato, navn] of liste) dager.set(dato, dager.has(dato) ? `${dager.get(dato)} og ${navn}` : navn);
  return dager;
}

export interface Ringevurdering {
  lovlig: boolean;
  grunn: string;
  nesteLovlige: string; // YYYY-MM-DDTHH:MM, lokal tid
}

function grunnTilForbud(t: Date): string | null {
  const dato = isoDato(t);
  const hellig = helligdager(t.getUTCFullYear()).get(dato);
  if (hellig) return `${hellig} er helligdag`;
  if (t.getUTCDay() === 0) return "søndag";
  if (t.getUTCDay() === 6) return "lørdag";
  const min = t.getUTCHours() * 60 + t.getUTCMinutes();
  if (min < 9 * 60) return "før klokka 09";
  if (min >= 21 * 60) return "etter klokka 21";
  return null;
}

/** `tid` er lokal norsk tid i UTC-feltene, som ellers i prosjektet. */
export function vurderRingetid(tid: Date): Ringevurdering {
  const grunn = grunnTilForbud(tid);
  if (!grunn) return { lovlig: true, grunn: "innenfor lovlig tid", nesteLovlige: tid.toISOString().slice(0, 16) };
  // Neste lovlige tidspunkt: klokka 09 en senere dag, eller 09 samme dag hvis det er tidlig morgen.
  let kandidat = new Date(Date.UTC(tid.getUTCFullYear(), tid.getUTCMonth(), tid.getUTCDate(), 9));
  if (kandidat <= tid) kandidat = new Date(kandidat.getTime() + 86_400_000);
  while (grunnTilForbud(kandidat)) kandidat = new Date(kandidat.getTime() + 86_400_000);
  return { lovlig: false, grunn, nesteLovlige: kandidat.toISOString().slice(0, 16) };
}
