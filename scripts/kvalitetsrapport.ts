/**
 * Lager kvalitetsrapporten (HTML og PDF) fra en eval-kjøring.
 *
 *   npm run rapport                                  siste kjøring i docs/eval
 *   npm run rapport -- data/evals/<fil>.json         en bestemt kjøring
 *
 * PDF krever Chrome eller Chromium (CHROMIUM_PATH=...).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { lagKvalitetsrapport, type EvalRapport } from "../src/innsikt/kvalitetsrapport.ts";

const fil = process.argv[2] ?? "docs/eval/2026-10-21-etter-rettelser.json";
const rapport = JSON.parse(readFileSync(fil, "utf8")) as EvalRapport;
// Kost for agentdelen, målt fra tokenbruken (se docs/eval/README.md).
const html = lagKvalitetsrapport(rapport, { virksomhet: "Nordstjerna Tannklinikk", kostPerSamtale: 0.5, testdata: true });
writeFileSync("docs/kvalitetsrapport.html", html);

const chrome = process.env.CHROMIUM_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const nettleser = await chromium.launch({ executablePath: chrome });
try {
  const side = await nettleser.newPage();
  await side.setContent(html, { waitUntil: "load" });
  await side.pdf({ path: "docs/kvalitetsrapport.pdf", format: "A4", printBackground: true, preferCSSPageSize: true });
} finally {
  await nettleser.close();
}
console.log("Skrevet docs/kvalitetsrapport.html og docs/kvalitetsrapport.pdf");
