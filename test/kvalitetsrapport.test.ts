import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lagKvalitetsrapport, type EvalRapport } from "../src/innsikt/kvalitetsrapport.ts";

test("kvalitetsrapport fra en ekte eval-kjøring", () => {
  const r = JSON.parse(readFileSync("docs/eval/2026-10-21-etter-rettelser.json", "utf8")) as EvalRapport;
  const html = lagKvalitetsrapport(r, { virksomhet: "Nordstjerna <Tannklinikk>", kostPerSamtale: 0.5, testdata: true });
  assert.match(html, /24 av 24/);
  assert.match(html, /Sa fra at den er en KI<\/td><td class="tall ok">24 av 24/);
  assert.match(html, /Simulerte testsamtaler/);
  assert.match(html, /Nordstjerna &lt;Tannklinikk&gt;/);
  assert.doesNotMatch(html, /prompten/i);
});
