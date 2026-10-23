/**
 * Enkel BM25 over avsnittene i kunnskapsbasen.
 *
 * Kunnskapsbasen er liten, så nøkkelordsøk med litt norsk normalisering er
 * raskt, deterministisk og lett å teste. Ved hundrevis av dokumenter per
 * kunde bytter man til embeddings, men grensesnittet (sok -> treff[]) er det samme.
 */
import { readFileSync } from "node:fs";

export interface Treff {
  tittel: string;
  tekst: string;
  score: number;
}

const STOPPORD = new Set(
  "og i på til er det en et å av for med som har vi de du jeg kan om man skal hva når hvor hvordan the".split(" "),
);

const SYNONYMER: Record<string, string> = {
  koster: "pris", kost: "pris", betale: "pris", kroner: "pris", dyrt: "pris", priser: "pris",
  apent: "åpningstid", åpent: "åpningstid", stenger: "åpningstid", åpner: "åpningstid", åpningstider: "åpningstid",
  parkere: "parkering", bil: "parkering", ligger: "adresse", hvor: "adresse",
  vondt: "tannpine", smerter: "tannpine", verk: "tannpine", akutt: "tannpine",
  avlyse: "avbestill", avbestille: "avbestill", flytte: "avbestill", gebyr: "avbestill",
  vipps: "betaling", kort: "betaling", faktura: "betaling", helfo: "betaling",
  redd: "tannlegeskrekk", gruer: "tannlegeskrekk", angst: "tannlegeskrekk", nervøs: "tannlegeskrekk",
  barn: "ungdom", sønn: "ungdom", datter: "ungdom", student: "ungdom",
};

function stamme(ord: string): string {
  for (const suffix of ["ene", "ane", "er", "en", "et", "a"]) {
    if (ord.length > suffix.length + 3 && ord.endsWith(suffix)) return ord.slice(0, -suffix.length);
  }
  return ord;
}

export function tokens(tekst: string): string[] {
  return tekst
    .toLowerCase()
    .replace(/[^a-zæøå0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPPORD.has(t))
    .flatMap((t) => (SYNONYMER[t] ? [stamme(t), SYNONYMER[t]] : [stamme(t)]));
}

interface Dok {
  tittel: string;
  tekst: string;
  tokens: string[];
}

export class Kunnskapsbase {
  private docs: Dok[];
  private df = new Map<string, number>();
  private snittLengde: number;

  constructor(markdown: string) {
    this.docs = markdown
      .split(/^## /m)
      .slice(1)
      .map((blokk) => {
        const [tittel = "", ...resten] = blokk.trim().split("\n");
        const tekst = resten.join(" ").trim();
        // Tittelen teller med, to ganger, siden den sier mest om avsnittet.
        return { tittel, tekst, tokens: [...tokens(tittel), ...tokens(tittel), ...tokens(tekst)] };
      });
    for (const d of this.docs) for (const t of new Set(d.tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.snittLengde = this.docs.reduce((s, d) => s + d.tokens.length, 0) / Math.max(1, this.docs.length);
  }

  static fraFil(sti = new URL("./klinikk.md", import.meta.url)): Kunnskapsbase {
    return new Kunnskapsbase(readFileSync(sti, "utf8"));
  }

  sok(sporsmal: string, maks = 2): Treff[] {
    const q = tokens(sporsmal);
    const N = this.docs.length;
    const k1 = 1.2, b = 0.75;
    return this.docs
      .map((d) => {
        let score = 0;
        for (const t of q) {
          const tf = d.tokens.filter((x) => x === t).length;
          if (!tf) continue;
          const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
          score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.tokens.length) / this.snittLengde)));
        }
        return { tittel: d.tittel, tekst: d.tekst, score: Math.round(score * 100) / 100 };
      })
      .filter((t) => t.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, maks);
  }
}
