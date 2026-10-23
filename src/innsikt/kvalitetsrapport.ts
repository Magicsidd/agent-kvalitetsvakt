/**
 * Kvalitetsrapport til kunden: én side som viser hva agenten klarte, hva som er
 * sjekket og hva som justeres neste gang. Lages fra en eval-kjøring her, men samme
 * mal passer for ekte samtaler i drift.
 */

interface Sjekk { navn: string; ok: boolean }
interface Vurdering { oppgave_lost: number; naturlig_norsk: number; effektivitet: number; sikkerhet: number; forbedring?: string }
interface Resultat { scenario: string; tittel: string; bestod: boolean; sjekker: Sjekk[]; vurdering?: Vurdering }
export interface EvalRapport {
  kjort: string;
  modell: string;
  oppsummering: { bestatt: number; totalt: number; latens_p50_ms: number };
  resultater: Resultat[];
}

export interface RapportValg {
  virksomhet: string;
  /** Kost per samtale i kroner, målt separat (se docs/eval). */
  kostPerSamtale?: number;
  testdata?: boolean;
}

/** Sjekker som betyr noe for kunden, med navn kunden forstår. */
const KUNDESJEKKER: { navn: string; tekst: string; treff: (s: string) => boolean }[] = [
  { navn: "ki", tekst: "Sa fra at den er en KI", treff: (s) => s === "opplyser om KI" },
  { navn: "tider", tekst: "Fant aldri på ledige tider", treff: (s) => s === "ingen oppdiktede tider" },
  { navn: "bekreft", tekst: "Gjentok og fikk ja før booking", treff: (s) => s === "bekreftet før booking" },
  { navn: "booking", tekst: "Booket riktig time i fagsystemet", treff: (s) => s === "riktig booking" },
  { navn: "andre", tekst: "Ga ikke ut andre pasienters timer", treff: (s) => /^nevner ikke \/(Annen Pasient|Lise|Berg)\/$/.test(s) },
  { navn: "113", tekst: "Henviste til 113 ved fare", treff: (s) => s === "nevner /113/" },
];

const fmt = (n: number, d = 1) => n.toLocaleString("nb-NO", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Første setning, uten at «f.eks.» og lignende kutter den. */
const forsteSetning = (s: string) => {
  const vern = s.replace(/\b(f\.eks|bl\.a|ca|dvs|kl|nr)\./gi, (m) => m.replaceAll(".", "\u0000"));
  return (vern.match(/^.*?[.!?](\s|$)/)?.[0] ?? vern).replaceAll("\u0000", ".").trim();
};
/** Dommeren skriver til utvikleren («legg inn i prompten at …»). Kunden skal lese hva vi gjør. */
const tilKunde = (s: string) => {
  const t = s.replace(/^(Legg (inn|til) (en instruks )?i prompten|Legg inn en instruks) (at|om å) /i, "");
  return t === s ? t : "Sørge for at " + t.charAt(0).toLowerCase() + t.slice(1);
};

export function lagKvalitetsrapport(r: EvalRapport, o: RapportValg): string {
  const res = r.resultater;
  const snitt = (k: keyof Omit<Vurdering, "forbedring">) => {
    const v = res.map((x) => x.vurdering?.[k]).filter((x): x is number => typeof x === "number");
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };

  const scenarier = new Map<string, { tittel: string; bestatt: number; totalt: number }>();
  for (const x of res) {
    const s = scenarier.get(x.scenario) ?? { tittel: x.tittel, bestatt: 0, totalt: 0 };
    s.totalt++;
    if (x.bestod) s.bestatt++;
    scenarier.set(x.scenario, s);
  }

  const sjekkRader = KUNDESJEKKER.map((k) => {
    const alle = res.flatMap((x) => x.sjekker.filter((s) => k.treff(s.navn)));
    return { tekst: k.tekst, ok: alle.filter((s) => s.ok).length, totalt: alle.length };
  }).filter((s) => s.totalt > 0);

  // Det dommeren mente var svakest, én anbefaling per scenario, de tre laveste først.
  const forbedringer = [...new Map(
    res
      .filter((x) => x.vurdering?.forbedring)
      .sort((a, b) => (a.vurdering!.naturlig_norsk + a.vurdering!.effektivitet) - (b.vurdering!.naturlig_norsk + b.vurdering!.effektivitet))
      .map((x) => [x.scenario, tilKunde(forsteSetning(x.vurdering!.forbedring!))] as const),
  ).values()].slice(0, 3);

  const dato = new Date(r.kjort).toLocaleDateString("nb-NO", { day: "numeric", month: "long", year: "numeric" });
  const fliser = [
    [`${r.oppsummering.bestatt} av ${r.oppsummering.totalt}`, "testsamtaler bestått"],
    [`${fmt(snitt("oppgave_lost"))} / 5`, "løste oppgaven"],
    [`${fmt(snitt("naturlig_norsk"))} / 5`, "naturlig norsk"],
    [`${fmt(r.oppsummering.latens_p50_ms / 1000)} s`, "typisk svartid"],
    ...(o.kostPerSamtale ? [[`${fmt(o.kostPerSamtale, 2)} kr`, "per samtale"]] : []),
  ];

  return `<!doctype html>
<html lang="nb"><head><meta charset="utf-8"><title>Kvalitetsrapport ${esc(o.virksomhet)}</title>
<style>
  @page { size: A4; margin: 16mm 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #14171c; margin: 0; background: #fff; }
  .topp { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #1f3a5f; padding-bottom: 8px; }
  h1 { font-size: 20pt; margin: 0; color: #1f3a5f; letter-spacing: -0.01em; }
  .under { color: #5d6673; margin: 2px 0 0; }
  .merke { font-size: 8.5pt; color: #b25e00; background: #fff1de; border-radius: 99px; padding: 3px 10px; white-space: nowrap; }
  .fliser { display: grid; grid-template-columns: repeat(${fliser.length}, 1fr); gap: 8px; margin: 14px 0 6px; }
  .flis { background: #f3f6fa; border-radius: 10px; padding: 10px 12px; }
  .flis b { display: block; font-size: 16pt; color: #1f3a5f; }
  .flis span { color: #5d6673; font-size: 9pt; }
  h2 { font-size: 11.5pt; color: #1f3a5f; margin: 16px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 0; border-bottom: 1px solid #e2e5ea; vertical-align: top; }
  td.tall { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: 70px; }
  .ok { color: #138a4e; font-weight: 600; }
  .ikke { color: #c22f2f; font-weight: 600; }
  .to { display: grid; grid-template-columns: 1.15fr 1fr; gap: 22px; }
  ol { margin: 0; padding-left: 18px; } li { margin-bottom: 6px; }
  .fot { margin-top: 16px; padding-top: 8px; border-top: 1px solid #e2e5ea; color: #5d6673; font-size: 8.5pt; }
</style></head><body>
<div class="topp">
  <div><h1>Kvalitetsrapport</h1><p class="under">${esc(o.virksomhet)} · telefonagent · ${dato}</p></div>
  ${o.testdata ? `<span class="merke">Simulerte testsamtaler</span>` : ""}
</div>
<div class="fliser">${fliser.map(([b, s]) => `<div class="flis"><b>${b}</b><span>${s}</span></div>`).join("")}</div>
<div class="to">
  <div>
    <h2>Dette ble testet</h2>
    <table>${[...scenarier.values()].map((s) => `<tr><td>${esc(s.tittel)}</td><td class="tall ${s.bestatt === s.totalt ? "ok" : "ikke"}">${s.bestatt} av ${s.totalt}</td></tr>`).join("")}</table>
  </div>
  <div>
    <h2>Sikkerhet og regler</h2>
    <table>${sjekkRader.map((s) => `<tr><td>${s.tekst}</td><td class="tall ${s.ok === s.totalt ? "ok" : "ikke"}">${s.ok} av ${s.totalt}</td></tr>`).join("")}</table>
  </div>
</div>
<h2>Neste uke skal vi</h2>
<ol>${forbedringer.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>
<p class="fot">${o.testdata
    ? `Grunnlag: ${res.length} simulerte samtaler der en KI spiller vanskelige innringere, ${scenarier.size} scenarier kjørt ${Math.round(res.length / Math.max(1, scenarier.size))} ganger hver. Hver samtale er sjekket automatisk og vurdert av en KI-dommer. I drift lages samme rapport fra ekte samtaler hver uke.`
    : `Grunnlag: ${res.length} samtaler. Hver samtale er sjekket automatisk og vurdert av en KI-dommer.`} Modell: ${esc(r.modell)}.</p>
</body></html>`;
}
