// Dashbord: live overvåking, samtalelogg, kvalitetsvakt og compliance.
// All tekst settes med textContent, aldri innerHTML.

const $ = (id) => document.getElementById(id);
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

const token = new URLSearchParams(location.search).get("token");
const medToken = (url) => (token ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : url);
const hent = (url, init) => fetch(medToken(url), init).then(async (r) => {
  const d = await r.json();
  if (!r.ok) throw new Error(d.feil ?? r.statusText);
  return d;
});

const tid = (iso) => new Date(iso).toLocaleString("nb-NO", { dateStyle: "short", timeStyle: "short" });
const sek = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const ALVOR = { kritisk: "kritisk", advarsel: "advarsel", info: "info" };

// ---------- faner ----------
const faner = ["live", "samtaler", "kvalitet", "compliance", "leads"];
function visFane(navn) {
  for (const f of faner) $(`fane-${f}`).classList.toggle("skjult", f !== navn);
  document.querySelectorAll("[data-fane]").forEach((b) => b.classList.toggle("aktiv", b.dataset.fane === navn));
  history.replaceState(null, "", `#${navn}${token ? "" : ""}`);
  if (navn === "samtaler") lastSamtaler();
  if (navn === "kvalitet") lastKjoringer();
  if (navn === "compliance") lastCompliance();
  if (navn === "leads") lastLeads();
}

async function lastLeads() {
  const liste = await hent("/api/leads").catch(() => []);
  const tbody = $("leads");
  if (!liste.length) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "dempet" }, "Ingen leads ennå. Test en nettside under «Ring agenten» og book en gjennomgang.")));
    return;
  }
  tbody.replaceChildren(...liste.map((l) => el("tr", { onclick: () => { visFane("samtaler"); visSamtale(l.samtaleId); } },
    el("td", { class: "tall-kol" }, tid(l.tid)),
    el("td", {}, l.virksomhet),
    el("td", {}, el("div", {}, l.navn), el("div", { class: "liten dempet" }, [l.epost, l.telefon].filter(Boolean).join(" · "))),
    el("td", { class: "liten" }, l.kort || "–"),
    el("td", { class: "liten" }, l.ubesvarte.length ? el("ul", { class: "liste" }, l.ubesvarte.map((u) => el("li", {}, u))) : "–"),
    el("td", { class: "tall-kol" }, l.kunnskapshull),
  )));
}
document.querySelectorAll("[data-fane]").forEach((b) => b.addEventListener("click", () => visFane(b.dataset.fane)));

// ---------- live ----------
const live = new Map(); // samtaleId -> { kort, linjer, flagg, profil }

function liveKort(id, profil) {
  if (live.has(id)) return live.get(id);
  $("live").querySelector(".tom")?.remove();
  const linjer = el("div", { class: "linjer" });
  const flagg = el("div", { class: "flagg-rad" });
  const status = el("span", { class: "flex liten" }, el("span", { class: "prikk" }), "pågår");
  const hviskFelt = el("input", { type: "text", placeholder: "Hvisk til agenten, f.eks. «tilby time i morgen»", maxlength: "500" });
  const hviskSkjema = el("form", { class: "skriv-rad" }, hviskFelt, el("button", { class: "knapp" }, "Hvisk"));
  hviskSkjema.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!hviskFelt.value.trim() || ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "hvisk", samtaleId: id, tekst: hviskFelt.value.trim() }));
    hviskFelt.value = "";
  });
  const kort = el("div", { class: "kort live-kort" },
    el("div", { class: "hode" }, el("b", {}, profil ?? "Agent"), status),
    el("div", { class: "liten dempet" }, id),
    flagg, linjer, hviskSkjema);
  $("live").prepend(kort);
  const oppføring = { kort, linjer, flagg, status, hviskSkjema };
  live.set(id, oppføring);
  return oppføring;
}

function liveLinje(o, rolle, tekst, ekstra) {
  o.linjer.append(el("div", { class: "linje" }, el("b", {}, rolle === "agent" ? "Agent: " : rolle === "innringer" ? "Innringer: " : ""), tekst, ekstra ?? ""));
  o.linjer.scrollTop = o.linjer.scrollHeight;
}

let ws;
function kobleLive() {
  ws = new WebSocket(medToken(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/live`));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "aktive") {
      for (const s of m.samtaler) {
        const o = liveKort(s.id, s.profil?.navn);
        for (const t of s.turer) liveLinje(o, t.rolle, t.tekst);
        for (const f of s.flagg) o.flagg.append(el("span", { class: `merke ${ALVOR[f.alvor]}` }, f.tekst));
      }
      return;
    }
    const o = liveKort(m.samtaleId, m.profil);
    if (m.type === "tur") {
      const verktoy = (m.tur.verktoy ?? []).map((v) => el("span", { class: `chip ${v.feil ? "feil" : "ok"}` }, v.navn));
      liveLinje(o, m.tur.rolle, m.tur.tekst, verktoy.length ? el("div", { class: "meta" }, verktoy) : null);
    } else if (m.type === "flagg") {
      o.flagg.append(el("span", { class: `merke ${ALVOR[m.flagg.alvor]}`, title: m.flagg.kode }, m.flagg.tekst));
      if (m.flagg.alvor === "kritisk") o.kort.style.borderColor = "var(--kritisk)";
    } else if (m.type === "hvisk") {
      liveLinje(o, "system", `Hvisket: «${m.tekst}»`);
    } else if (m.type === "beskjed") {
      liveLinje(o, "system", `Beskjed lagret: ${m.beskjed.navn}, ${m.beskjed.beskjed}`);
    } else if (m.type === "status" && m.status !== "aktiv") {
      o.status.replaceChildren(m.status === "overfort" ? "satt over" : "avsluttet");
      o.hviskSkjema.remove();
      o.kort.style.opacity = "0.6";
    }
  };
  ws.onclose = () => setTimeout(kobleLive, 2000);
}
kobleLive();

// ---------- samtaler ----------
async function lastSamtaler() {
  const liste = await hent("/api/samtaler").catch(() => []);
  const tbody = $("samtaler");
  if (!liste.length) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "8", class: "dempet" }, "Ingen samtaler ennå.")));
    return;
  }
  tbody.replaceChildren(...liste.map((s) => el("tr", { onclick: () => visSamtale(s.id) },
    el("td", { class: "tall-kol" }, tid(s.startet)),
    el("td", {}, s.profil ?? "–"),
    el("td", {}, s.status),
    el("td", {}, s.utfall ?? el("span", { class: "dempet" }, "–")),
    el("td", { class: "tall-kol" }, s.turer),
    el("td", { class: "tall-kol" }, sek(s.snittMs)),
    el("td", { class: "liten" }, [...new Set(s.verktoy)].join(", ")),
    el("td", {}, [...new Set(s.flagg ?? [])].map((f) => el("span", { class: "chip" }, f))),
  )));
}

function transkripsjonVisning(turer, flagg = []) {
  return el("div", { class: "transkripsjon" }, turer.map((t, i) => {
    const meta = [];
    for (const v of t.verktoy ?? []) meta.push(el("span", { class: `chip ${v.feil ? "feil" : "ok"}`, title: v.resultat }, `${v.navn} · ${v.ms} ms`));
    if (t.maling) meta.push(el("span", { class: "chip" }, `svar ${sek(t.maling.totalMs)}`));
    for (const f of flagg.filter((x) => x.tur === i)) meta.push(el("span", { class: `merke ${ALVOR[f.alvor]}` }, f.tekst));
    return el("div", { class: `boble ${t.rolle}` }, t.tekst, meta.length ? el("div", { class: "meta" }, meta) : null);
  }));
}

async function visSamtale(id) {
  const s = await hent(`/api/samtaler/${encodeURIComponent(id)}`);
  const d = $("samtale-detalj");
  d.classList.remove("skjult");
  const oppsummer = el("button", { class: "knapp" }, s.oppsummering ? "Vis oppsummering" : "Lag oppsummering");
  const oppsummeringBoks = el("div");
  oppsummer.addEventListener("click", async () => {
    oppsummer.disabled = true;
    try {
      const o = s.oppsummering ?? await hent(`/api/samtaler/${encodeURIComponent(id)}/oppsummering`, { method: "POST" });
      oppsummeringBoks.replaceChildren(
        el("p", {}, el("span", { class: "merke info" }, o.utfall), " ", o.kort),
        o.neste_steg.length ? el("ul", { class: "liste" }, o.neste_steg.map((x) => el("li", {}, x))) : "",
        o.sms_til_innringer ? el("div", { class: "sms mt" }, o.sms_til_innringer) : "",
      );
    } catch (e) {
      oppsummeringBoks.replaceChildren(el("p", { class: "dempet" }, e.message));
    }
  });
  d.replaceChildren(
    el("div", { class: "flex mellom" }, el("h2", {}, `${s.profil?.navn ?? "Samtale"} · ${tid(s.startet)}`), oppsummer),
    s.overforingsnotat ? el("p", {}, el("span", { class: "merke info" }, "Satt over"), " ", s.overforingsnotat) : "",
    (s.beskjeder ?? []).length ? el("div", {}, el("h3", {}, "Beskjeder"), el("ul", { class: "liste" }, s.beskjeder.map((b) => el("li", {}, `${b.navn} (${b.telefon}): ${b.beskjed}`)))) : "",
    oppsummeringBoks,
    transkripsjonVisning(s.turer, s.flagg),
  );
  d.scrollIntoView({ behavior: "smooth" });
}

// ---------- kvalitetsvakt ----------
let kjoringer = [];
async function lastKjoringer() {
  kjoringer = await hent("/api/evals").catch(() => []);
  const valg = (sel, tom) => {
    const forrige = sel.value;
    sel.replaceChildren(...(tom ? [el("option", { value: "" }, "(ingen)")] : []), ...kjoringer.map((k) =>
      el("option", { value: k.fil }, `${tid(k.kjort)} · ${k.oppsummering.bestatt}/${k.oppsummering.totalt} · ${k.modell}${k.ustabil ? " · ustabil" : ""}`)));
    if (forrige) sel.value = forrige;
  };
  valg($("kjoring"), false);
  valg($("sammenlign"), true);
  if (!kjoringer.length) {
    $("kvalitet-innhold").replaceChildren(el("div", { class: "tom" }, "Ingen kjøringer ennå. Kjør ", el("code", {}, "npm run eval"), " med en API-nøkkel i .env."));
    return;
  }
  if (!$("sammenlign").value && kjoringer[1]) $("sammenlign").value = kjoringer[1].fil;
  visKjoring();
}
$("kjoring").addEventListener("change", visKjoring);
$("sammenlign").addEventListener("change", visKjoring);

function flis(etikett, verdi, delta, lavereErBedre = false) {
  let deltaNode = "";
  if (delta != null && delta !== 0) {
    const bedre = lavereErBedre ? delta < 0 : delta > 0;
    deltaNode = el("div", { class: `delta ${bedre ? "bedre" : "verre"}` }, `${delta > 0 ? "+" : ""}${delta}`);
  }
  return el("div", { class: "flis" }, el("div", { class: "etikett" }, etikett), el("div", { class: "tall" }, verdi), deltaNode);
}

async function visKjoring() {
  const a = await hent(`/api/evals/${encodeURIComponent($("kjoring").value)}`);
  const b = $("sammenlign").value && $("sammenlign").value !== $("kjoring").value ? await hent(`/api/evals/${encodeURIComponent($("sammenlign").value)}`) : null;
  const oa = a.oppsummering, ob = b?.oppsummering;
  const d = (x, y) => (ob ? Math.round(x - y) : null);
  const andel = (o) => Math.round((o.bestatt / o.totalt) * 100);

  const perScenario = (kj) => {
    const m = new Map();
    for (const r of kj.resultater) {
      const x = m.get(r.scenario) ?? { tittel: r.tittel, bestatt: 0, totalt: 0, dommer: [], feil: new Map(), resultater: [] };
      x.totalt++;
      if (r.bestod) x.bestatt++;
      if (r.vurdering) x.dommer.push(r.vurdering);
      for (const s of r.sjekker) if (!s.ok) x.feil.set(s.navn, (x.feil.get(s.navn) ?? 0) + 1);
      x.resultater.push(r);
      m.set(r.scenario, x);
    }
    return m;
  };
  const sa = perScenario(a), sb = b ? perScenario(b) : new Map();
  const snitt = (arr, k) => (arr.length ? (arr.reduce((s, v) => s + v[k], 0) / arr.length).toFixed(1) : "–");

  $("kvalitet-innhold").replaceChildren(
    el("div", { class: "fliser" },
      flis("Bestått", `${oa.bestatt}/${oa.totalt}`, ob ? d(andel(oa), andel(ob)) : null),
      flis("Svartid p50", sek(oa.latens_p50_ms), ob ? d(oa.latens_p50_ms, ob.latens_p50_ms) : null, true),
      flis("Svartid p95", sek(oa.latens_p95_ms), ob ? d(oa.latens_p95_ms, ob.latens_p95_ms) : null, true),
      flis("Første ord p50", sek(oa.forste_tekst_p50_ms), ob ? d(oa.forste_tekst_p50_ms, ob.forste_tekst_p50_ms) : null, true),
      flis("Tokens ut", oa.tokens_ut.toLocaleString("nb-NO"), ob ? d(oa.tokens_ut, ob.tokens_ut) : null, true),
      flis("Cache-treff (tokens)", oa.tokens_cache_lest.toLocaleString("nb-NO")),
    ),
    ob ? el("p", { class: "liten dempet" }, "Endring i prosentpoeng for bestått, millisekunder for svartid. Grønt er bedre.") : "",
    el("div", { class: "tabell-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Scenario"), el("th", {}, "Bestått"), ob ? el("th", {}, "Før") : "", el("th", {}, "Dommer (løst/norsk/effektiv/sikker)"), el("th", {}, "Feilede sjekker"))),
      el("tbody", {}, [...sa].map(([id, x]) => {
        const f = sb.get(id);
        const merke = x.bestatt === x.totalt ? "ok" : x.bestatt === 0 ? "kritisk" : "advarsel";
        return el("tr", { onclick: () => visScenario(x) },
          el("td", {}, el("b", {}, x.tittel), el("div", { class: "liten dempet" }, id)),
          el("td", {}, el("span", { class: `merke ${merke}` }, `${x.bestatt}/${x.totalt}`)),
          ob ? el("td", { class: "dempet" }, f ? `${f.bestatt}/${f.totalt}` : "–") : "",
          el("td", { class: "tall-kol" }, x.dommer.length ? ["oppgave_lost", "naturlig_norsk", "effektivitet", "sikkerhet"].map((k) => snitt(x.dommer, k)).join(" / ") : "–"),
          el("td", { class: "liten" }, [...x.feil].map(([n, c]) => el("span", { class: "chip feil" }, `${n}${c > 1 ? ` ×${c}` : ""}`))),
        );
      })),
    )),
  );
}

function visScenario(x) {
  const d = $("scenario-detalj");
  d.classList.remove("skjult");
  d.replaceChildren(el("h2", {}, x.tittel), ...x.resultater.map((r) => el("div", { class: "mt" },
    el("div", { class: "flex" }, el("span", { class: `merke ${r.bestod ? "ok" : "kritisk"}` }, r.bestod ? "Bestått" : "Feilet"), el("span", { class: "dempet liten" }, `forsøk ${r.forsok} · ${r.status}`)),
    el("div", { class: "flagg-rad" }, r.sjekker.map((s) => el("span", { class: `chip ${s.ok ? "ok" : "feil"}`, title: s.detalj }, s.navn))),
    r.vurdering ? el("p", { class: "liten" }, el("b", {}, "Dommer: "), r.vurdering.forbedring, r.vurdering.verste_replikk ? el("div", { class: "dempet" }, `Svakeste replikk: «${r.vurdering.verste_replikk}»`) : "") : "",
    transkripsjonVisning(r.turer),
  )));
  d.scrollIntoView({ behavior: "smooth" });
}

// ---------- compliance ----------
function lastCompliance() {
  if (!$("aar").value) $("aar").value = new Date().getFullYear();
  if (!$("ringetid").value) $("ringetid").value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  visHelligdager();
}
async function visHelligdager() {
  const liste = await hent(`/api/compliance/helligdager?aar=${$("aar").value}`).catch(() => []);
  $("helligdager").replaceChildren(...liste.map((h) => el("tr", {}, el("td", { class: "tall-kol" }, new Date(`${h.dato}T12:00`).toLocaleDateString("nb-NO", { weekday: "short", day: "numeric", month: "long" })), el("td", {}, h.navn))));
}
$("aar").addEventListener("change", visHelligdager);
$("ringetid-skjema").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = await hent(`/api/compliance/ringetid?tid=${encodeURIComponent($("ringetid").value)}`);
  $("ringetid-svar").replaceChildren(
    el("p", {}, el("span", { class: `merke ${v.lovlig ? "ok" : "kritisk"}` }, v.lovlig ? "Lovlig" : "Ikke lov"), " ", v.grunn),
    v.lovlig ? "" : el("p", { class: "liten" }, "Neste lovlige tidspunkt: ", el("b", {}, new Date(`${v.nesteLovlige}:00`).toLocaleString("nb-NO", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))),
  );
});

visFane(faner.includes(location.hash.slice(1)) ? location.hash.slice(1) : "live");
