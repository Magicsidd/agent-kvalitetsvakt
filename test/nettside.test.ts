import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { erPrivatAdresse, sjekkUrl, trygHent, HentFeil } from "../src/nettside/trygHent.ts";
import { kunnskapFraNettside, interneLenker } from "../src/nettside/fraNettside.ts";

let server: http.Server;
let port = 0;
const SIDER: Record<string, [number, string, Record<string, string>?]> = {
  "/": [200, `<html><head><title>Sykkelsmia AS | Kristiansand</title><meta name="description" content="Sykkelverksted i sentrum"></head>
    <body><nav><a href="/kontakt">Kontakt oss</a><a href="/priser">Priser</a><a href="https://annet.no/x">Ekstern</a></nav>
    <h1>Velkommen</h1><p>Vi reparerer alle typer sykler, også elsykler.</p><script>alert(1)</script></body></html>`],
  "/kontakt": [200, `<title>Kontakt</title><h2>Åpningstider</h2><p>Mandag til fredag 10&ndash;17, lørdag 10&#8211;14.</p>`],
  "/priser": [200, `<title>Priser</title><h2>Priser</h2><p>Service koster 790 kroner. Punktering 250 kroner.</p>`],
  "/til-metadata": [302, "", { location: "http://169.254.169.254/latest/meta-data/" }],
  "/til-localhost": [302, "", { location: "/kontakt" }],
  "/bilde": [200, "binær", { "content-type": "image/png" }],
  "/stor": [200, "x".repeat(50_000)],
};

before(async () => {
  server = http.createServer((req, res) => {
    const [status, body, headers] = SIDER[req.url ?? "/"] ?? [404, "nei"];
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

// Testserveren kjører på 127.0.0.1. Vi tillater akkurat den adressen og porten.
const test127 = { erTillatt: (ip: string) => ip === "127.0.0.1", tillattePorter: [80, 443, 0].map((p) => p || port) };
const opts = () => ({ ...test127, tillattePorter: [80, 443, port] });

test("kjenner igjen private og spesielle adresser", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.19", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "224.0.0.1"]) {
    assert.ok(erPrivatAdresse(ip), ip);
  }
  for (const ip of ["8.8.8.8", "185.199.108.153", "2606:4700::1111"]) assert.ok(!erPrivatAdresse(ip), ip);
});

test("avviser farlige URL-er før noe hentes", () => {
  for (const u of ["file:///etc/passwd", "ftp://x.no", "http://localhost/", "http://admin:pw@eksempel.no/", "http://eksempel.no:6379/", "http://db.internal/"]) {
    assert.throws(() => sjekkUrl(u), HentFeil, u);
  }
  assert.equal(sjekkUrl("eksempel.no").toString(), "https://eksempel.no/");
});

test("standardinnstillingene blokkerer localhost, også via IP", async () => {
  await assert.rejects(trygHent(`http://127.0.0.1:${port}/`, { tillattePorter: [port] }), (e: HentFeil) => e.kode === "BLOKKERT");
});

test("omdirigering til metadata-tjenesten blokkeres", async () => {
  await assert.rejects(trygHent(`http://127.0.0.1:${port}/til-metadata`, opts()), (e: HentFeil) => e.kode === "BLOKKERT");
});

test("godtar bare HTML og stopper store svar", async () => {
  await assert.rejects(trygHent(`http://127.0.0.1:${port}/bilde`, opts()), (e: HentFeil) => e.kode === "FEIL_TYPE");
  await assert.rejects(trygHent(`http://127.0.0.1:${port}/stor`, { ...opts(), maksBytes: 10_000 }), (e: HentFeil) => e.kode === "FOR_STOR");
});

test("finner bare interne lenker, de nyttigste først", () => {
  const lenker = interneLenker(SIDER["/"]![1], new URL(`http://127.0.0.1:${port}/`));
  assert.equal(lenker.length, 2);
  assert.ok(lenker.every((l) => l.includes("127.0.0.1")));
});

test("bygger kunnskapsbase fra forside og undersider", async () => {
  const k = await kunnskapFraNettside(`http://127.0.0.1:${port}/`, opts());
  assert.equal(k.virksomhet, "Sykkelsmia AS");
  assert.equal(k.beskrivelse, "Sykkelverksted i sentrum");
  assert.equal(k.sider.length, 3);
  assert.doesNotMatch(k.markdown, /alert/);
  assert.match(k.kb.sok("hva koster service")[0]!.tekst, /790/);
  assert.match(k.kb.sok("når har dere åpent")[0]!.tekst, /10–17/);
});
