/**
 * «Custom LLM»-endepunkt for Vapi. Vapi håndterer telefoni, tale-til-tekst og
 * talesyntese, og sender samtalen hit i OpenAI chat completions-format.
 * Vi bruker vår egen agent (med verktøy og bookingintegrasjon) og strømmer
 * teksten tilbake som SSE, så Vapi kan begynne å snakke før svaret er ferdig.
 *
 * Merk: formatet følger Vapis dokumentasjon for Custom LLM, men er ikke
 * testet mot en ekte Vapi-konto i denne repoen.
 */
import type http from "node:http";
import { config } from "../config.ts";
import { tilTale, type Samtale, type SamtaleHendelse } from "../agent/samtale.ts";

type NySamtale = (nummer: string | undefined, sink: (h: SamtaleHendelse) => void, id?: string) => Samtale;

interface VapiBody {
  messages?: { role: string; content: string | null }[];
  stream?: boolean;
  call?: { id?: string; customer?: { number?: string } };
}

// Én agent per Vapi-samtale. Vapi sender hele historikken hver gang, men
// agenten vår har sin egen (med verktøyresultater), så vi bruker bare siste replikk.
interface Aktiv {
  samtale: Samtale;
  /** Hvor tekstbitene skal sendes for forespørselen som pågår nå. */
  delta: (d: string) => void;
}
const aktive = new Map<string, Aktiv>();

export async function haandterVapi(req: http.IncomingMessage, res: http.ServerResponse, nySamtale: NySamtale) {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  // Lukket som standard: uten delt hemmelighet kunne hvem som helst bruke agenten på vår regning.
  if (!config.vapiSecret) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("VAPI_SECRET er ikke satt");
    return;
  }
  const auth = req.headers["x-vapi-secret"] ?? req.headers.authorization?.replace(/^Bearer /, "");
  if (auth !== config.vapiSecret) {
    res.writeHead(401).end();
    return;
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw) as VapiBody;
  const callId = body.call?.id ?? "vapi-ukjent";
  const sisteBruker = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content?.trim();

  let aktiv = aktive.get(callId);
  if (!aktiv) {
    const ny: Aktiv = { samtale: undefined as unknown as Samtale, delta: () => {} };
    ny.samtale = nySamtale(
      body.call?.customer?.number,
      (h) => h.type === "tekst_delta" && ny.delta(h.delta),
      `vapi-${callId.replace(/[^a-zA-Z0-9-]/g, "")}`,
    );
    // Vapi sier selv første replikk (firstMessage); vi registrerer den bare.
    ny.samtale.hilsen();
    aktive.set(callId, ny);
    aktiv = ny;
  }
  const { samtale } = aktiv;

  const id = `chatcmpl-${Date.now()}`;
  const chunk = (delta: Record<string, string>, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: config.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

  if (!sisteBruker || samtale.status !== "aktiv") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(chunk({ role: "assistant", content: "" }, "stop") + "data: [DONE]\n\n");
    return;
  }

  if (body.stream === false) {
    const tur = await samtale.svar(sisteBruker);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: config.model,
      choices: [{ index: 0, message: { role: "assistant", content: tilTale(tur.tekst) }, finish_reason: "stop" }],
    }));
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(chunk({ role: "assistant" }, null));
  let sendtNoe = false;
  aktiv.delta = (d) => {
    sendtNoe = true;
    res.write(chunk({ content: d.replace(/[*_#`]/g, "") }, null));
  };
  try {
    const tur = await samtale.svar(sisteBruker);
    // Modellen kan ha avsluttet med bare verktøykall; da sender vi den ferdige teksten.
    if (!sendtNoe) res.write(chunk({ content: tilTale(tur.tekst) }, null));
  } catch (e) {
    console.error(e);
    if (!sendtNoe) res.write(chunk({ content: "Beklager, det oppsto en feil. Prøv igjen om litt." }, null));
  } finally {
    aktiv.delta = () => {};
    res.end(chunk({}, "stop") + "data: [DONE]\n\n");
    if (samtale.status !== "aktiv") aktive.delete(callId);
  }
}
