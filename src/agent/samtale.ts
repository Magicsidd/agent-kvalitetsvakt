/**
 * Én telefonsamtale: historikk, verktøyløkke, måling og logging.
 *
 * Løkken er skrevet for hånd i stedet for SDK-ens tool runner fordi vi
 * trenger kontroll per runde: måle latens for modell og verktøy hver for seg,
 * strømme tekst til talesyntesen mens modellen skriver, og stoppe straks
 * agenten setter over eller legger på.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.ts";
import { Kunnskapsbase } from "../kunnskap/sok.ts";
import { BookingAdapter, normaliserTelefon, type AdapterHendelse } from "../integrasjon/bookingAdapter.ts";
import { lesbarDato, osloNaa } from "../tid.ts";
import { TANNKLINIKK, dynamiskPrompt, type AgentProfil } from "./prompt.ts";
import { kjorVerktoy, verktoyFor, type Beskjed } from "./verktoy.ts";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type CreateParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

/** Det samtalen trenger fra en modell. Gjør det mulig å teste uten API-nøkkel. */
export interface LlmKlient {
  lag(params: CreateParams, onTekst?: (delta: string) => void): Promise<BetaMessage>;
}

export function anthropicKlient(client = new Anthropic()): LlmKlient {
  return {
    async lag(params, onTekst) {
      const stream = client.beta.messages.stream(params);
      if (onTekst) stream.on("text", onTekst);
      return stream.finalMessage();
    },
  };
}

export interface VerktoyKall {
  navn: string;
  input: unknown;
  resultat: string;
  feil: boolean;
  ms: number;
}

export interface Tur {
  rolle: "innringer" | "agent";
  tekst: string;
  tidspunkt: string;
  verktoy?: VerktoyKall[];
  maling?: { totalMs: number; modellMs: number; verktoyMs: number; runder: number; forsteTekstMs: number | null };
  forbruk?: { input: number; output: number; cacheLest: number };
}

export type Status = "aktiv" | "overfort" | "avsluttet";

export type SamtaleHendelse =
  | { type: "tekst_delta"; delta: string }
  | { type: "verktoy"; kall: VerktoyKall }
  | { type: "adapter"; hendelse: AdapterHendelse }
  | { type: "tur"; tur: Tur }
  | { type: "status"; status: Status; oppsummering?: string }
  | { type: "beskjed"; beskjed: Beskjed };

export interface SamtaleOptions {
  llm: LlmKlient;
  /** Kreves bare for profiler med booking. */
  legacyUrl?: string;
  profil?: AgentProfil;
  kb?: Kunnskapsbase;
  now?: () => Date;
  onHendelse?: (h: SamtaleHendelse) => void;
  id?: string;
  /** Nummeret det ringes fra (ANI), hvis telefonnettet gir det. */
  innringerNummer?: string;
}

const MAKS_RUNDER = 8;

export class Samtale {
  readonly id: string;
  readonly startet = new Date().toISOString();
  turer: Tur[] = [];
  status: Status = "aktiv";
  overforingsnotat?: string;
  beskjeder: Beskjed[] = [];
  /** Risikoflagg satt av overvåkingen (serveren), lagres med samtalen. */
  flagg: { tur: number; kode: string; alvor: string; tekst: string }[] = [];
  readonly profil: AgentProfil;
  private historikk: BetaMessageParam[] = [];
  private ventendeHvisk: string[] = [];
  private adapter?: BookingAdapter;
  private kb: Kunnskapsbase;
  private now: () => Date;
  private innringerNummer?: string;

  constructor(private opts: SamtaleOptions) {
    this.id = opts.id ?? `samtale-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.now = opts.now ?? osloNaa;
    this.kb = opts.kb ?? Kunnskapsbase.fraFil();
    try {
      this.innringerNummer = opts.innringerNummer ? normaliserTelefon(opts.innringerNummer) : undefined;
    } catch {
      this.innringerNummer = undefined; // skjult eller utenlandsk nummer
    }
    this.profil = opts.profil ?? TANNKLINIKK;
    if (opts.legacyUrl) {
      this.adapter = new BookingAdapter({
        baseUrl: opts.legacyUrl,
        now: this.now,
        onHendelse: (hendelse) => opts.onHendelse?.({ type: "adapter", hendelse }),
      });
    }
  }

  /** Første replikk. Fast tekst: raskere og billigere enn å la modellen hilse. */
  hilsen(): Tur {
    const tur: Tur = { rolle: "agent", tekst: this.profil.hilsen, tidspunkt: new Date().toISOString() };
    this.turer.push(tur);
    this.opts.onHendelse?.({ type: "tur", tur });
    return tur;
  }

  private params(): CreateParams {
    const naa = this.now();
    return {
      model: config.model,
      max_tokens: 4000,
      output_config: { effort: config.effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: this.profil.stabilPrompt, cache_control: { type: "ephemeral" } },
        { type: "text", text: dynamiskPrompt(lesbarDato(naa), naa.toISOString().slice(11, 16), this.innringerNummer) },
      ],
      tools: verktoyFor(this.profil.verktoy),
      messages: this.historikk,
    };
  }

  /**
   * En ansatt som følger samtalen live kan gi agenten en instruks. Den går
   * som systemmelding midt i samtalen (operatørkanalen), ikke som brukertekst,
   * så den har riktig autoritet og innringeren ser den aldri.
   */
  hvisk(tekst: string) {
    this.ventendeHvisk.push(tekst.slice(0, 500));
  }

  async svar(innringerTekst: string): Promise<Tur> {
    if (this.status !== "aktiv") throw new Error(`Samtalen er ${this.status}.`);
    const innringerTur: Tur = { rolle: "innringer", tekst: innringerTekst, tidspunkt: new Date().toISOString() };
    this.turer.push(innringerTur);
    this.opts.onHendelse?.({ type: "tur", tur: innringerTur });

    // Hilsenen er ikke generert av modellen, men den skal vite at den er sagt.
    if (this.historikk.length === 0) {
      this.historikk.push({ role: "user", content: `[Samtalen startet. Du har allerede sagt: «${this.profil.hilsen}»]\n\n${innringerTekst}` });
    } else {
      this.historikk.push({ role: "user", content: innringerTekst });
    }
    // Systemmeldingen må komme rett etter en brukermelding; modellen svarer rett etter.
    for (const h of this.ventendeHvisk.splice(0)) {
      this.historikk.push({ role: "system", content: `Instruks fra en ansatt som følger samtalen (innringeren ser ikke dette): ${h}` });
    }

    const t0 = performance.now();
    let modellMs = 0, verktoyMs = 0, runder = 0;
    let forsteTekstMs: number | null = null;
    const tekster: string[] = [];
    const kall: VerktoyKall[] = [];
    const forbruk = { input: 0, output: 0, cacheLest: 0 };

    while (runder < MAKS_RUNDER) {
      runder++;
      const m0 = performance.now();
      const melding = await this.opts.llm.lag(this.params(), (delta) => {
        forsteTekstMs ??= Math.round(performance.now() - t0);
        this.opts.onHendelse?.({ type: "tekst_delta", delta });
      });
      modellMs += performance.now() - m0;
      forbruk.input += melding.usage.input_tokens;
      forbruk.output += melding.usage.output_tokens;
      forbruk.cacheLest += melding.usage.cache_read_input_tokens ?? 0;

      if (melding.stop_reason === "refusal") {
        tekster.push("Beklager, det kan jeg ikke hjelpe med. Skal jeg sette deg over til en av de ansatte?");
        // Den avviste turen skal ikke inn i historikken; vi legger inn vårt eget svar.
        this.historikk.push({ role: "assistant", content: tekster.at(-1)! });
        break;
      }

      // Hele innholdet tilbake, uendret: tenkeblokker må følge med.
      this.historikk.push({ role: "assistant", content: melding.content });
      // Turen lagres slik den blir sagt, så logg, dashbord og eval ser det innringeren hører.
      for (const b of melding.content) if (b.type === "text" && tilTale(b.text)) tekster.push(tilTale(b.text));

      const bruk = melding.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (melding.stop_reason !== "tool_use" || bruk.length === 0) break;

      const v0 = performance.now();
      const resultater = await Promise.all(
        bruk.map(async (b) => {
          const s = performance.now();
          const r = await kjorVerktoy(b.name, b.input, {
            adapter: this.adapter,
            kb: this.kb,
            tillatt: this.profil.verktoy,
            innringerNummer: this.innringerNummer,
            onBeskjed: (beskjed) => {
              this.beskjeder.push(beskjed);
              this.opts.onHendelse?.({ type: "beskjed", beskjed });
            },
          });
          const k: VerktoyKall = { navn: b.name, input: b.input, resultat: r.innhold, feil: r.feil, ms: Math.round(performance.now() - s) };
          kall.push(k);
          this.opts.onHendelse?.({ type: "verktoy", kall: k });
          if (r.slutt) {
            this.status = r.slutt;
            if (r.slutt === "overfort") this.overforingsnotat = (b.input as { oppsummering?: string }).oppsummering;
          }
          return { type: "tool_result" as const, tool_use_id: b.id, content: r.innhold, is_error: r.feil };
        }),
      );
      verktoyMs += performance.now() - v0;
      // Alle resultater i én melding, så modellen fortsetter å kalle verktøy parallelt.
      this.historikk.push({ role: "user", content: resultater });
      if (this.status !== "aktiv") break;
    }

    // TypeScript har snevret inn status til «aktiv» over; verktøyene kan ha endret den.
    const status = this.status as Status;
    if (tekster.length === 0) {
      tekster.push(status === "overfort" ? "Et øyeblikk, jeg setter deg over til en av de ansatte." : "Beklager, kan du si det en gang til?");
    }

    const tur: Tur = {
      rolle: "agent",
      tekst: tekster.join(" "),
      tidspunkt: new Date().toISOString(),
      verktoy: kall,
      maling: {
        totalMs: Math.round(performance.now() - t0),
        modellMs: Math.round(modellMs),
        verktoyMs: Math.round(verktoyMs),
        runder,
        forsteTekstMs,
      },
      forbruk,
    };
    this.turer.push(tur);
    this.opts.onHendelse?.({ type: "tur", tur });
    if (status !== "aktiv") this.opts.onHendelse?.({ type: "status", status, oppsummering: this.overforingsnotat });
    return tur;
  }

  tilJSON() {
    return {
      id: this.id,
      startet: this.startet,
      profil: { id: this.profil.id, navn: this.profil.navn },
      status: this.status,
      overforingsnotat: this.overforingsnotat,
      beskjeder: this.beskjeder,
      flagg: this.flagg,
      turer: this.turer,
    };
  }
}

/** Rydder bort det talesyntese ikke skal lese opp, i tilfelle modellen glipper. */
export function tilTale(tekst: string): string {
  return tekst.replace(/[*_#`>]/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
}
