/**
 * Henter en nettside brukeren har limt inn, uten å la serveren bli et
 * springbrett inn i vårt eget nettverk (SSRF).
 *
 * - bare http/https, ingen brukernavn/passord i URL-en, bare port 80/443
 * - DNS slås opp én gang, alle svar sjekkes, og tilkoblingen låses til den
 *   sjekkede adressen (ingen DNS rebinding mellom sjekk og bruk)
 * - hver omdirigering sjekkes på nytt, maks tre
 * - tidsavbrudd og størrelsesgrense, og bare HTML/tekst godtas
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export type HentFeilKode = "UGYLDIG_URL" | "BLOKKERT" | "FOR_STOR" | "TIDSAVBRUDD" | "FEIL_TYPE" | "HTTP_FEIL" | "FOR_MANGE_OMDIRIGERINGER";

export class HentFeil extends Error {
  constructor(public kode: HentFeilKode, melding: string) {
    super(melding);
  }
}

function ipv4TilTall(ip: string): number {
  return ip.split(".").reduce((s, o) => s * 256 + Number(o), 0);
}

const PRIVATE_V4: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** Sann for alt som ikke er en vanlig offentlig adresse på internett. */
export function erPrivatAdresse(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4TilTall(ip);
    return PRIVATE_V4.some(([nett, bits]) => {
      const maske = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & maske) >>> 0 === (ipv4TilTall(nett) & maske) >>> 0;
    });
  }
  if (net.isIPv6(ip)) {
    const lav = ip.toLowerCase();
    // IPv4 pakket inn i IPv6 (::ffff:10.0.0.1, 64:ff9b::10.0.0.1) sjekkes som IPv4.
    const innpakket = lav.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (innpakket) return erPrivatAdresse(innpakket[1]!);
    const hex = lav.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const a = parseInt(hex[1]!, 16), b = parseInt(hex[2]!, 16);
      return erPrivatAdresse(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    return (
      lav === "::" || lav === "::1" ||
      /^f[cd]/.test(lav) || // unik lokal fc00::/7
      /^fe[89ab]/.test(lav) || // link-lokal fe80::/10
      /^ff/.test(lav) || // multicast
      lav.startsWith("2001:db8") // dokumentasjon
    );
  }
  return true; // ukjent format: blokker
}

export interface HentOptions {
  timeoutMs?: number;
  maksBytes?: number;
  maksOmdirigeringer?: number;
  /** For tester: overstyr hvilke adresser og porter som er lov. */
  erTillatt?: (ip: string) => boolean;
  tillattePorter?: number[];
}

export interface HentResultat {
  url: string;
  status: number;
  innhold: string;
  contentType: string;
}

export function sjekkUrl(raw: string, tillattePorter = [80, 443]): URL {
  let url: URL;
  const tekst = raw.trim();
  // «file:», «javascript:», «gopher:» osv. Et punktum før kolon betyr vertsnavn med port.
  const skjema = tekst.match(/^([a-z][a-z0-9+-]*):/i)?.[1];
  if (skjema && !/^https?$/i.test(skjema)) throw new HentFeil("UGYLDIG_URL", "Bare http og https er lov.");
  try {
    url = new URL(skjema ? tekst : `https://${tekst}`);
  } catch {
    throw new HentFeil("UGYLDIG_URL", "Det ser ikke ut som en nettadresse.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HentFeil("UGYLDIG_URL", "Bare http og https er lov.");
  if (url.username || url.password) throw new HentFeil("UGYLDIG_URL", "Nettadressen kan ikke inneholde brukernavn eller passord.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!tillattePorter.includes(port)) throw new HentFeil("BLOKKERT", "Bare vanlige nettporter er lov.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new HentFeil("BLOKKERT", "Den adressen er ikke offentlig.");
  }
  return url;
}

/** DNS-oppslag som avviser private adresser. Brukes som `lookup` i selve tilkoblingen. */
function trygtOppslag(erTillatt: (ip: string) => boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, adresser) => {
      if (err) return callback(err, "", 0);
      const liste = adresser as dns.LookupAddress[];
      const blokkert = liste.find((a) => !erTillatt(a.address));
      if (!liste.length || blokkert) {
        return callback(new HentFeil("BLOKKERT", "Den adressen er ikke offentlig."), "", 0);
      }
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, liste);
      callback(null, liste[0]!.address, liste[0]!.family);
    });
  };
}

function enForesporsel(url: URL, o: Required<HentOptions>): Promise<{ status: number; headers: http.IncomingHttpHeaders; innhold: string }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // IP-litteraler går ikke via DNS, så de sjekkes her.
    if (net.isIP(host) && !o.erTillatt(host)) return reject(new HentFeil("BLOKKERT", "Den adressen er ikke offentlig."));
    const modul = url.protocol === "https:" ? https : http;
    const req = modul.request(
      url,
      {
        method: "GET",
        lookup: trygtOppslag(o.erTillatt),
        headers: { "user-agent": "agent-kvalitetsvakt/0.1 (+demo)", accept: "text/html,text/plain;q=0.9" },
        timeout: o.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, headers: res.headers, innhold: "" });
        }
        const type = String(res.headers["content-type"] ?? "");
        if (status === 200 && !/text\/html|text\/plain|application\/xhtml/.test(type)) {
          res.destroy();
          return reject(new HentFeil("FEIL_TYPE", "Siden er ikke HTML."));
        }
        let lest = 0;
        const biter: Buffer[] = [];
        res.on("data", (b: Buffer) => {
          lest += b.length;
          if (lest > o.maksBytes) {
            res.destroy();
            reject(new HentFeil("FOR_STOR", "Siden er for stor."));
            return;
          }
          biter.push(b);
        });
        res.on("end", () => resolve({ status, headers: res.headers, innhold: Buffer.concat(biter).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new HentFeil("TIDSAVBRUDD", "Siden svarte ikke i tide.")));
    req.on("error", (e) => reject(e instanceof HentFeil ? e : new HentFeil("HTTP_FEIL", "Fikk ikke kontakt med siden.")));
    req.end();
  });
}

export async function trygHent(raw: string, opts: HentOptions = {}): Promise<HentResultat> {
  const o: Required<HentOptions> = {
    timeoutMs: opts.timeoutMs ?? 6000,
    maksBytes: opts.maksBytes ?? 1_500_000,
    maksOmdirigeringer: opts.maksOmdirigeringer ?? 3,
    erTillatt: opts.erTillatt ?? ((ip) => !erPrivatAdresse(ip)),
    tillattePorter: opts.tillattePorter ?? [80, 443],
  };
  let url = sjekkUrl(raw, o.tillattePorter);
  for (let i = 0; i <= o.maksOmdirigeringer; i++) {
    const svar = await enForesporsel(url, o);
    if (svar.status >= 300 && svar.status < 400) {
      const til = svar.headers.location;
      if (!til) throw new HentFeil("HTTP_FEIL", "Omdirigering uten mål.");
      url = sjekkUrl(new URL(til, url).toString(), o.tillattePorter);
      continue;
    }
    if (svar.status !== 200) throw new HentFeil("HTTP_FEIL", `Siden svarte ${svar.status}.`);
    return { url: url.toString(), status: svar.status, innhold: svar.innhold, contentType: String(svar.headers["content-type"] ?? "") };
  }
  throw new HentFeil("FOR_MANGE_OMDIRIGERINGER", "For mange omdirigeringer.");
}
