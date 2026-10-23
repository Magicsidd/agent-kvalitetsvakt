import type { Tur } from "../agent/samtale.ts";

/**
 * Samtalen som ren tekst for en modell, med verktøykall forkortet. Dommeren
 * trenger hele resultatet: ser den bare starten av en liste med ledige tider,
 * tror den at agenten dikter opp resten.
 */
export function transkripsjon(turer: Tur[], maksVerktoyTegn = 200): string {
  return turer
    .map((t) => {
      const verktoy = (t.verktoy ?? []).map((v) => `  [verktøy ${v.navn} -> ${v.resultat.slice(0, maksVerktoyTegn)}]`).join("\n");
      return `${t.rolle === "agent" ? "AGENT" : "INNRINGER"}: ${t.tekst}${verktoy ? `\n${verktoy}` : ""}`;
    })
    .join("\n");
}
