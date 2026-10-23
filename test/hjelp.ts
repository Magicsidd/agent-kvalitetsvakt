import type Anthropic from "@anthropic-ai/sdk";
import type { LlmKlient } from "../src/agent/samtale.ts";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;

export function melding(content: unknown[], stop_reason: string): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "test", content, stop_reason,
    stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

/**
 * En enkel falsk modell for server- og nettlesertester: søker i kunnskapsbasen
 * når innringeren spør om pris, og svarer ellers høflig. Husker alle kall.
 */
export function regelLlm() {
  const kall: Params[] = [];
  const llm: LlmKlient = {
    async lag(params, onTekst) {
      kall.push(structuredClone(params));
      const siste = params.messages.at(-1)!;
      const svar = (tekst: string) => {
        onTekst?.(tekst);
        return melding([{ type: "text", text: tekst }], "end_turn");
      };
      if (Array.isArray(siste.content) && siste.content[0]?.type === "tool_result") {
        return svar("Tannrens koster 850 kroner. Vil du bestille?");
      }
      const tekst = params.messages.filter((m) => m.role === "user").at(-1)?.content;
      if (typeof tekst === "string" && /pris|koster/i.test(tekst)) {
        return melding([{ type: "tool_use", id: `tu_${kall.length}`, name: "sok_kunnskap", input: { sporsmal: "pris tannrens" } }], "tool_use");
      }
      return svar("Det kan jeg hjelpe deg med.");
    },
  };
  return { llm, kall };
}
