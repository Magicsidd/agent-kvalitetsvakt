/**
 * Gjør en nettside om til en kunnskapsbase agenten kan søke i.
 *
 * Forsiden pluss inntil fire undersider på samme domene, valgt etter hvor
 * nyttige de er i telefonen (kontakt, priser, åpningstider, tjenester, FAQ).
 * Ingen LLM er involvert, så det koster ingenting og tar noen sekunder.
 */
import { Kunnskapsbase } from "../kunnskap/sok.ts";
import { trygHent, type HentOptions } from "./trygHent.ts";

export interface NettsideKunnskap {
  virksomhet: string;
  beskrivelse: string;
  markdown: string;
  sider: string[];
  kb: Kunnskapsbase;
}

const ENTITETER: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", eacute: "é", aring: "å", oslash: "ø", aelig: "æ", Aring: "Å", Oslash: "Ø", AElig: "Æ" };

function dekod(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITETER[n] ?? m);
}

const ren = (s: string) => dekod(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function tittelOgBeskrivelse(html: string): { tittel: string; beskrivelse: string } {
  const tittel = ren(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const meta =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    "";
  const siteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i)?.[1];
  return { tittel: dekod(siteName ?? tittel.split(/[|–—-]/)[0] ?? tittel).trim(), beskrivelse: dekod(meta).trim() };
}

/** Deler siden i avsnitt etter overskrifter, som «## Overskrift\ntekst». */
export function htmlTilAvsnitt(html: string, sideNavn: string): string {
  const kropp = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const deler = kropp.split(/<h[1-3][^>]*>/i);
  const avsnitt: string[] = [];
  const innledning = ren(deler[0] ?? "");
  if (innledning.length > 40) avsnitt.push(`## ${sideNavn}\n${innledning.slice(0, 1500)}`);
  for (const del of deler.slice(1)) {
    const [overskriftHtml = "", resten = ""] = del.split(/<\/h[1-3]>/i);
    const overskrift = ren(overskriftHtml).slice(0, 100);
    const tekst = ren(resten).slice(0, 1500);
    if (overskrift && tekst.length > 20) avsnitt.push(`## ${overskrift}\n${tekst}`);
  }
  return avsnitt.join("\n\n");
}

const NYTTIGE = /kontakt|contact|pris|price|åpning|apning|opening|tjenest|service|faq|sporsmal|spørsmål|om-oss|about|behandling|meny|produkt/i;

export function interneLenker(html: string, base: URL): string[] {
  const funnet = new Map<string, number>();
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(m[1]!, base);
    } catch {
      continue;
    }
    if (url.hostname !== base.hostname || !/^https?:$/.test(url.protocol)) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|zip|mp[34]|webp)$/i.test(url.pathname)) continue;
    url.hash = "";
    url.search = "";
    const key = url.toString();
    if (key === base.toString()) continue;
    const score = (NYTTIGE.test(url.pathname) ? 2 : 0) + (NYTTIGE.test(ren(m[2]!)) ? 1 : 0);
    funnet.set(key, Math.max(funnet.get(key) ?? 0, score));
  }
  return [...funnet.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

export async function kunnskapFraNettside(raw: string, opts: HentOptions & { maksUndersider?: number } = {}): Promise<NettsideKunnskap> {
  const forside = await trygHent(raw, opts);
  const base = new URL(forside.url);
  const { tittel, beskrivelse } = tittelOgBeskrivelse(forside.innhold);
  const deler = [htmlTilAvsnitt(forside.innhold, tittel || base.hostname)];
  const sider = [forside.url];

  for (const lenke of interneLenker(forside.innhold, base).slice(0, opts.maksUndersider ?? 4)) {
    try {
      const side = await trygHent(lenke, opts);
      deler.push(htmlTilAvsnitt(side.innhold, tittelOgBeskrivelse(side.innhold).tittel || new URL(lenke).pathname));
      sider.push(side.url);
    } catch {
      // En undersider som feiler skal ikke stoppe resten.
    }
  }

  const markdown = deler.join("\n\n").slice(0, 60_000);
  return {
    virksomhet: tittel || base.hostname,
    beskrivelse: beskrivelse || markdown.slice(0, 300),
    markdown,
    sider,
    kb: new Kunnskapsbase(markdown),
  };
}
