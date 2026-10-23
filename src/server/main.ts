/**
 * Én prosess med alt som trengs for demoen:
 *   /                        ring agenten fra nettleseren (tannklinikk eller din egen nettside)
 *   /dashbord                live overvåking, samtaler og kvalitetsvakt
 *   /ws                      WebSocket for én samtale (?mal=<id> for nettsideagent)
 *   /ws/live                 hendelser og risikoflagg fra alle aktive samtaler
 *   /vapi/chat/completions   «Custom LLM»-endepunkt for Vapi (OpenAI-format)
 *   /api/...                 JSON for klient og dashbord
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "../config.ts";
import { Samtale, tilTale, type LlmKlient, type SamtaleHendelse } from "../agent/samtale.ts";
import { nettsideProfil, type AgentProfil } from "../agent/prompt.ts";
import { startLegacyServer } from "../integrasjon/legacyServer.ts";
import { Kunnskapsbase } from "../kunnskap/sok.ts";
import { kunnskapFraNettside } from "../nettside/fraNettside.ts";
import { HentFeil, type HentOptions } from "../nettside/trygHent.ts";
import { flaggForTur } from "../innsikt/risiko.ts";
import { oppsummer } from "../innsikt/oppsummering.ts";
import { helligdager, vurderRingetid } from "../compliance/ringetid.ts";
import { lagSamtaleLogg } from "./logg.ts";
import { lagRatebegrenser } from "./ratebegrenser.ts";
import { haandterVapi } from "./vapi.ts";
import type { LagTale } from "../tale/elevenlabs.ts";
import { lagLeadLager, validerLead, type LeadInn } from "../innsikt/leads.ts";

const PUBLIC = new URL("../../public/", import.meta.url).pathname;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/** Det vi anbefaler andre, gjør vi selv. CSP-en håndheves, den rapporterer ikke bare. */
const SIKKERHETSHEADERE = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "microphone=(self), camera=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
};

export interface ServerOptions {
  llm: LlmKlient;
  port: number;
  legacyPort: number;
  dataDir: string;
  dashbordToken?: string;
  /** For tester: lar nettsidehenting nå en lokal testserver. */
  hentOptions?: HentOptions;
  /** For tester: erstatter Claude-kallet som lager oppsummeringen. */
  oppsummer?: typeof oppsummer;
  /** Talesyntese på serveren. Uten den leser nettleseren opp selv. */
  lagTale?: LagTale;
}

export async function startServer(o: ServerOptions): Promise<{ url: string; legacyUrl: string; close: () => Promise<void> }> {
  mkdirSync(o.dataDir, { recursive: true });
  const legacy = await startLegacyServer(o.legacyPort, {
    seed: 1,
    seedBookings: [{ dato: "28.10.2026", kl: "1030", type: "R", navn: "Lise Berg", tlf: "92233444" }],
  });
  const kb = Kunnskapsbase.fraFil();
  const llm = o.llm;
  const logg = lagSamtaleLogg(`${o.dataDir}/samtaler`);
  const leads = lagLeadLager(o.dataDir);
  const liveKlienter = new Set<WebSocket>();
  const aktive = new Map<string, Samtale>();

  /** Agenter laget fra nettsider. I minnet: en demo trenger ikke lagre dem. */
  const maler = new Map<string, { profil: AgentProfil; kb: Kunnskapsbase; sider: string[]; laget: number }>();
  const nettsideGrense = lagRatebegrenser(5, 10 * 60_000);
  const taleGrense = lagRatebegrenser(120, 10 * 60_000);
  const leadGrense = lagRatebegrenser(5, 10 * 60_000);
  const oppsummeringsGrense = lagRatebegrenser(20, 10 * 60_000);
  const samtaleGrense = lagRatebegrenser(30, 10 * 60_000);

  function kringkast(data: Record<string, unknown>) {
    const melding = JSON.stringify(data);
    for (const ws of liveKlienter) if (ws.readyState === ws.OPEN) ws.send(melding);
  }

  function nySamtale(
    innringerNummer: string | undefined,
    sink: (h: SamtaleHendelse) => void,
    id?: string,
    mal?: { profil: AgentProfil; kb: Kunnskapsbase },
  ): Samtale {
    const samtale: Samtale = new Samtale({
      llm,
      legacyUrl: mal ? undefined : legacy.url,
      profil: mal?.profil,
      kb: mal?.kb ?? kb,
      innringerNummer,
      id,
      onHendelse: (h) => {
        sink(h);
        if (h.type === "tekst_delta") return;
        kringkast({ samtaleId: samtale.id, profil: samtale.profil.navn, ...h });
        if (h.type === "tur") {
          for (const f of flaggForTur(h.tur)) {
            const flagg = { tur: samtale.turer.length - 1, ...f };
            samtale.flagg.push(flagg);
            kringkast({ samtaleId: samtale.id, type: "flagg", flagg });
          }
        }
        if (h.type === "tur" || h.type === "status") logg.lagre(samtale);
        if (h.type === "status" && h.status !== "aktiv") aktive.delete(samtale.id);
      },
    });
    aktive.set(samtale.id, samtale);
    kringkast({ samtaleId: samtale.id, profil: samtale.profil.navn, type: "status", status: "aktiv" });
    return samtale;
  }

  function json(res: http.ServerResponse, data: unknown, status = 200) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(data));
  }

  async function lesJson(req: http.IncomingMessage, maksBytes = 10_000): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > maksBytes) throw new Error("for stor");
    }
    return raw ? JSON.parse(raw) : {};
  }

  const harDashbordTilgang = (url: URL) => !o.dashbordToken || url.searchParams.get("token") === o.dashbordToken;

  const klientIp = (req: http.IncomingMessage) => req.socket.remoteAddress ?? "ukjent";

  function lesEvals() {
    const dir = `${o.dataDir}/evals`;
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((fil) => {
        const d = JSON.parse(readFileSync(join(dir, fil), "utf8"));
        return { fil, kjort: d.kjort, modell: d.modell, effort: d.effort, ustabil: d.ustabil, merknad: d.merknad, oppsummering: d.oppsummering };
      });
  }

  const trygtFilnavn = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "");

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SIKKERHETSHEADERE)) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://localhost");
    const sti = url.pathname;

    try {
      if (sti.startsWith("/vapi/")) return await haandterVapi(req, res, nySamtale);
      if ((/^\/api\/(samtaler|aktive|evals|bookinger)/.test(sti) || (sti === "/api/leads" && req.method !== "POST")) && !harDashbordTilgang(url)) return json(res, { feil: "mangler token" }, 401);

      if (sti === "/api/agent-fra-url" && req.method === "POST") {
        if (!nettsideGrense.tillat(klientIp(req))) return json(res, { feil: "For mange forsøk. Prøv igjen om litt." }, 429);
        const body = await lesJson(req);
        if (typeof body.url !== "string" || body.url.length > 500) return json(res, { feil: "Mangler nettadresse." }, 400);
        try {
          const k = await kunnskapFraNettside(body.url, o.hentOptions);
          const id = randomUUID();
          maler.set(id, { profil: nettsideProfil(k.virksomhet, k.beskrivelse), kb: k.kb, sider: k.sider, laget: Date.now() });
          // Rydd bort gamle maler så minnet ikke vokser.
          for (const [mid, m] of maler) if (Date.now() - m.laget > 3_600_000) maler.delete(mid);
          return json(res, { mal: id, virksomhet: k.virksomhet, sider: k.sider, avsnitt: k.markdown.split("\n## ").length });
        } catch (e) {
          if (e instanceof HentFeil) return json(res, { feil: e.message, kode: e.kode }, 422);
          throw e;
        }
      }

      if (sti === "/api/samtaler") return json(res, logg.liste());
      const oppsummeringMatch = sti.match(/^\/api\/samtaler\/([^/]+)\/oppsummering$/);
      if (oppsummeringMatch && req.method === "POST") {
        const id = decodeURIComponent(oppsummeringMatch[1]!);
        const lagret = logg.hent(id);
        if (!lagret) return json(res, { feil: "ikke funnet" }, 404);
        if (lagret.oppsummering) return json(res, lagret.oppsummering);
        if (!oppsummeringsGrense.tillat(klientIp(req))) return json(res, { feil: "For mange forespørsler." }, 429);
        const resultat = await (o.oppsummer ?? oppsummer)(lagret.profil?.navn ?? "virksomheten", lagret.turer).catch((e) => {
          console.error(e);
          return null;
        });
        if (!resultat) return json(res, { feil: "Kunne ikke lage oppsummering. Sjekk API-nøkkelen." }, 502);
        logg.oppdater(id, { oppsummering: resultat });
        return json(res, resultat);
      }
      if (sti.startsWith("/api/samtaler/")) {
        const s = logg.hent(decodeURIComponent(sti.split("/").pop()!));
        return s ? json(res, s) : json(res, { feil: "ikke funnet" }, 404);
      }
      if (sti === "/api/aktive") return json(res, [...aktive.values()].map((s) => s.tilJSON()));
      if (sti === "/api/evals") return json(res, lesEvals());
      if (sti.startsWith("/api/evals/")) {
        const fil = join(`${o.dataDir}/evals`, trygtFilnavn(decodeURIComponent(sti.split("/").pop()!)));
        return existsSync(fil) ? json(res, JSON.parse(readFileSync(fil, "utf8"))) : json(res, { feil: "ikke funnet" }, 404);
      }
      if (sti === "/api/bookinger") return json(res, [...legacy.state.bookings.values()]);
      if (sti === "/api/compliance/ringetid") {
        const tid = url.searchParams.get("tid") ?? "";
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(tid)) return json(res, { feil: "tid må være YYYY-MM-DDTHH:MM" }, 400);
        return json(res, vurderRingetid(new Date(`${tid}:00Z`)));
      }
      if (sti === "/api/compliance/helligdager") {
        const aar = Number(url.searchParams.get("aar") ?? new Date().getFullYear());
        if (!Number.isInteger(aar) || aar < 2000 || aar > 2100) return json(res, { feil: "ugyldig år" }, 400);
        return json(res, [...helligdager(aar)].map(([dato, navn]) => ({ dato, navn })).sort((a, b) => a.dato.localeCompare(b.dato)));
      }
      if (sti === "/favicon.ico") {
        res.writeHead(301, { location: "/ikon.svg" });
        return res.end();
      }
      if (sti === "/api/leads" && req.method === "POST") {
        if (!leadGrense.tillat(klientIp(req))) return json(res, { feil: "For mange forsøk. Prøv igjen om litt." }, 429);
        const body = await lesJson(req);
        const feil = validerLead(body);
        if (feil) return json(res, { feil }, 400);
        const samtale = logg.hent(String(body.samtaleId));
        if (!samtale) return json(res, { feil: "Fant ikke samtalen." }, 404);
        const lead = leads.legg(body as unknown as LeadInn, samtale);
        return json(res, { ok: true, navn: lead.navn });
      }
      if (sti === "/api/leads") return json(res, leads.liste());
      if (sti === "/api/tale" && req.method === "POST") {
        if (!o.lagTale) return json(res, { feil: "Talesyntese er ikke satt opp." }, 503);
        if (!taleGrense.tillat(klientIp(req))) return json(res, { feil: "For mange forsøk." }, 429);
        const body = await lesJson(req);
        if (typeof body.tekst !== "string" || !body.tekst.trim() || body.tekst.length > 600) return json(res, { feil: "Ugyldig tekst." }, 400);
        try {
          const lyd = await o.lagTale(body.tekst.trim());
          res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store" });
          return res.end(lyd);
        } catch (e) {
          console.error("Talesyntese feilet:", (e as Error).message);
          return json(res, { feil: "Talesyntese feilet." }, 502);
        }
      }
      if (sti === "/api/status") {
        return json(res, { modell: config.model, effort: config.effort, harNokkel: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), harTale: !!o.lagTale });
      }

      const fil = sti === "/" ? "index.html" : sti === "/dashbord" ? "dashbord.html" : normalize(sti).replace(/^[/\\]+/, "");
      const full = join(PUBLIC, fil);
      if (full.startsWith(PUBLIC) && existsSync(full) && !full.endsWith("/")) {
        res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
        return res.end(readFileSync(full));
      }
      json(res, { feil: "ikke funnet" }, 404);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, { feil: "intern feil" }, 500);
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_000 });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" && url.pathname !== "/ws/live") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === "/ws/live") {
        if (!harDashbordTilgang(url)) return ws.close(4401, "mangler token");
        liveKlienter.add(ws);
        ws.on("message", (raw) => {
          try {
            const m = JSON.parse(String(raw)) as { type?: string; samtaleId?: string; tekst?: string };
            const s = m.samtaleId ? aktive.get(m.samtaleId) : undefined;
            if (m.type === "hvisk" && s && m.tekst?.trim()) {
              s.hvisk(m.tekst.trim());
              kringkast({ samtaleId: s.id, type: "hvisk", tekst: m.tekst.trim().slice(0, 500) });
            }
          } catch {
            // ugyldig melding ignoreres
          }
        });
        ws.send(JSON.stringify({ type: "aktive", samtaler: [...aktive.values()].map((s) => s.tilJSON()) }));
        ws.on("close", () => liveKlienter.delete(ws));
        return;
      }
      const send = (data: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(data));
      if (!samtaleGrense.tillat(klientIp(req))) {
        send({ type: "feil", melding: "For mange samtaler på kort tid. Prøv igjen om litt." });
        return ws.close();
      }
      const malId = url.searchParams.get("mal");
      const mal = malId ? maler.get(malId) : undefined;
      if (malId && !mal) {
        send({ type: "feil", melding: "Fant ikke agenten. Lag den på nytt." });
        return ws.close();
      }
      const samtale = nySamtale(url.searchParams.get("nummer") ?? undefined, (h) => send(h), undefined, mal);
      send({ type: "start", id: samtale.id, profil: samtale.profil.navn });
      send({ type: "si", tekst: tilTale(samtale.hilsen().tekst) });

      let opptatt = false;
      ws.on("message", async (raw) => {
        let melding: { type?: string; tekst?: string };
        try {
          melding = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (melding.type === "legg_paa") {
          if (samtale.status === "aktiv") samtale.status = "avsluttet";
          aktive.delete(samtale.id);
          logg.lagre(samtale);
          kringkast({ samtaleId: samtale.id, type: "status", status: samtale.status });
          return;
        }
        if (melding.type !== "tekst" || !melding.tekst?.trim() || samtale.status !== "aktiv") return;
        if (opptatt) return send({ type: "opptatt" });
        opptatt = true;
        try {
          const tur = await samtale.svar(melding.tekst.trim().slice(0, 1000));
          send({ type: "si", tekst: tilTale(tur.tekst) });
        } catch (e) {
          console.error(e);
          send({ type: "feil", melding: "Agenten svarte ikke. Sjekk API-nøkkelen og serverloggen." });
        } finally {
          opptatt = false;
        }
      });
      ws.on("close", () => {
        if (samtale.status === "aktiv") samtale.status = "avsluttet";
        aktive.delete(samtale.id);
        logg.lagre(samtale);
        kringkast({ samtaleId: samtale.id, type: "status", status: samtale.status });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(o.port, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    legacyUrl: legacy.url,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await legacy.close();
    },
  };
}
