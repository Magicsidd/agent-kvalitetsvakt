/**
 * Oppsummering etter samtalen: det kunden og bedriften trenger når
 * samtalen er over. Strukturert, så det kan gå rett i CRM, SMS eller e-post.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.ts";
import type { Tur } from "../agent/samtale.ts";
import { transkripsjon } from "./transkripsjon.ts";

export const Oppsummering = z.object({
  kort: z.string().describe("Én til to setninger: hva samtalen handlet om og hvordan den endte."),
  utfall: z.enum(["løst", "delvis løst", "ikke løst", "satt over"]),
  neste_steg: z.array(z.string()).describe("Konkrete oppgaver for bedriften etter samtalen. Tom liste hvis ingen."),
  sms_til_innringer: z.string().describe("Kort bekreftelses-SMS til innringeren på norsk, maks 300 tegn. Tom streng hvis ikke relevant."),
  ubesvarte_sporsmal: z.array(z.string()).describe("Spørsmål agenten ikke kunne svare på."),
  kunnskapshull: z
    .array(z.object({ sporsmal: z.string(), foreslatt_tekst: z.string().describe("Forslag til tekst bedriften kan legge i kunnskapsbasen.") }))
    .describe("Hull i kunnskapsbasen samtalen avslørte."),
  stemning: z.enum(["fornøyd", "nøytral", "misfornøyd"]),
});
export type Oppsummering = z.infer<typeof Oppsummering>;

const INSTRUKS = `Du lager oppsummeringer av telefonsamtaler mellom en KI-telefonassistent og en innringer, for bedriften som eier assistenten.
Skriv kort, konkret og på norsk bokmål. Ikke dikt opp noe som ikke står i samtalen. Ta ikke med fødselsnummer eller andre sensitive opplysninger i SMS-en.`;

export async function oppsummer(virksomhet: string, turer: Tur[], client = new Anthropic()): Promise<Oppsummering | null> {
  const svar = await client.beta.messages.parse({
    model: config.model,
    max_tokens: 4000,
    output_config: { effort: "low", format: betaZodOutputFormat(Oppsummering) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: INSTRUKS,
    messages: [{ role: "user", content: `Virksomhet: ${virksomhet}\n\nSamtale:\n${transkripsjon(turer)}` }],
  });
  if (svar.stop_reason === "refusal") return null;
  return svar.parsed_output ?? null;
}
