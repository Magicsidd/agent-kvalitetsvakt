// Taleklient: nettleserens talegjenkjenning (nb-NO) inn, talesyntese ut,
// WebSocket til agenten. Svaret leses opp setning for setning mens modellen
// skriver, så første lyd kommer før hele svaret er ferdig.

const $ = (id) => document.getElementById(id);

/** Lager elementer uten innerHTML, så samtaletekst aldri tolkes som HTML. */
function el(tag, attrs = {}, ...barn) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const b of barn.flat()) if (b != null && b !== false) e.append(b instanceof Node ? b : String(b));
  return e;
}

const tilTale = (t) => t.replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim();

const tilstand = {
  modus: "klinikk",
  mal: null,
  virksomhet: "Nordstjerna Tannklinikk",
  ws: null,
  samtaleId: null,
  iSamtale: false,
  venterPaaAgent: false,
  sendtTid: 0,
  forsteOrdMs: null,
  agentBoble: null,
  agentVerktoy: [],
  delBuffer: "",
  sagt: "",
  taleKo: 0,
  gjenkjenning: null,
  foreloepig: null,
  lyd: null,
};

// ---------- status ----------
fetch("/api/status").then((r) => r.json()).then((s) => {
  $("modell").textContent = s.harNokkel ? `${s.modell} · effort ${s.effort}` : "Mangler ANTHROPIC_API_KEY";
  if (!s.harNokkel) $("modell").classList.add("merke", "kritisk");
});

// ---------- modus ----------
for (const knapp of document.querySelectorAll("[data-modus]")) {
  knapp.addEventListener("click", () => {
    if (tilstand.iSamtale) return;
    tilstand.modus = knapp.dataset.modus;
    document.querySelectorAll("[data-modus]").forEach((k) => k.classList.toggle("aktiv", k === knapp));
    $("modus-klinikk").classList.toggle("skjult", tilstand.modus !== "klinikk");
    $("modus-nettside").classList.toggle("skjult", tilstand.modus !== "nettside");
    if (tilstand.modus === "klinikk") tilstand.virksomhet = "Nordstjerna Tannklinikk";
    oppdaterRingKnapp();
  });
}

$("nettside-skjema").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("nettside-status");
  $("lag-agent").disabled = true;
  status.replaceChildren("Henter siden og bygger kunnskap …");
  try {
    const r = await fetch("/api/agent-fra-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: $("url").value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.feil ?? "Noe gikk galt.");
    tilstand.mal = d.mal;
    tilstand.virksomhet = d.virksomhet;
    status.replaceChildren(
      el("div", {}, el("span", { class: "merke ok" }, "Klar"), " ", el("b", {}, d.virksomhet), ` · ${d.avsnitt} avsnitt fra ${d.sider.length} sider`),
      el("ul", { class: "liste mt" }, d.sider.map((s) => el("li", {}, el("span", { class: "liten" }, s)))),
    );
  } catch (err) {
    tilstand.mal = null;
    status.replaceChildren(el("span", { class: "merke kritisk" }, "Feil"), " ", err.message);
  } finally {
    $("lag-agent").disabled = false;
    oppdaterRingKnapp();
  }
});

function oppdaterRingKnapp() {
  $("ring").disabled = !tilstand.iSamtale && tilstand.modus === "nettside" && !tilstand.mal;
}

// ---------- transkripsjon ----------
function leggTil(node) {
  const t = $("transkripsjon");
  t.querySelector(".tom")?.remove();
  t.append(node);
  t.scrollTop = t.scrollHeight;
  return node;
}
const systemlinje = (tekst) => leggTil(el("div", { class: "systemlinje" }, tekst));

function verktoyChip(k) {
  return el("span", { class: `chip ${k.feil ? "feil" : "ok"}`, title: k.resultat }, `${k.navn} · ${k.ms} ms`);
}

function visTur(tur) {
  if (tur.rolle === "innringer") {
    tilstand.foreloepig?.remove();
    tilstand.foreloepig = null;
    leggTil(el("div", { class: "boble innringer" }, tur.tekst));
    return;
  }
  const boble = tilstand.agentBoble ?? leggTil(el("div", { class: "boble agent" }));
  boble.replaceChildren(tur.tekst);
  const meta = [];
  for (const k of tur.verktoy ?? []) meta.push(verktoyChip(k));
  if (tur.maling) {
    meta.push(el("span", { class: "chip" }, `svar ${(tur.maling.totalMs / 1000).toFixed(1)} s`));
    if (tur.maling.forsteTekstMs) meta.push(el("span", { class: "chip" }, `første ord ${(tur.maling.forsteTekstMs / 1000).toFixed(1)} s`));
    $("maling").textContent = `${tur.maling.runder} runder · modell ${tur.maling.modellMs} ms · verktøy ${tur.maling.verktoyMs} ms`;
  }
  if (meta.length) boble.append(el("div", { class: "meta" }, meta));
  tilstand.agentBoble = null;
  tilstand.agentVerktoy = [];
}

function deltaTilBoble(delta) {
  if (!tilstand.agentBoble) tilstand.agentBoble = leggTil(el("div", { class: "boble agent" }));
  const tekstNode = tilstand.agentBoble.firstChild;
  if (tekstNode && tekstNode.nodeType === Node.TEXT_NODE) tekstNode.textContent += delta;
  else tilstand.agentBoble.prepend(delta);
  $("transkripsjon").scrollTop = $("transkripsjon").scrollHeight;
}

// ---------- tale ut ----------
let norskStemme = null;
function velgStemme() {
  const stemmer = speechSynthesis.getVoices();
  norskStemme = stemmer.find((v) => /^(nb|no|nn)(-|_|$)/i.test(v.lang)) ?? null;
}
if ("speechSynthesis" in window) {
  velgStemme();
  speechSynthesis.addEventListener("voiceschanged", velgStemme);
}

// Ekte stemme fra serveren når den er satt opp, ellers nettleserens.
let serverTale = false;
fetch("/api/status").then((r) => r.json()).then((s) => { serverTale = !!s.harTale; }).catch(() => {});
let taleKjede = Promise.resolve();
let spillerNaa = null;

function si(tekst) {
  if (!tekst.trim()) return;
  if (serverTale) return siFraServer(tekst);
  siINettleser(tekst);
}

function siFraServer(tekst) {
  tilstand.taleKo++;
  settTilstand("Agenten snakker …");
  stoppLytting();
  // Hent lyden med en gang, men spill av i rekkefølge.
  const lyd = fetch("/api/tale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tekst }) })
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); });
  taleKjede = taleKjede
    .then(() => lyd)
    .then((blob) => new Promise((ferdig) => {
      if (!tilstand.iSamtale && tilstand.taleKo === 0) return ferdig();
      const a = new Audio(URL.createObjectURL(blob));
      spillerNaa = a;
      a.onended = a.onerror = a.onpause = () => { URL.revokeObjectURL(a.src); spillerNaa = null; ferdig(); };
      a.play().catch(ferdig);
    }))
    .catch(() => {})
    .then(() => {
      tilstand.taleKo = Math.max(0, tilstand.taleKo - 1);
      if (tilstand.taleKo === 0 && !tilstand.venterPaaAgent) startLytting();
    });
}

function siINettleser(tekst) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(tekst);
  u.lang = "nb-NO";
  if (norskStemme) u.voice = norskStemme;
  u.rate = 1.05;
  tilstand.taleKo++;
  settTilstand("Agenten snakker …");
  stoppLytting();
  const ferdig = () => {
    tilstand.taleKo = Math.max(0, tilstand.taleKo - 1);
    if (tilstand.taleKo === 0 && !tilstand.venterPaaAgent) startLytting();
  };
  u.onend = ferdig;
  u.onerror = ferdig;
  speechSynthesis.speak(u);
}

/** Leser opp hele setninger så fort de er ferdigskrevet. */
function taleFraDelta(delta) {
  tilstand.delBuffer += delta;
  const m = tilstand.delBuffer.match(/^([\s\S]*[.!?])\s+/);
  if (m) {
    const setninger = tilTale(m[1]);
    tilstand.delBuffer = tilstand.delBuffer.slice(m[0].length);
    tilstand.sagt += (tilstand.sagt ? " " : "") + setninger;
    si(setninger);
  }
}

function taleRest(ferdigTekst) {
  const sagt = tilstand.sagt;
  tilstand.sagt = "";
  tilstand.delBuffer = "";
  const rest = ferdigTekst.startsWith(sagt) ? ferdigTekst.slice(sagt.length) : sagt ? "" : ferdigTekst;
  if (rest.trim()) si(rest.trim());
  else if (tilstand.taleKo === 0) startLytting();
}

// ---------- tale inn ----------
const Gjenkjenning = window.SpeechRecognition || window.webkitSpeechRecognition;

function startLytting() {
  if (!tilstand.iSamtale || !Gjenkjenning || tilstand.venterPaaAgent) {
    if (tilstand.iSamtale && !Gjenkjenning) settTilstand("Skriv svaret ditt nederst.");
    return;
  }
  if (tilstand.gjenkjenning) return;
  const g = new Gjenkjenning();
  g.lang = "nb-NO";
  g.interimResults = true;
  g.continuous = false;
  g.onresult = (e) => {
    let foreloepig = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) send(r[0].transcript);
      else foreloepig += r[0].transcript;
    }
    if (foreloepig) {
      tilstand.foreloepig ??= leggTil(el("div", { class: "boble innringer foreloepig" }));
      tilstand.foreloepig.textContent = foreloepig;
    }
  };
  g.onend = () => {
    tilstand.gjenkjenning = null;
    if (tilstand.iSamtale && !tilstand.venterPaaAgent && tilstand.taleKo === 0) startLytting();
  };
  g.onerror = (e) => {
    if (e.error === "not-allowed") settTilstand("Mikrofonen er blokkert. Skriv i stedet.");
  };
  tilstand.gjenkjenning = g;
  g.start();
  settTilstand("Lytter …");
  $("ring").classList.add("lytter");
}

function stoppLytting() {
  $("ring").classList.remove("lytter");
  const g = tilstand.gjenkjenning;
  tilstand.gjenkjenning = null;
  if (g) {
    g.onend = null;
    g.abort();
  }
}

/** Ekte lydnivå fra mikrofonen, ikke en animasjon. */
async function startLydmaaler() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const tegn = () => {
      if (!tilstand.lyd) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / data.length);
      $("niva").style.width = `${Math.min(100, rms * 400)}%`;
      requestAnimationFrame(tegn);
    };
    tilstand.lyd = { stream, ctx };
    tegn();
  } catch {
    // Uten mikrofon fungerer tekstfeltet fortsatt.
  }
}

function stoppLydmaaler() {
  if (!tilstand.lyd) return;
  tilstand.lyd.stream.getTracks().forEach((t) => t.stop());
  tilstand.lyd.ctx.close();
  tilstand.lyd = null;
  $("niva").style.width = "0";
}

// ---------- samtale ----------
function settTilstand(t) {
  $("tilstand").textContent = t;
}

function send(tekst) {
  tekst = tekst.trim();
  if (!tekst || !tilstand.ws || tilstand.venterPaaAgent) return;
  stoppLytting();
  tilstand.venterPaaAgent = true;
  tilstand.sendtTid = performance.now();
  tilstand.forsteOrdMs = null;
  settTilstand("Agenten tenker …");
  tilstand.ws.send(JSON.stringify({ type: "tekst", tekst }));
}

function startSamtale() {
  const p = new URLSearchParams();
  if ($("nummer").value.trim()) p.set("nummer", $("nummer").value.trim());
  if (tilstand.modus === "nettside" && tilstand.mal) p.set("mal", tilstand.mal);
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?${p}`);
  tilstand.ws = ws;
  tilstand.iSamtale = true;
  $("transkripsjon").replaceChildren();
  $("oppsummering-kort").classList.add("skjult");
  $("samtale-tittel").textContent = `Samtale med ${tilstand.virksomhet}`;
  $("ring").textContent = "Legg på";
  $("ring").classList.add("i-samtale");
  $("skrivefelt").disabled = false;
  $("send").disabled = false;
  settTilstand("Kobler til …");
  startLydmaaler();

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    switch (m.type) {
      case "start":
        tilstand.samtaleId = m.id;
        break;
      case "tekst_delta":
        if (tilstand.forsteOrdMs === null && tilstand.sendtTid) tilstand.forsteOrdMs = Math.round(performance.now() - tilstand.sendtTid);
        deltaTilBoble(m.delta);
        taleFraDelta(m.delta);
        break;
      case "verktoy":
        tilstand.agentVerktoy.push(m.kall);
        settTilstand(`Sjekker ${m.kall.navn.replaceAll("_", " ")} …`);
        break;
      case "tur":
        visTur(m.tur);
        break;
      case "si":
        tilstand.venterPaaAgent = false;
        taleRest(m.tekst);
        break;
      case "beskjed":
        systemlinje(`Beskjed lagret fra ${m.beskjed.navn} (${m.beskjed.telefon})`);
        break;
      case "status":
        if (m.status === "overfort") systemlinje(`Satt over til en ansatt${m.oppsummering ? `: «${m.oppsummering}»` : ""}`);
        if (m.status !== "aktiv") setTimeout(avsluttSamtale, 2500);
        break;
      case "opptatt":
        break;
      case "feil":
        tilstand.venterPaaAgent = false;
        systemlinje(m.melding);
        settTilstand(m.melding);
        break;
    }
  };
  ws.onclose = () => tilstand.iSamtale && avsluttSamtale();
}

async function avsluttSamtale() {
  if (!tilstand.iSamtale) return;
  tilstand.iSamtale = false;
  stoppLytting();
  stoppLydmaaler();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  spillerNaa?.pause();
  tilstand.taleKo = 0;
  tilstand.venterPaaAgent = false;
  if (tilstand.ws?.readyState === WebSocket.OPEN) {
    tilstand.ws.send(JSON.stringify({ type: "legg_paa" }));
    tilstand.ws.close();
  }
  tilstand.ws = null;
  $("ring").textContent = "Ring";
  $("ring").classList.remove("i-samtale");
  $("skrivefelt").disabled = true;
  $("send").disabled = true;
  settTilstand("Samtalen er avsluttet.");
  systemlinje("Samtalen er avsluttet");
  oppdaterRingKnapp();
  if (tilstand.samtaleId && $("transkripsjon").querySelectorAll(".boble.innringer").length) visOppsummering(tilstand.samtaleId);
}

async function visOppsummering(id) {
  const kort = $("oppsummering-kort");
  kort.classList.remove("skjult");
  $("oppsummering").replaceChildren(el("p", { class: "dempet liten" }, "Lager oppsummering …"));
  $("utfall").replaceChildren();
  try {
    const r = await fetch(`/api/samtaler/${encodeURIComponent(id)}/oppsummering`, { method: "POST" });
    const o = await r.json();
    if (!r.ok) throw new Error(o.feil);
    const utfallKlasse = { "løst": "ok", "delvis løst": "advarsel", "ikke løst": "kritisk", "satt over": "info" }[o.utfall] ?? "info";
    $("utfall").replaceChildren(el("span", { class: `merke ${utfallKlasse}` }, o.utfall), " ", el("span", { class: "merke info" }, o.stemning));
    const deler = [el("p", {}, o.kort)];
    if (o.neste_steg.length) deler.push(el("h3", {}, "Neste steg for bedriften"), el("ul", { class: "liste" }, o.neste_steg.map((s) => el("li", {}, s))));
    if (o.sms_til_innringer) {
      const kopier = el("button", { class: "knapp liten", onclick: () => navigator.clipboard.writeText(o.sms_til_innringer) }, "Kopier");
      deler.push(el("h3", {}, "SMS til innringeren"), el("div", { class: "sms" }, o.sms_til_innringer, el("div", { class: "mt" }, kopier)));
    }
    if (o.ubesvarte_sporsmal.length) deler.push(el("h3", {}, "Spørsmål agenten ikke kunne svare på"), el("ul", { class: "liste" }, o.ubesvarte_sporsmal.map((s) => el("li", {}, s))));
    if (o.kunnskapshull.length) {
      deler.push(el("h3", {}, tilstand.modus === "nettside" ? "Dette bør inn i kunnskapsbasen før agenten går live" : "Forslag til kunnskapsbasen"));
      for (const h of o.kunnskapshull) deler.push(el("div", { class: "forslag" }, el("div", { class: "liten dempet" }, h.sporsmal), h.foreslatt_tekst));
    }
    if (tilstand.modus === "nettside") deler.push(nesteSteg(id));
    $("oppsummering").replaceChildren(...deler);
  } catch (err) {
    $("oppsummering").replaceChildren(el("p", { class: "dempet liten" }, `Kunne ikke lage oppsummering: ${err.message}`));
  }
}

/** Demo som selger: den som har testet, kan booke en gjennomgang med samtalen som utgangspunkt. */
function nesteSteg(samtaleId) {
  const felt = (id, etikett, type, paakrevd) => el("div", { class: "felt" },
    el("label", { for: id }, etikett),
    el("input", { id, type, ...(paakrevd ? { required: "" } : {}), autocomplete: type === "email" ? "email" : type === "tel" ? "tel" : "name" }));
  const status = el("div", { class: "liten" });
  const skjema = el("form", { class: "neste-steg" },
    el("h3", {}, `Vil du ha denne agenten på telefonen til ${tilstand.virksomhet}?`),
    el("p", { class: "liten dempet" }, "Book en gjennomgang. Samtalen og forslagene over følger med, så vi starter der testen din sluttet."),
    felt("lead-navn", "Navn", "text", true),
    felt("lead-epost", "E-post", "email", true),
    felt("lead-telefon", "Telefon (valgfritt)", "tel", false),
    el("button", { class: "knapp primar mt" }, "Book gjennomgang"),
    status);
  skjema.addEventListener("submit", async (e) => {
    e.preventDefault();
    const knapp = skjema.querySelector("button");
    knapp.disabled = true;
    try {
      const r = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ samtaleId, navn: $("lead-navn").value, epost: $("lead-epost").value, telefon: $("lead-telefon").value }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.feil ?? "Noe gikk galt.");
      skjema.replaceChildren(el("h3", {}, `Takk, ${d.navn}.`), el("p", { class: "liten" }, "Vi tar kontakt for å avtale en tid. Samtalen din og oppsummeringen ligger klar hos oss."));
    } catch (err) {
      knapp.disabled = false;
      status.replaceChildren(el("span", { class: "merke kritisk" }, "Feil"), " ", err.message);
    }
  });
  return skjema;
}

$("ring").addEventListener("click", () => (tilstand.iSamtale ? avsluttSamtale() : startSamtale()));
$("skriv").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("skrivefelt").value);
  $("skrivefelt").value = "";
});

if (!Gjenkjenning) settTilstand("Nettleseren har ikke talegjenkjenning. Bruk Chrome eller Edge, eller skriv.");
