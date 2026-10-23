/**
 * Claude spiller innringeren. Den får en persona og ser bare det agenten sier,
 * akkurat som en ekte innringer.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import type { Tur } from "../agent/samtale.ts";

export const LEGGER_PA = "[LEGGER_PÅ]";

const INSTRUKS = `Du spiller en person som ringer en tannklinikk, for å teste klinikkens telefonresepsjonist. Hold deg i rollen hele tiden.

Regler:
- Svar som et menneske i telefonen: kort, muntlig norsk, gjerne bare noen få ord.
- Gi opplysninger når du blir spurt om dem, ikke alle på en gang.
- Ikke finn på ting som strider mot personaen din.
- Når målet ditt er nådd, eller samtalen tydelig er over, sier du ha det og skriver ${LEGGER_PA} til slutt. En time er først bestilt når resepsjonisten har sagt at den er booket.
- Skriv bare det du sier, ingen forklaringer eller regi.`;

export class InnringerSimulator {
  private client: Anthropic;

  constructor(private persona: string, client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  /** Neste replikk gitt samtalen så langt (sett fra innringerens side). */
  async neste(turer: Tur[]): Promise<string> {
    // Roller snus: agentens replikker er «user» for simulatoren.
    const messages: Anthropic.Beta.BetaMessageParam[] = turer.map((t) => ({
      role: t.rolle === "agent" ? "user" : "assistant",
      content: t.tekst,
    }));
    const svar = await this.client.beta.messages.create({
      model: config.simulatorModel,
      max_tokens: 2000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: `${INSTRUKS}\n\nDin persona:\n${this.persona}`,
      messages,
    });
    if (svar.stop_reason === "refusal") return `Ha det. ${LEGGER_PA}`;
    return svar.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
  }
}
