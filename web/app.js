/* Modlist Atlas — browse and compare MO2 modlists.
   Data: lists/index.json, lists/<name>/mods.json, plan/decisions.json, data/descriptions.json.
   With tools/serve.py running, /api/* adds Snapshot and decision saving. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LIST_COLORS = ["#d2ad66", "#8cc3df", "#e0806a", "#9cc98a", "#b39ae0", "#e6a0c4", "#7fd1b9", "#c9b38a"];
// Only ever put http(s) URLs into href/src: list metadata from imports is untrusted (javascript: links)
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim() : "");
const normName = (n) => "name:" + n.toLowerCase().replace(/[^a-z0-9]+/g, "");
const PH_COLORS = ["#d2ad66", "#8cc3df", "#e0806a", "#9cc98a", "#b39ae0", "#7fd1b9", "#c98f6a", "#a7b4c9"];
const API_HEADERS = { "Content-Type": "application/json", "X-Modlist-Atlas": "1" };

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

const UI_DEFAULTS = {
  tab: "browse", primary: null, tri: {}, cats: [], secs: [], status: "all", decision: "all",
  groupBy: "section", view: "cards", sort: "priority", csort: "lists", onlyVdiff: false,
  allCats: false, allSecs: false, ovBase: null, chartAll: false,
};
const S = {
  lists: [], data: {}, decisions: {}, local: null, descriptions: null, catalog: new Map(),
  ui: Object.assign({}, UI_DEFAULTS, store.get("atlas-ui", {})),
  search: "", selected: null, navKeys: [], statusProblem: "", compareLimit: 500, lastFocus: null,
  // bulk edit: checkboxes stay hidden until "Select" is toggled on; picked holds catalog keys
  bulk: false, picked: new Set(), bulkDec: "unchanged", bulkNote: "",
};
const saveUI = () => store.set("atlas-ui", S.ui);

// ------------------------------------------------------------------ loading

function assignColors() {
  const saved = store.get("atlas-colors", {});
  const used = new Set(S.lists.map((l) => saved[l.name]).filter((i) => i !== undefined));
  for (const l of S.lists) {
    if (saved[l.name] === undefined) {
      let i = 0;
      while (used.has(i) && i < LIST_COLORS.length) i++;
      saved[l.name] = i < LIST_COLORS.length ? i : used.size % LIST_COLORS.length;
      used.add(saved[l.name]);
    }
    l.color = LIST_COLORS[saved[l.name] % LIST_COLORS.length];
  }
  store.set("atlas-colors", saved);
}

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function loadAll() {
  S.lists = await getJSON("lists/index.json");
  assignColors();
  await Promise.all(S.lists.map(async (l) => {
    S.data[l.name] = await getJSON(`lists/${encodeURIComponent(l.name)}/mods.json`).catch(() => []);
  }));
  S.decisions = await getJSON("plan/decisions.json").catch(() => ({}));
  S.statusProblem = "";
  try {
    const r = await fetch("api/status", { cache: "no-store" });
    if (r.ok) {
      const st = await r.json();
      S.local = st.local ? st : null;
      if (st.problems?.length) S.statusProblem = "Some local files couldn't be read: " + st.problems.join("; ");
    } else {
      S.local = null;
      if (r.status !== 404) S.statusProblem = `The local server returned HTTP ${r.status}; editing is off. Check the server window.`;
    }
  } catch (e) { S.local = null; }
  buildCatalog();
  resolveDecisionKeys();
  const names = S.lists.map((l) => l.name);
  if (!names.includes(S.ui.primary)) S.ui.primary = (S.lists.find((l) => l.source === "mo2") || S.lists[0] || {}).name;
  if (!names.includes(S.ui.ovBase)) S.ui.ovBase = (S.lists.find((l) => l.frozen) || {}).name || S.ui.primary;
  for (const k of Object.keys(S.ui.tri)) if (!names.includes(k)) delete S.ui.tri[k];
}

function firstRunHTML() {
  return S.local
    ? emptyState("No lists yet", `Add a snapshot of an MO2 profile, or upload profile files (a folder, a .zip, or a modlist.txt).
        <div style="margin-top:14px"><button class="btn primary" data-act="add-list">+ Add your first list</button></div>`)
    : emptyState("No lists yet", "Start the local server (<code>Modlist Atlas.bat</code> or <code>python tools/serve.py</code>) to add lists.");
}

async function init() {
  try {
    await loadAll();
  } catch (e) {
    S.lists = [];
  }
  $("#snapshotBtn").hidden = !S.local;
  let hash = "";
  try { hash = decodeURIComponent(location.hash.slice(1)); } catch (e) { hash = ""; }
  if (!S.lists.length) {
    $("#listbar").innerHTML = "";
    $("#app").innerHTML = firstRunHTML();
    renderFooter();
    if (hash.startsWith("add") && S.local) openAddList("mo2");
    return;
  }
  if (["browse", "compare", "overview"].includes(hash)) S.ui.tab = hash;
  render();
  if (hash.startsWith("mod:")) openDrawer(hash.slice(4));
  if (hash.startsWith("add") && S.local) openAddList(["mo2", "upload"].includes(hash.slice(4)) ? hash.slice(4) : "mo2");
}

// ------------------------------------------------------------------ catalog: one record per mod across lists

function buildCatalog() {
  // name-only mods (uploaded lists) resolve to a Nexus key when another list knows the name
  const nameIdx = new Map();
  for (const l of S.lists) for (const m of S.data[l.name]) {
    if (!m.key.startsWith("name:") && !nameIdx.has(normName(m.name))) nameIdx.set(normName(m.name), m.key);
  }
  S.catalog = new Map();
  for (const l of S.lists) for (const m of S.data[l.name]) {
    const key = m.key.startsWith("name:") && nameIdx.has(m.key) ? nameIdx.get(m.key) : m.key;
    m.ck = key; m.list = l.name;
    let rec = S.catalog.get(key);
    if (!rec) { rec = { key, entries: {}, names: new Set() }; S.catalog.set(key, rec); }
    (rec.entries[l.name] ||= []).push(m);
    rec.names.add(m.name);
    if (!rec.url && m.url) rec.url = m.url;
    for (const f of ["summary", "picture", "author", "nexus_id", "endorsements"]) if (!rec[f] && m[f]) rec[f] = m[f];
    if (m.category && m.category !== "Uncategorized" && !rec.category) rec.category = m.category;
    if (m.summary_source === "nexus" && rec.summary_source !== "nexus") { rec.summary = m.summary; rec.summary_source = "nexus"; }
  }
  for (const rec of S.catalog.values()) {
    rec.category ||= "Uncategorized";
    const vers = new Set();
    for (const ms of Object.values(rec.entries)) if (ms[0].version) vers.add(ms[0].version);
    rec.vdiff = vers.size > 1;
  }
}

const recOf = (m) => S.catalog.get(m.ck);
const catOf = (m) => (m.category && m.category !== "Uncategorized" ? m.category : recOf(m).category);
const sumOf = (m) => (recOf(m).summary_source === "nexus" ? recOf(m).summary : m.summary || recOf(m).summary || "");
const urlOf = (m) => m.url || recOf(m).url || "";
function recName(rec) {
  const p = rec.entries[S.ui.primary];
  if (p) return p[0].name;
  for (const l of S.lists) if (rec.entries[l.name]) return rec.entries[l.name][0].name;
  return rec.key;
}
// A decision is stored under the mod's key. If that key changes (e.g. the list that supplied the
// Nexus ID was deleted), fall back to the normalized name saved with the decision.
function resolveDecisionKeys() {
  const byName = new Map();
  for (const [k, d] of Object.entries(S.decisions)) if (d.name_key && !byName.has(d.name_key)) byName.set(d.name_key, k);
  for (const rec of S.catalog.values()) {
    rec.dk = rec.key;
    if (S.decisions[rec.key]) continue;
    for (const n of rec.names) {
      const k = byName.get(normName(n));
      if (k) { rec.dk = k; break; }
    }
  }
}
const decKey = (key) => S.catalog.get(key)?.dk || key;
const decOf = (key) => S.decisions[decKey(key)] || null;
const listByName = (n) => S.lists.find((l) => l.name === n);

// ------------------------------------------------------------------ filtering

function tokens() { return S.search.toLowerCase().split(/\s+/).filter(Boolean); }

function matchSearch(texts, toks) {
  if (!toks.length) return true;
  const hay = texts.join(" \u0001 ").toLowerCase();
  return toks.every((t) => hay.includes(t));
}

function decisionPass(key) {
  const f = S.ui.decision;
  if (f === "all") return true;
  const d = decOf(key)?.decision || "";
  return f === "none" ? !d : d === f;
}

function browseFiltered(skip) {
  const toks = tokens();
  return (S.data[S.ui.primary] || []).filter((m) => {
    if (skip !== "cats" && S.ui.cats.length && !S.ui.cats.includes(catOf(m))) return false;
    if (skip !== "secs" && S.ui.secs.length && !S.ui.secs.includes(m.section)) return false;
    if (skip !== "status" && S.ui.status !== "all" && (S.ui.status === "enabled") !== m.enabled) return false;
    if (skip !== "decision" && !decisionPass(m.ck)) return false;
    return matchSearch([m.name, sumOf(m), catOf(m), m.section, m.notes, decOf(m.ck)?.note], toks);
  });
}

function triPass(rec) {
  for (const [name, state] of Object.entries(S.ui.tri)) {
    if (state === "in" && !rec.entries[name]) return false;
    if (state === "out" && rec.entries[name]) return false;
  }
  return true;
}

function compareFiltered(skip) {
  const toks = tokens();
  const out = [];
  for (const rec of S.catalog.values()) {
    if (skip !== "tri" && !triPass(rec)) continue;
    if (skip !== "cats" && S.ui.cats.length && !S.ui.cats.includes(rec.category)) continue;
    if (skip !== "decision" && !decisionPass(rec.key)) continue;
    if (S.ui.onlyVdiff && !rec.vdiff) continue;
    if (!matchSearch([...rec.names, rec.summary, rec.category, decOf(rec.key)?.note], toks)) continue;
    out.push(rec);
  }
  return out;
}

// ------------------------------------------------------------------ small render helpers

function emptyState(title, body) {
  return `<div class="empty"><span class="rune">ᛉ</span><b>${esc(title)}</b><div>${body}</div></div>`;
}

function hashIdx(s, n) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % n; }

function initials(name) {
  const w = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter((x) => x && !/^(the|of|and|a|for|se|sse)$/i.test(x));
  return (w.slice(0, 2).map((x) => x[0]).join("") || name.slice(0, 2)).toUpperCase();
}

function thumbHTML(name, picture, category, cls = "ph") {
  const ph = PH_COLORS[hashIdx(category || name, PH_COLORS.length)];
  const fallback = `<div class="${cls}" style="--ph:${ph}"><span>${esc(initials(name))}</span></div>`;
  const src = safeUrl(picture);
  if (!src) return fallback;
  return `${fallback}<img loading="lazy" src="${esc(src)}" alt="">`;
}

function dotsHTML(rec) {
  return `<span class="dots">${S.lists.map((l) => {
    const on = !!rec.entries[l.name];
    return `<i class="ldot ${on ? "" : "off"} ${on && rec.vdiff ? "vdiff" : ""}" style="--c:${l.color}" title="${esc(l.name)}: ${on ? "present" : "absent"}"></i>`;
  }).join("")}</span>`;
}

function decBadge(key) {
  const d = decOf(key)?.decision;
  return d ? `<span class="badge ${d}">${d}</span>` : "";
}

function noteHTML(key) {
  const n = decOf(key)?.note;
  return n ? `<div class="cnote" title="${esc(n)}">${esc(n)}</div>` : "";
}

function quickHTML(key) {
  const d = decOf(key)?.decision || "";
  return `<span class="quick">${[["keep", "k", "K"], ["drop", "d", "D"], ["maybe", "m", "?"]].map(([v, c, t]) =>
    `<button class="${c} ${d === v ? "on" : ""}" data-act="quick" data-key="${esc(key)}" data-dec="${v}" title="${v}">${t}</button>`).join("")}<button class="c" data-act="comment" data-key="${esc(key)}" title="Comment">💬</button></span>`;
}

// ------------------------------------------------------------------ bulk edit (hidden behind the "Select" toggle)

function selectToggleHTML() {
  return S.local ? `<button class="toggle ${S.bulk ? "on" : ""}" data-act="bulk-toggle" aria-pressed="${S.bulk}">☑ Select</button>` : "";
}

function pickCell(key, name) {
  return `<td class="pickcell"><input type="checkbox" data-act="pick" data-key="${esc(key)}" aria-label="Select ${esc(name)}" ${S.picked.has(key) ? "checked" : ""}></td>`;
}

// header checkbox: selects or unselects every matching mod (not just the rows rendered so far)
function pickHeadCell(keys) {
  const on = keys.some((k) => S.picked.has(k));
  const all = keys.length > 0 && keys.every((k) => S.picked.has(k));
  return `<th class="pickcell"><input type="checkbox" data-act="pick-head" aria-label="Select all matching"
    ${all ? "checked" : ""} ${on && !all ? "data-some" : ""}></th>`;
}

function bulkBarHTML(shownKeys) {
  if (!S.bulk) return "";
  const shown = new Set(shownKeys);
  const hidden = [...S.picked].filter((k) => !shown.has(k)).length;
  const allOn = shown.size > 0 && [...shown].every((k) => S.picked.has(k));
  return `<div class="bulkbar" role="region" aria-label="Bulk edit">
    <span class="bulk-count"><b>${S.picked.size}</b> selected${hidden ? ` <span class="muted">(${hidden} not matching filters)</span>` : ""}</span>
    <button class="btn ghost" data-act="${allOn ? "unpick-shown" : "pick-shown"}">${allOn ? "Unselect" : "Select"} all ${shown.size} matching</button>
    ${S.picked.size ? `<button class="btn ghost" data-act="pick-none">Clear</button>` : ""}
    <span class="spacer"></span>
    <select class="select" data-act="bulk-dec" aria-label="Decision">${[["unchanged", "Decision unchanged"], ["keep", "Keep"], ["drop", "Drop"], ["maybe", "Maybe"], ["", "Undecided"]]
      .map(([v, t]) => `<option value="${v}" ${S.bulkDec === v ? "selected" : ""}>${t}</option>`).join("")}</select>
    <input class="bulk-note" data-act="bulk-note" maxlength="2000" value="${esc(S.bulkNote)}" placeholder="Comment (replaces existing; empty = keep)" aria-label="Comment">
    <button class="btn primary" data-act="bulk-apply" ${S.picked.size ? "" : "disabled"}>Apply</button></div>`;
}

async function applyBulk() {
  const patch = {};
  if (S.bulkDec !== "unchanged") patch.decision = S.bulkDec;
  if (S.bulkNote.trim()) patch.note = S.bulkNote.trim();
  if (!Object.keys(patch).length) { toast("Pick a decision or write a comment first"); return; }
  const n = new Set([...S.picked].map(decKey)).size;
  const what = [patch.decision !== undefined && `set ${patch.decision || "undecided"}`, patch.note && "replace their comment"].filter(Boolean).join(" and ");
  if (!window.confirm(`${what[0].toUpperCase() + what.slice(1)} for ${n} mod${n === 1 ? "" : "s"}?`)) return;
  if (await saveDecisions([...S.picked], patch)) {
    S.picked.clear();
    render();
    toast(`Updated ${n} mod${n === 1 ? "" : "s"}`);
  }
}

function sourceLabel(l) {
  if (l.source === "loadorderlibrary") return `Load Order Library${l.author ? " · by " + esc(l.author) : ""}`;
  if (l.source === "upload") return "Uploaded profile files";
  return `MO2 profile <b>${esc(l.profile || "")}</b>`;
}

function relTime(iso) {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 45) return `${Math.round(d / 86400)} days ago`;
  return new Date(iso).toLocaleDateString();
}

// ------------------------------------------------------------------ main render

function render() {
  if (!S.lists.length) { $("#app").innerHTML = firstRunHTML(); renderFooter(); return; }
  const token = focusToken();
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === S.ui.tab)));
  if (location.hash.slice(1) !== S.ui.tab) history.replaceState(null, "", "#" + S.ui.tab);
  renderListbar();
  const changed = S.local && Object.values(S.local.lists || {}).some((s) => s.changed);
  $("#changedDot").hidden = !changed;
  if (S.ui.tab === "compare") renderCompare();
  else if (S.ui.tab === "overview") renderOverview();
  else renderBrowse();
  // "some selected" can't be expressed in HTML; set the header checkbox's dash after rendering
  document.querySelectorAll("input[data-some]").forEach((el) => { el.indeterminate = true; });
  if (token) document.querySelector(token)?.focus({ preventScroll: true });
  renderFooter();
  saveUI();
}

function renderFooter() {
  const problem = S.statusProblem ? `<div class="footer-problem">⚠ ${esc(S.statusProblem)}</div>` : "";
  $("#footer").innerHTML = problem + (S.local
    ? `Local mode · lists, decisions and caches are stored on this PC`
    : `Read-only view · run <code>python tools/serve.py</code> locally to add lists and record decisions`);
}

// Re-rendering replaces the DOM; remember what had focus so keyboard users don't lose their place.
function focusToken() {
  const el = document.activeElement;
  if (!el || el === document.body || !el.dataset) return null;
  if (el.id === "search") return null;
  const parts = ["act", "key", "list", "v", "k", "facet", "dec", "sig"].filter((a) => el.dataset[a] !== undefined)
    .map((a) => `[data-${a}="${CSS.escape(el.dataset[a])}"]`);
  return parts.length ? parts.join("") : null;
}

function renderListbar() {
  const tab = S.ui.tab;
  let label = "List";
  if (tab === "compare") label = "Filter";
  if (tab === "overview") label = "Lists";
  const chips = S.lists.map((l) => {
    const lock = l.frozen ? `<span class="lock" title="Frozen">🔒</span>` : "";
    if (tab === "compare") {
      const st = S.ui.tri[l.name] || "any";
      const lbl = st === "in" ? "in" : st === "out" ? "not in" : "any";
      return `<button class="chip ${st !== "any" ? "tri-" + st : ""}" style="--c:${l.color}" data-act="tri" data-list="${esc(l.name)}" title="Click to cycle: any → in → not in">
        <span class="swatch"></span>${esc(l.name)} <span class="tri-label">${lbl}</span>${lock}</button>`;
    }
    const active = tab === "browse" && l.name === S.ui.primary;
    return `<button class="chip ${active ? "active" : ""}" style="--c:${l.color}" data-act="primary" data-list="${esc(l.name)}" title="${esc(l.title || l.name)}">
      <span class="swatch"></span>${esc(l.name)} <span class="count">${l.mods}</span>${lock}</button>`;
  }).join("");
  const reset = tab === "compare" && Object.values(S.ui.tri).some((v) => v && v !== "any")
    ? `<button class="btn ghost" data-act="tri-reset">Reset</button>` : "";
  $("#listbar").innerHTML = `<span class="listbar-label">${label}</span>${chips}${reset}`;
}

// ------------------------------------------------------------------ sidebar

function facetHTML(title, facet, items, selected, showAll, allKey, sortedByCount = true) {
  const max = Math.max(1, ...items.map((i) => i.n));
  const limit = 12;
  const shown = showAll ? items : items.slice(0, limit);
  const clear = selected.length ? `<button data-act="facet-clear" data-facet="${facet}">clear</button>` : "";
  return `<div class="facet"><h3>${esc(title)}${clear}</h3><div class="facet-items">
    ${shown.map((i) => `<button class="facet-item ${selected.includes(i.v) ? "on" : ""}" data-act="facet" data-facet="${facet}" data-v="${esc(i.v)}">
      <span class="lbl" title="${esc(i.v)}">${esc(i.v)}</span>${sortedByCount ? `<span class="bar"><i style="width:${(i.n / max) * 100}%"></i></span>` : ""}<span class="n">${i.n}</span></button>`).join("")}
    </div>${items.length > limit ? `<button class="more" data-act="toggle-ui" data-k="${allKey}">${showAll ? "Show fewer" : `Show all ${items.length}`}</button>` : ""}</div>`;
}

function countBy(rows, fn) {
  const m = new Map();
  for (const r of rows) { const k = fn(r); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

function segHTML(k, options) {
  return `<div class="seg">${options.map(([v, t]) => `<button class="${S.ui[k] === v ? "on" : ""}" data-act="set-ui" data-k="${k}" data-v="${v}">${t}</button>`).join("")}</div>`;
}

function decisionFacet(rows, keyFn) {
  const counts = { keep: 0, drop: 0, maybe: 0, none: 0 };
  for (const r of rows) counts[decOf(keyFn(r))?.decision || "none"]++;
  const items = [["all", "All"], ["keep", "Keep"], ["drop", "Drop"], ["maybe", "Maybe"], ["none", "Undecided"]];
  return `<div class="facet"><h3>Decision</h3><div class="facet-items">${items.map(([v, t]) =>
    `<button class="facet-item ${S.ui.decision === v ? "on" : ""}" data-act="set-ui" data-k="decision" data-v="${v}">
      <span class="lbl">${t}</span><span class="n">${v === "all" ? rows.length : counts[v]}</span></button>`).join("")}</div></div>`;
}

function sidebarBrowse() {
  const catRows = browseFiltered("cats");
  const cats = [...countBy(catRows, catOf)].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n || a.v.localeCompare(b.v));
  const secRows = browseFiltered("secs");
  const secCounts = countBy(secRows, (m) => m.section);
  const order = [];
  for (const m of S.data[S.ui.primary] || []) if (!order.includes(m.section)) order.push(m.section);
  const secs = order.filter((s) => secCounts.has(s)).map((v) => ({ v, n: secCounts.get(v) }));
  const st = browseFiltered("status");
  const on = st.filter((m) => m.enabled).length;
  return `<div class="facet"><h3>Status</h3>${segHTML("status", [["all", `All ${st.length}`], ["enabled", `On ${on}`], ["disabled", `Off ${st.length - on}`]])}</div>
    ${decisionFacet(browseFiltered("decision"), (m) => m.ck)}
    ${facetHTML("Category", "cats", cats, S.ui.cats, S.ui.allCats, "allCats")}
    ${facetHTML("Separator", "secs", secs, S.ui.secs, S.ui.allSecs, "allSecs", false)}`;
}

function sidebarCompare() {
  const catRows = compareFiltered("cats");
  const cats = [...countBy(catRows, (r) => r.category)].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n || a.v.localeCompare(b.v));
  return `<div class="facet"><h3>Show</h3><div class="toggles">
      <button class="toggle ${S.ui.onlyVdiff ? "on" : ""}" data-act="toggle-ui" data-k="onlyVdiff">Versions differ</button></div></div>
    ${decisionFacet(compareFiltered("decision"), (r) => r.key)}
    ${facetHTML("Category", "cats", cats, S.ui.cats, S.ui.allCats, "allCats")}`;
}

function activeFilterPills() {
  const pills = [];
  if (S.search) pills.push(["search", `“${S.search}”`]);
  for (const c of S.ui.cats) pills.push(["cat:" + c, c]);
  if (S.ui.tab === "browse") for (const s of S.ui.secs) pills.push(["sec:" + s, "⟡ " + s]);
  if (S.ui.decision !== "all") pills.push(["decision", S.ui.decision === "none" ? "Undecided" : S.ui.decision]);
  if (S.ui.tab === "browse" && S.ui.status !== "all") pills.push(["status", S.ui.status]);
  if (!pills.length) return "";
  return `<div class="active-filters">${pills.map(([k, t]) => `<span class="pill">${esc(t)}<button data-act="unpill" data-k="${esc(k)}" aria-label="Remove filter">×</button></span>`).join("")}
    <button class="btn ghost" data-act="clear-all" style="padding:2px 8px;font-size:12px">Clear all</button></div>`;
}

function layout(sidebar, main) {
  // keep the sidebar's scroll position and its open state (mobile filter drawer) across re-renders
  const old = $("#sidebar");
  const scroll = old ? old.scrollTop : 0;
  const open = old?.classList.contains("open");
  $("#app").innerHTML = `<div class="layout"><aside class="sidebar ${open ? "open" : ""}" id="sidebar" aria-label="Filters">${sidebar}</aside><section>${main}</section></div>`;
  $("#sidebar").scrollTop = scroll;
}

// ------------------------------------------------------------------ browse

function renderBrowse() {
  const list = listByName(S.ui.primary);
  const rows = browseFiltered();
  const total = (S.data[S.ui.primary] || []).length;
  let groups;
  if (S.ui.groupBy === "section") {
    groups = new Map();
    for (const m of rows) (groups.get(m.section) || groups.set(m.section, []).get(m.section)).push(m);
  } else if (S.ui.groupBy === "category") {
    groups = new Map([...countBy(rows, catOf).keys()].sort((a, b) => (a === "Uncategorized") - (b === "Uncategorized") || a.localeCompare(b)).map((c) => [c, []]));
    for (const m of [...rows].sort((a, b) => a.name.localeCompare(b.name))) groups.get(catOf(m)).push(m);
  } else {
    const sorted = [...rows];
    if (S.ui.sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    if (S.ui.sort === "category") sorted.sort((a, b) => catOf(a).localeCompare(catOf(b)) || a.name.localeCompare(b.name));
    groups = new Map([["", sorted]]);
  }
  S.navKeys = [...groups.values()].flat().map((m) => ({ key: m.ck, list: m.list }));

  let sub = `${sourceLabel(list)} · snapshot ${esc(relTime(list.generated))}`;
  if (list.source === "loadorderlibrary") { // lists imported by older versions of the tool
    const srcUrl = safeUrl(list.url);
    sub = `Imported from ${srcUrl ? `<a href="${esc(srcUrl)}" target="_blank" rel="noopener noreferrer">Load Order Library</a>` : "Load Order Library"} · names only, details borrowed from your other lists`;
  } else if (list.source === "upload") {
    sub = `Uploaded profile files · ${esc(relTime(list.generated))} · names only, details borrowed from your other lists`;
  }
  const toolbar = `<div class="toolbar">
      <div><h2>${esc(list.title || list.name)}</h2><div class="meta">${sub} · <b>${rows.length}</b> of ${total} mods</div></div>
      <span class="spacer"></span>
      <label class="muted" for="groupBy">Group</label>
      <select class="select" id="groupBy" data-act="select-ui" data-k="groupBy">
        ${[["section", "Separator (MO2 order)"], ["category", "Category"], ["none", "No grouping"]].map(([v, t]) => `<option value="${v}" ${S.ui.groupBy === v ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      ${S.ui.groupBy === "none" ? `<select class="select" data-act="select-ui" data-k="sort" aria-label="Sort">
        ${[["priority", "Priority"], ["name", "Name"], ["category", "Category"]].map(([v, t]) => `<option value="${v}" ${S.ui.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select>` : ""}
      ${segHTML("view", [["cards", "Cards"], ["table", "Table"]])}
      ${selectToggleHTML()}
    </div>${activeFilterPills()}${bulkBarHTML(rows.map((m) => m.ck))}`;

  let body;
  if (!rows.length) body = emptyState("Nothing matches", "Try clearing a filter or the search.");
  else if (S.ui.view === "table") body = browseTable(groups);
  else body = [...groups].map(([g, ms]) => `<div class="group">${g ? `<div class="group-head">${esc(g)} <span class="n">${ms.length}</span></div>` : ""}
      <div class="cards">${ms.map(cardHTML).join("")}</div></div>`).join("");
  layout(sidebarBrowse(), toolbar + body);
}

function cardHTML(m) {
  const rec = recOf(m);
  const cat = catOf(m);
  // in select mode a card click picks the mod instead of opening it
  const pick = S.bulk ? ` aria-pressed="${S.picked.has(m.ck)}"` : "";
  return `<button class="card ${m.enabled ? "" : "disabled"} ${S.bulk && S.picked.has(m.ck) ? "picked" : ""}" data-act="${S.bulk ? "pick" : "open"}" data-key="${esc(m.ck)}" data-list="${esc(m.list)}"${pick}>
    <div class="thumb">${thumbHTML(m.name, rec.picture, cat)}${S.bulk ? `<span class="pickmark" aria-hidden="true"></span>` : ""}
      <div class="badges"><span>${m.enabled ? "" : `<span class="badge off">disabled</span>`}</span>${decBadge(m.ck)}</div></div>
    <div class="card-body">
      <div class="card-cat">${esc(cat)}</div>
      <div class="card-title">${esc(m.name)}</div>
      <div class="card-sum">${esc(sumOf(m)) || `<span class="muted">No description</span>`}</div>
      <div class="card-foot"><span>#${m.priority}${m.version ? ` · v${esc(m.version)}` : ""}${decOf(m.ck)?.note ? ` · <span title="${esc(decOf(m.ck).note)}">💬</span>` : ""}</span>${dotsHTML(rec)}</div>
    </div></button>`;
}

function browseTable(groups) {
  const showSec = S.ui.groupBy !== "section";
  const cols = 7 + (showSec ? 1 : 0) + (S.bulk ? 1 : 0);
  let html = `<div class="table-wrap"><table><thead><tr>${S.bulk ? pickHeadCell([...groups.values()].flat().map((m) => m.ck)) : ""}<th class="num">#</th><th>Mod</th><th>Category</th>${showSec ? "<th>Separator</th>" : ""}
    <th>Version</th><th>Lists</th><th>Decision</th><th>Description</th></tr></thead><tbody>`;
  for (const [g, ms] of groups) {
    if (g) html += `<tr class="subhead"><td colspan="${cols}">${esc(g)} · ${ms.length}</td></tr>`;
    for (const m of ms) {
      const rec = recOf(m);
      const d = decOf(m.ck)?.decision;
      html += `<tr class="${m.enabled ? "" : "disabled"}" tabindex="0" data-act="open" data-key="${esc(m.ck)}" data-list="${esc(m.list)}">
        ${S.bulk ? pickCell(m.ck, m.name) : ""}<td class="num">${m.priority}</td><td><span class="tname">${esc(m.name)}</span></td><td class="tcat">${esc(catOf(m))}</td>
        ${showSec ? `<td class="muted">${esc(m.section)}</td>` : ""}<td class="muted">${esc(m.version)}</td><td>${dotsHTML(rec)}</td>
        <td>${d ? `<span class="dec ${d}">${d}</span> ` : ""}${quickHTML(m.ck)}${noteHTML(m.ck)}</td><td><div class="tsum">${esc(sumOf(m))}</div></td></tr>`;
    }
  }
  return html + "</tbody></table></div>";
}

// ------------------------------------------------------------------ compare

function sigOf(rec) { return S.lists.map((l) => (rec.entries[l.name] ? "1" : "0")).join(""); }

function sigLabel(sig) {
  const ins = S.lists.filter((_, i) => sig[i] === "1").map((l) => l.name);
  if (ins.length === 1) return `only ${ins[0]}`;
  if (ins.length === S.lists.length && ins.length > 2) return "in all lists";
  return ins.join(" + ");
}

function sigBackground(sig) {
  const cs = S.lists.filter((_, i) => sig[i] === "1").map((l) => l.color);
  if (cs.length === 1) return cs[0];
  const w = 7;
  return `repeating-linear-gradient(135deg, ${cs.map((c, i) => `${c} ${i * w}px ${(i + 1) * w}px`).join(", ")})`;
}

function triMatchesSig(sig) {
  return S.lists.every((l, i) => (S.ui.tri[l.name] || "any") === (sig[i] === "1" ? "in" : "out"));
}

function renderCompare() {
  const rows = compareFiltered();
  const base = compareFiltered("tri");
  const sigs = [...countBy(base, sigOf)].sort((a, b) => b[1] - a[1]);
  const total = base.length || 1;
  const overlap = `<div class="overlap"><h3>Overlap · ${base.length} unique mods</h3>
    <div class="obar">${sigs.map(([sig, n]) => `<button class="oseg ${triMatchesSig(sig) ? "on" : ""}" style="flex:${n};--seg:${sigBackground(sig)}" data-act="sig" data-sig="${sig}" title="${esc(sigLabel(sig))}: ${n}"></button>`).join("")}</div>
    <div class="olegend">${sigs.map(([sig, n]) => `<button class="${triMatchesSig(sig) ? "on" : ""}" data-act="sig" data-sig="${sig}"><span class="sw" style="--seg:${sigBackground(sig)}"></span>${esc(sigLabel(sig))} <b>${n}</b><span class="muted">${Math.round((n / total) * 100)}%</span></button>`).join("")}</div></div>`;

  const sorters = {
    name: (a, b) => recName(a).localeCompare(recName(b)),
    category: (a, b) => a.category.localeCompare(b.category) || recName(a).localeCompare(recName(b)),
    lists: (a, b) => sigOf(b).localeCompare(sigOf(a)) || recName(a).localeCompare(recName(b)),
  };
  rows.sort(sorters[S.ui.csort] || sorters.lists);
  S.navKeys = rows.map((r) => ({ key: r.key, list: null }));
  const shown = rows.slice(0, S.compareLimit);
  const th = (k, t) => `<th class="sortable" data-act="csort" data-k="${k}">${t} ${S.ui.csort === k ? '<span class="arrow">▾</span>' : ""}</th>`;
  const table = rows.length ? `<div class="table-wrap"><table><thead><tr>${S.bulk ? pickHeadCell(rows.map((r) => r.key)) : ""}${th("name", "Mod")}${th("category", "Category")}
      ${S.lists.map((l) => `<th title="${esc(l.title || l.name)}"><span class="dots"><i class="ldot" style="--c:${l.color}"></i></span> ${esc(l.name)}</th>`).join("")}
      <th>Decision</th><th>Description</th></tr></thead><tbody>
      ${shown.map((rec) => {
        const d = decOf(rec.key)?.decision;
        const nFiles = Math.max(...Object.values(rec.entries).map((e) => e.length));
        return `<tr tabindex="0" data-act="open" data-key="${esc(rec.key)}">${S.bulk ? pickCell(rec.key, recName(rec)) : ""}<td><span class="tname">${esc(recName(rec))}</span>${nFiles > 1 ? `<span class="files">+${nFiles - 1} file${nFiles > 2 ? "s" : ""}</span>` : ""}${rec.vdiff ? `<span class="vtag">versions differ</span>` : ""}</td>
          <td class="tcat">${esc(rec.category)}</td>
          ${S.lists.map((l) => {
            const e = rec.entries[l.name];
            const tip = e ? `${e[0].name}${e[0].version ? " v" + e[0].version : ""}${e[0].enabled ? "" : " (disabled)"}` : "absent";
            return `<td title="${esc(l.name + ": " + tip)}"><span class="dots"><i class="ldot ${e ? "" : "off"} ${e && rec.vdiff ? "vdiff" : ""}" style="--c:${l.color};${e && !e[0].enabled ? "opacity:.45" : ""}"></i></span>${e && rec.vdiff && e[0].version ? ` <span class="muted" style="font-size:11px">${esc(e[0].version)}</span>` : ""}</td>`;
          }).join("")}
          <td>${d ? `<span class="dec ${d}">${d}</span> ` : ""}${quickHTML(rec.key)}${noteHTML(rec.key)}</td>
          <td><div class="tsum">${esc(rec.summary || "")}</div></td></tr>`;
      }).join("")}</tbody></table></div>${rows.length > shown.length ? `<p class="more-row"><span class="muted">Showing ${shown.length} of ${rows.length}</span> <button class="btn" data-act="more-rows">Show ${Math.min(500, rows.length - shown.length)} more</button></p>` : ""}`
    : emptyState("Nothing matches", "Change the list filters above or clear the search.");

  const toolbar = `<div class="toolbar"><div><h2>Compare</h2><div class="meta"><b>${rows.length}</b> mods match · click list chips to cycle <i>any → in → not in</i>, or pick an overlap segment</div></div>
    <span class="spacer"></span>${selectToggleHTML()}<button class="btn" data-act="csv">Download CSV</button></div>${activeFilterPills()}${bulkBarHTML(rows.map((r) => r.key))}`;
  layout(sidebarCompare(), toolbar + overlap + table);
}

// ------------------------------------------------------------------ overview

function renderOverview() {
  const cards = S.lists.map((l) => {
    const src = S.local?.lists?.[l.name];
    const sub = sourceLabel(l);
    const acts = [`<button class="btn" data-act="goto-browse" data-list="${esc(l.name)}">Browse</button>`];
    if (S.local && src) acts.push(`<button class="btn" data-act="resnap" data-list="${esc(l.name)}">Re-snapshot</button>`);
    if (S.local) acts.push(`<button class="btn ghost" data-act="freeze" data-list="${esc(l.name)}">${l.frozen ? "Unfreeze" : "Freeze"}</button>`);
    if (S.local) acts.push(`<button class="btn ghost danger" data-act="delete-list" data-list="${esc(l.name)}">Delete</button>`);
    const src2 = safeUrl(l.website) || safeUrl(l.url);
    if (src2) acts.push(`<a class="btn ghost" href="${esc(src2)}" target="_blank" rel="noopener noreferrer">Source ↗</a>`);
    return `<div class="stat" style="--c:${l.color}">
      <h3>${esc(l.name)} ${l.frozen ? '<span title="Frozen" style="font-size:13px">🔒</span>' : ""}</h3>
      <div class="sub">${esc(l.title && l.title !== l.name ? l.title : "")}<br>${sub} · ${esc(relTime(l.generated))}</div>
      <div class="nums"><div><b>${l.mods}</b><span>Mods</span></div><div><b>${l.enabled}</b><span>Enabled</span></div><div><b>${l.active_plugins ?? l.plugins}</b><span>Plugins</span></div></div>
      ${src?.changed ? `<div class="changed">● MO2 changed since this snapshot</div>` : ""}
      <div class="acts">${acts.join("")}</div></div>`;
  }).join("");

  // categories per list (unique mods)
  const perList = S.lists.map((l) => {
    const seen = new Set(); const m = new Map();
    for (const mod of S.data[l.name]) { if (seen.has(mod.ck)) continue; seen.add(mod.ck); const c = catOf(mod); m.set(c, (m.get(c) || 0) + 1); }
    return m;
  });
  const allCats = new Set(perList.flatMap((m) => [...m.keys()]));
  const catRows = [...allCats].map((c) => ({ c, max: Math.max(...perList.map((m) => m.get(c) || 0)) })).sort((a, b) => (a.c === "Uncategorized") - (b.c === "Uncategorized") || b.max - a.max);
  const shownCats = S.ui.chartAll ? catRows : catRows.slice(0, 14);
  const gmax = Math.max(1, ...catRows.map((r) => r.max));
  const chart = `<div class="panel"><h3>Categories</h3><p class="hint">Unique mods per Nexus category in each list. Click a category to browse it.</p>
    <div class="legend">${S.lists.map((l) => `<span><i style="--c:${l.color}"></i>${esc(l.name)}</span>`).join("")}</div>
    <div class="catchart">${shownCats.map(({ c }) => `<div class="cl" data-act="goto-cat" data-v="${esc(c)}" title="${esc(c)}">${esc(c)}</div>
      <div class="bars">${S.lists.map((l, i) => { const n = perList[i].get(c) || 0; return `<div class="b" style="--c:${l.color};width:${(n / gmax) * 85}%" title="${esc(l.name)}: ${n}"><span>${n || ""}</span></div>`; }).join("")}</div>`).join("")}</div>
    ${catRows.length > 14 ? `<button class="more btn ghost" data-act="toggle-ui" data-k="chartAll" style="margin-top:10px">${S.ui.chartAll ? "Show fewer" : `Show all ${catRows.length}`}</button>` : ""}</div>`;

  // migration progress for the base list
  const baseName = S.ui.ovBase;
  const baseKeys = [...new Set((S.data[baseName] || []).map((m) => m.ck))];
  const cnt = { keep: 0, drop: 0, maybe: 0, none: 0 };
  for (const k of baseKeys) cnt[decOf(k)?.decision || "none"]++;
  const tot = baseKeys.length || 1;
  const decided = cnt.keep + cnt.drop + cnt.maybe;
  const progress = `<div class="panel"><h3>Decisions</h3>
    <p class="hint">Keep / drop / maybe for every mod in
      <select class="select" data-act="select-ui" data-k="ovBase">${S.lists.map((l) => `<option ${l.name === baseName ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></p>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px"><span class="big-pct">${Math.round((decided / tot) * 100)}%</span><span class="muted">${decided} of ${baseKeys.length} decided</span></div>
    <div class="progress"><i style="width:${(cnt.keep / tot) * 100}%;background:var(--keep)"></i><i style="width:${(cnt.maybe / tot) * 100}%;background:var(--maybe)"></i><i style="width:${(cnt.drop / tot) * 100}%;background:var(--drop)"></i></div>
    <div class="prog-legend">${[["keep", "Keep", "var(--keep)"], ["maybe", "Maybe", "var(--maybe)"], ["drop", "Drop", "var(--drop)"], ["none", "Undecided", "var(--muted)"]].map(([v, t, c]) =>
      `<button data-act="goto-decision" data-v="${v}"><span>${t}</span><b style="color:${c}">${cnt[v]}</b></button>`).join("")}</div></div>`;

  // pairwise overlap
  const keySets = S.lists.map((l) => new Set(S.data[l.name].map((m) => m.ck)));
  const matrix = `<div class="panel"><h3>Shared mods</h3><p class="hint">Unique mods two lists have in common (diagonal: list size). Click a cell to compare.</p>
    <div style="overflow:auto"><table class="matrix"><tr><th></th>${S.lists.map((l) => `<th style="color:${l.color}">${esc(l.name)}</th>`).join("")}</tr>
    ${S.lists.map((a, i) => `<tr><th style="color:${a.color};text-align:right">${esc(a.name)}</th>${S.lists.map((b, j) => {
      let n = 0; for (const k of keySets[i]) if (keySets[j].has(k)) n++;
      const pct = n / Math.max(1, Math.min(keySets[i].size, keySets[j].size));
      return `<td data-act="pair" data-a="${esc(a.name)}" data-b="${esc(b.name)}" style="cursor:pointer;background:color-mix(in srgb, var(--gold) ${Math.round(pct * (i === j ? 18 : 55))}%, var(--panel-2))">${n}</td>`;
    }).join("")}</tr>`).join("")}</table></div></div>`;

  $("#app").innerHTML = `<div class="layout wide"><section>
    <div class="toolbar"><div><h2>Overview</h2><div class="meta">${S.lists.length} lists · ${S.catalog.size} unique mods across all of them</div></div></div>
    <div class="ov-grid">${cards}</div>
    <div class="two-col"><div>${chart}</div><div>${progress}${matrix}</div></div></section></div>`;
}

// ------------------------------------------------------------------ BBCode -> HTML (escaped first, then a safe subset)

function bbcode(src) {
  let s = esc(String(src || "").replace(/<[^>]+>/g, ""));
  const ok = (u) => /^https?:\/\//i.test(u);
  s = s.replace(/\[img[^\]]*\]\s*([\s\S]*?)\s*\[\/img\]/gi, (_, u) => (ok(u) ? `<img loading="lazy" src="${u}" alt="" referrerpolicy="no-referrer">` : ""));
  s = s.replace(/\[url=(?:&quot;|&#39;)?([^\]]*?)(?:&quot;|&#39;)?\]([\s\S]*?)\[\/url\]/gi, (_, u, t) => (ok(u) ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>` : t));
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_, u) => (ok(u) ? `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>` : u));
  s = s.replace(/\[youtube\]\s*([\w-]+)\s*\[\/youtube\]/gi, (_, id) => `<a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener noreferrer">▶ YouTube video</a>`);
  s = s.replace(/\[spoiler[^\]]*\]/gi, "<details><summary>Spoiler</summary>").replace(/\[\/spoiler\]/gi, "</details>");
  s = s.replace(/\[quote[^\]]*\]/gi, "<blockquote>").replace(/\[\/quote\]/gi, "</blockquote>");
  s = s.replace(/\[code\]/gi, "<pre>").replace(/\[\/code\]/gi, "</pre>");
  s = s.replace(/\[list[^\]]*\]/gi, "<ul>").replace(/\[\/list\]/gi, "</ul>").replace(/\[\*\]/g, "<li>");
  s = s.replace(/\[(\/?)(b|i|u|s)\]/gi, "<$1$2>");
  s = s.replace(/\[center\]/gi, '<div class="center">').replace(/\[(left|right)\]/gi, "<div>").replace(/\[\/(center|left|right)\]/gi, "</div>");
  s = s.replace(/\[size=["']?(\d)["']?\]/gi, (_, n) => (+n >= 4 ? '<span class="big">' : "<span>")).replace(/\[\/size\]/gi, "</span>");
  s = s.replace(/\[line\]/gi, "<hr>");
  s = s.replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, "");
  s = s.replace(/(<br>\s*){3,}/g, "<br><br>").replace(/\n{3,}/g, "\n\n").replace(/\n/g, "<br>");
  return s;
}

// ------------------------------------------------------------------ drawer

async function openDrawer(key, listName, keepFocus = false) {
  const rec = S.catalog.get(key);
  if (!rec) return;
  // remember what opened the drawer as a selector: a decision re-renders the list and replaces that element
  if (!S.selected) S.lastFocus = focusToken() || (listName ? `[data-act="open"][data-key="${CSS.escape(key)}"][data-list="${CSS.escape(listName)}"]` : `[data-act="open"][data-key="${CSS.escape(key)}"]`);
  S.selected = { key, list: listName };
  const primary = (listName && rec.entries[listName]?.[0]) || rec.entries[S.ui.primary]?.[0] || Object.values(rec.entries)[0][0];
  const name = primary.name;
  const cat = primary.category && primary.category !== "Uncategorized" ? primary.category : rec.category;
  const dec = decOf(key) || {};
  const url = safeUrl(primary.url) || safeUrl(rec.url);
  const facts = [
    ["Category", cat], ["Version", primary.version || "—"],
    ["Separator", primary.section], ["Priority", `#${primary.priority} in ${primary.list}`],
  ];
  if (rec.author) facts.push(["Author", rec.author]);
  if (rec.endorsements) facts.push(["Endorsements", rec.endorsements.toLocaleString()]);
  const notes = Object.values(rec.entries).flat().map((m) => m.notes).filter(Boolean);
  const ro = !S.local;
  $("#drawer").innerHTML = `
    <div class="drawer-hero">${thumbHTML(name, rec.picture, cat)}<button class="drawer-close" data-act="close" aria-label="Close">×</button></div>
    <div class="drawer-body">
      <h2>${esc(name)}</h2>
      <div class="by">${rec.author ? `by ${esc(rec.author)} · ` : ""}${esc(cat)}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open on Nexus ↗</a>` : ""}</div>
      ${rec.summary || primary.summary ? `<p class="lead">${esc(rec.summary_source === "nexus" ? rec.summary : primary.summary || rec.summary)}</p>` : ""}
      <div class="decide">
        <div class="decide-btns">${[["keep", "k", "K"], ["drop", "d", "D"], ["maybe", "m", "M"]].map(([v, c, k]) =>
          `<button class="${c} ${dec.decision === v ? "on" : ""}" data-act="decide" data-dec="${v}" ${ro ? "disabled" : ""}>${v[0].toUpperCase() + v.slice(1)}<kbd>${k}</kbd></button>`).join("")}</div>
        <label class="note-label" for="decNote">Comment</label>
        <textarea id="decNote" placeholder="${ro ? "Read-only — run tools/serve.py to edit" : "Why keep or drop it? e.g. replaced by Lux, needs a patch"}" ${ro ? "disabled" : ""}>${esc(dec.note || "")}</textarea>
        <div class="saved" id="decSaved">${dec.updated ? "Saved " + esc(relTime(dec.updated)) : ""}</div>
        <div class="kbd-hint"><kbd>K</kbd><kbd>D</kbd><kbd>M</kbd> decide · <kbd>C</kbd> comment · <kbd>←</kbd><kbd>→</kbd> previous / next · <kbd>Esc</kbd> close</div>
      </div>
      <div class="facts">${facts.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>
      <div class="sec-title">In your lists</div>
      <div class="inlists">${S.lists.map((l) => {
        const e = rec.entries[l.name];
        if (!e) return `<div class="inlist absent"><i class="ldot off" style="--c:${l.color}"></i><span class="nm">${esc(l.name)}</span><span class="det">not in this list</span></div>`;
        return e.map((m) => `<div class="inlist"><i class="ldot" style="--c:${l.color}"></i><span class="nm">${esc(l.name)}</span>
          <span class="det" title="${esc(m.name)}">${esc(m.name)}${m.version ? " · v" + esc(m.version) : ""} · ${esc(m.section)}${m.enabled ? "" : " · disabled"}</span></div>`).join("");
      }).join("")}</div>
      ${notes.length ? `<div class="sec-title">Your MO2 notes</div>${notes.map((n) => `<div class="note-box">${esc(n)}</div>`).join("")}` : ""}
      <div class="sec-title">Nexus description</div>
      <div class="desc" id="descBox"><span class="muted"><span class="spinner"></span> Loading…</span></div>
    </div>`;
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("open");
  $("#drawer .drawer-body").scrollTop = 0;
  if (!keepFocus) $("#drawer .drawer-close").focus({ preventScroll: true });

  if (!S.descriptions) S.descriptions = await getJSON("data/descriptions.json").catch(() => ({}));
  if (S.selected?.key !== key) return;
  const keys = [key, ...Object.values(rec.entries).flat().map((m) => m.key)];
  const text = keys.map((k) => S.descriptions[k]).find(Boolean);
  $("#descBox").innerHTML = text ? bbcode(text) : `<span class="muted">No cached description${url ? ` — <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">see Nexus</a>` : ""}.</span>`;
}

function closeDrawer() {
  S.selected = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  if (!$("#sidebar")?.classList.contains("open")) $("#scrim").classList.remove("open");
  if (S.lastFocus) document.querySelector(S.lastFocus)?.focus({ preventScroll: true });
  S.lastFocus = null;
}

function navDrawer(delta) {
  if (!S.selected) return;
  const i = S.navKeys.findIndex((n) => n.key === S.selected.key && (n.list == null || n.list === S.selected.list));
  const next = S.navKeys[i + delta];
  if (next) openDrawer(next.key, next.list, true);
}

// ------------------------------------------------------------------ decisions

const saveDecision = (key, patch) => saveDecisions([key], patch);

// One request for any number of mods: the server applies them in a single locked, atomic write.
async function saveDecisions(keys, patch) {
  if (!S.local) { toast("Read-only — run python tools/serve.py to record decisions"); return false; }
  // send only the changed fields; the server merges, so a comment save can't undo a decision
  const body = {};
  for (const key of keys) {
    const rec = S.catalog.get(key);
    if (rec) body[decKey(key)] = { ...patch, name: recName(rec), name_key: normName(recName(rec)) };
  }
  try {
    const r = await fetch("api/decisions", { method: "POST", headers: API_HEADERS, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    for (const dk of Object.keys(body)) {
      const saved = j.saved?.[dk];
      if (saved) S.decisions[dk] = saved;
      else delete S.decisions[dk];
    }
    return true;
  } catch (e) {
    toast("Could not save: " + e.message);
    return false;
  }
}

async function decide(key, decision, focusNote = false) {
  const cur = decOf(key)?.decision;
  const next = cur === decision ? "" : decision;
  const ok = await saveDecision(key, { decision: next });
  if (!ok) return null;
  render();
  if (S.selected?.key === key) {
    await openDrawer(key, S.selected.list, true);
    if (focusNote && next) $("#decNote")?.focus();
  }
  return next;
}

// ------------------------------------------------------------------ add-list modal: MO2 profile / upload

// The server sends the allowed profile files and the list-name rule (/api/status); one source of truth.
const profileFileNames = () => (S.local?.profile_files || ["modlist.txt"]).map((f) => f.toLowerCase());
const isProfileIni = (name) => new RegExp(S.local?.profile_ini_pattern || "\\.ini$").test(name);
const nameRule = () => new RegExp(S.local?.name_pattern || "^[a-z0-9][a-z0-9._-]{0,40}$");
let uploads = []; // File objects picked for the upload tab
let modalTab = "mo2";

let modalReturnFocus = null;
function openModal(html) {
  modalReturnFocus = document.activeElement;
  $("#modal").innerHTML = `<div class="modal">${html}</div>`;
  $("#modal").classList.add("open");
  setTimeout(() => $("#modal input, #modal select, #modal button")?.focus(), 0);
}
function closeModal() {
  $("#modal").classList.remove("open");
  $("#modal").innerHTML = "";
  uploads = [];
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus({ preventScroll: true });
}

// keep Tab inside an open dialog or drawer
function trapFocus(ev, container) {
  const items = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea:not([disabled]), [tabindex="0"]')]
    .filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}

function nameHelp(n) {
  const l = listByName(n);
  if (!n) return "Lowercase letters, digits, <code>.</code> <code>_</code> <code>-</code>.";
  if (!nameRule().test(n)) return `<span style="color:var(--drop)">Use lowercase letters, digits, . _ - only.</span>`;
  return l ? `Replaces <b>${esc(n)}</b> (${l.mods} mods, ${esc(relTime(l.generated))})${l.frozen ? " — <b>frozen</b>, you'll be asked to confirm" : ""}.`
    : `Creates a new list <b>${esc(n)}</b>.`;
}

function nameField(id, value) {
  return `<div class="field"><label for="${id}">Save as</label><input id="${id}" class="list-name" list="listNames" value="${esc(value)}" placeholder="e.g. wip" spellcheck="false" autocomplete="off">
    <datalist id="listNames">${S.lists.map((l) => `<option value="${esc(l.name)}">`).join("")}</datalist>
    <div class="help" data-help-for="${id}">${nameHelp(value)}</div></div>`;
}

function openAddList(tab = "mo2", prefill = {}) {
  modalTab = tab;
  uploads = [];
  const tabs = [["mo2", "MO2 profile"], ["upload", "Upload files"]];
  openModal(`<div class="modal-head"><h2 id="modalTitle">Add or update a list</h2><button class="btn icon ghost" data-act="modal-close" aria-label="Close">×</button></div>
    <div class="modal-tabs" role="tablist">${tabs.map(([v, t]) => `<button role="tab" aria-selected="${v === tab}" data-act="modal-tab" data-v="${v}">${t}</button>`).join("")}</div>
    <div class="modal-body" id="modalBody"></div>`);
  renderModalTab(prefill);
}

function renderModalTab(prefill = {}) {
  document.querySelectorAll(".modal-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.v === modalTab)));
  const body = $("#modalBody");
  if (modalTab === "mo2") {
    const recent = Object.entries(S.local?.lists || {});
    body.innerHTML = `<p class="muted" style="margin-top:0">Copies a profile's modlist, plugins and INIs from a Mod Organizer 2 install into <code>lists/&lt;name&gt;/</code>, with Nexus links, categories and descriptions from each mod. MO2 is only read, never changed.</p>
      ${recent.length ? `<div class="field"><label>Refresh an existing snapshot</label><div class="recent">${recent.map(([n, s]) =>
        `<button data-act="snap-recent" data-list="${esc(n)}"><span><b>${esc(n)}</b> <span class="muted">← ${esc(s.profile)} · ${esc(s.mo2)}</span></span>
          ${s.available === false ? `<span class="chg">MO2 folder missing</span>` : s.changed ? `<span class="chg">● changed</span>` : `<span class="ok">up to date</span>`}</button>`).join("")}</div></div>` : ""}
      <div class="field"><label for="snapMo2">MO2 folder</label><input id="snapMo2" value="${esc(prefill.mo2 || S.local.mo2 || "")}" placeholder="Folder containing mods\\ and profiles\\" spellcheck="false">
        <div class="help">The Mod Organizer 2 folder that contains <code>mods</code> and <code>profiles</code>.</div><div class="err" id="snapMo2Err"></div></div>
      <div class="field"><label for="snapProfile">Profile</label><select id="snapProfile"></select></div>
      ${nameField("snapName", prefill.name || "")}
      <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn primary" id="goBtn" data-act="snap-go">Snapshot</button></div>
      <div id="modalLog"></div>`;
    loadProfiles(prefill.profile || S.local.profile);
    $("#snapMo2").addEventListener("change", () => loadProfiles());
    $("#snapProfile").addEventListener("change", suggestSnapName);
    $("#snapName").addEventListener("input", () => { $("#snapName").dataset.edited = "1"; });
    if (prefill.name) $("#snapName").dataset.edited = "1";
  } else if (modalTab === "upload") {
    body.innerHTML = `<p class="muted" style="margin-top:0">For lists whose MO2 install isn't on this PC: someone else's profile, an old backup, or a list shared online (save its <code>modlist.txt</code>). Drop a profile folder, a <code>.zip</code> of one, or the files themselves. <b>modlist.txt</b> is required; <code>plugins.txt</code>, <code>loadorder.txt</code> and INIs are optional.</p>
      <div class="dropzone" id="dropzone" tabindex="0">
        <div class="dz-rune">ᛉ</div>
        <div><b>Drop files, a folder or a .zip here</b></div>
        <div class="dz-actions"><button class="btn" data-act="pick-files">Choose files</button><button class="btn" data-act="pick-folder">Choose folder</button></div>
        <input type="file" id="fileInput" multiple accept=".txt,.ini,.zip" hidden>
        <input type="file" id="folderInput" webkitdirectory hidden>
      </div>
      <div class="file-chips" id="fileChips"></div>
      ${nameField("upName", prefill.name || "")}
      <div class="field"><label for="upTitle">Title (optional)</label><input id="upTitle" placeholder="e.g. Friend's survival list" maxlength="200"></div>
      <div class="help" style="margin:-6px 0 12px">Without the mods folder there are no Nexus IDs; mods are matched to your other lists by name.</div>
      <div class="modal-actions"><button class="btn ghost" data-act="modal-close">Cancel</button><button class="btn primary" id="goBtn" data-act="import-files">Import</button></div>
      <div id="modalLog"></div>`;
    const dz = $("#dropzone");
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", async (e) => {
      e.preventDefault(); dz.classList.remove("over");
      addUploads(await filesFromDrop(e.dataTransfer));
    });
    $("#fileInput").addEventListener("change", (e) => addUploads([...e.target.files]));
    $("#folderInput").addEventListener("change", (e) => addUploads([...e.target.files]));
    renderUploads();
  }
  document.querySelectorAll(".list-name").forEach((el) => el.addEventListener("input", () => updateNameHelp(el)));
}

function updateNameHelp(el) {
  const help = document.querySelector(`[data-help-for="${el.id}"]`);
  if (help) help.innerHTML = nameHelp(el.value.trim());
}

async function filesFromDrop(dt) {
  // walk dropped folders (webkitGetAsEntry) as well as plain files
  const out = [];
  const walk = (entry) => new Promise((resolve) => {
    if (entry.isFile) entry.file((f) => { out.push(f); resolve(); }, () => resolve());
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const read = () => reader.readEntries(async (ents) => {
        if (!ents.length) { await Promise.all(all.map(walk)); resolve(); return; }
        all.push(...ents); read();
      }, () => resolve());
      read();
    } else resolve();
  });
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.length) await Promise.all(entries.map(walk));
  else out.push(...dt.files);
  return out;
}

function addUploads(files) {
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (!(profileFileNames().includes(n) || isProfileIni(f.name) || n.endsWith(".zip"))) continue;
    uploads = uploads.filter((u) => u.name.toLowerCase() !== n);
    uploads.push(f);
  }
  renderUploads();
  const nm = $("#upName");
  if (nm && !nm.value) {
    const folder = (files.find((f) => f.webkitRelativePath)?.webkitRelativePath || "").split("/")[0];
    const zip = files.find((f) => f.name.toLowerCase().endsWith(".zip"))?.name.replace(/\.zip$/i, "");
    const guess = (folder || zip || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    if (guess) { nm.value = guess; updateNameHelp(nm); }
  }
}

function renderUploads() {
  const box = $("#fileChips");
  if (!box) return;
  const hasModlist = uploads.some((f) => f.name.toLowerCase() === "modlist.txt" || f.name.toLowerCase().endsWith(".zip"));
  box.innerHTML = uploads.length
    ? uploads.map((f, i) => `<span class="pill">${f.name.toLowerCase() === "modlist.txt" ? "★ " : ""}${esc(f.name)} <span class="muted">${(f.size / 1024).toFixed(1)} KB</span><button data-act="remove-upload" data-i="${i}" aria-label="Remove">×</button></span>`).join("")
      + (hasModlist ? "" : `<span class="err">modlist.txt is still missing</span>`)
    : `<span class="muted">No profile files picked yet.</span>`;
}

const readB64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",", 2)[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

async function postWithConfirm(url, body, onDone) {
  const go = $("#goBtn");
  const label = go.textContent;
  go.disabled = true;
  go.innerHTML = `<span class="spinner"></span> Working…`;
  try {
    const r = await fetch(url, { method: "POST", headers: API_HEADERS, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (r.status === 409 && j.confirm) {
      go.disabled = false; go.textContent = label;
      if (window.confirm(j.confirm)) return postWithConfirm(url, { ...body, confirm: true }, onDone);
      return;
    }
    $("#modalLog").innerHTML = `<div class="log">${esc(j.output || j.error || "")}</div>`;
    if (!r.ok || !j.ok) throw new Error(j.error || "Failed — see the log.");
    await loadAll();
    S.ui.primary = body.name;
    S.ui.tab = "browse";
    closeModal();
    render();
    toast(onDone);
  } catch (e) {
    go.disabled = false; go.textContent = label;
    toast(e.message);
  }
}

async function loadProfiles(select) {
  const mo2 = $("#snapMo2").value.trim();
  const sel = $("#snapProfile");
  $("#snapMo2Err").textContent = "";
  if (!mo2) { sel.innerHTML = ""; return; }
  try {
    const r = await fetch("api/profiles?mo2=" + encodeURIComponent(mo2));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    sel.innerHTML = j.profiles.map((p) => `<option ${p === select ? "selected" : ""}>${esc(p)}</option>`).join("");
    suggestSnapName();
  } catch (e) {
    sel.innerHTML = "";
    $("#snapMo2Err").textContent = e.message || "Folder not found.";
  }
}

// Until the user types a name, follow the selected profile so each profile gets its own list.
function suggestSnapName() {
  const el = $("#snapName"), profile = $("#snapProfile")?.value;
  if (!el || el.dataset.edited || !profile) return;
  el.value = profile === S.local.profile && S.local.list_name ? S.local.list_name
    : profile.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  updateNameHelp(el);
}

function runSnapshot() {
  const body = { mo2: $("#snapMo2").value.trim(), profile: $("#snapProfile").value, name: $("#snapName").value.trim() };
  $("#modalLog").innerHTML = `<div class="log">Reading ${esc(body.profile)} from ${esc(body.mo2)}…${S.local.nexus_key ? "\nNew mods are looked up on Nexus; the first run can take a few minutes." : ""}</div>`;
  postWithConfirm("api/snapshot", body, `Snapshot '${body.name}' saved`);
}

async function runImportFiles() {
  if (!uploads.length) { toast("Pick the profile files first"); return; }
  const files = await Promise.all(uploads.map(async (f) => ({ name: f.name, data: await readB64(f) })));
  const body = { kind: "files", name: $("#upName").value.trim(), title: $("#upTitle").value.trim(), files };
  postWithConfirm("api/import", body, `Imported '${body.name}'`);
}

async function deleteList(name, confirm = false) {
  try {
    const r = await fetch("api/delete", { method: "POST", headers: API_HEADERS, body: JSON.stringify({ name, confirm }) });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (r.status === 409 && j.confirm) {
      if (window.confirm(j.confirm)) return deleteList(name, true);
      return;
    }
    if (!r.ok || !j.ok) throw new Error(j.error || "Could not delete the list");
    await loadAll();
    render();
    toast(`Deleted '${name}'`);
  } catch (e) {
    toast(e.message);
  }
}

// ------------------------------------------------------------------ comment popover (after quick keep/drop/maybe)

function closePopover() { $("#pop")?.remove(); }

function commentPopover(rect, key) {
  closePopover();
  const d = decOf(key) || {};
  const pop = document.createElement("div");
  pop.className = "pop";
  pop.id = "pop";
  pop.innerHTML = `<div class="pop-head"><span class="dec ${esc(d.decision || "")}">${esc(d.decision || "comment")}</span><span class="pop-name">${esc(recName(S.catalog.get(key)))}</span></div>
    <textarea id="popNote" rows="2" maxlength="2000" placeholder="Why? e.g. replaced by Lux, needs patch…">${esc(d.note || "")}</textarea>
    <div class="pop-foot"><span class="muted">Enter to save · Shift+Enter new line · Esc to skip</span><button class="btn primary" data-act="pop-save">Save</button></div>`;
  document.body.appendChild(pop);
  const w = Math.min(340, document.documentElement.clientWidth - 16);
  pop.style.width = w + "px";
  pop.style.top = `${window.scrollY + rect.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(window.scrollX + rect.right - w, window.scrollX + document.documentElement.clientWidth - w - 8))}px`;
  pop.dataset.key = key;
  const ta = pop.querySelector("textarea");
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); savePopover(); }
    if (e.key === "Escape") { e.stopPropagation(); closePopover(); }
  });
}

async function savePopover() {
  const pop = $("#pop");
  if (!pop) return;
  const key = pop.dataset.key;
  if (await saveDecision(key, { note: $("#popNote").value.trim() })) {
    closePopover();
    render();
    toast("Comment saved");
  }
}

// ------------------------------------------------------------------ CSV

function downloadCSV() {
  const rows = compareFiltered();
  const head = ["name", "key", "category", "url", "decision", "note", ...S.lists.map((l) => l.name)];
  const q = (v) => {
    let t = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stop spreadsheets running cells as formulas
    return `"${t.replace(/"/g, '""')}"`;
  };
  const lines = [head.map(q).join(",")];
  for (const r of rows) {
    const d = decOf(r.key) || {};
    lines.push([recName(r), r.key, r.category, r.url, d.decision, d.note,
      ...S.lists.map((l) => (r.entries[l.name] ? r.entries[l.name][0].version || "yes" : ""))].map(q).join(","));
  }
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "modlist-compare.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ events

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function toggleIn(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }
function toggleSet(set, v) { if (!set.delete(v)) set.add(v); }
const shownKeys = () => (S.ui.tab === "compare" ? compareFiltered().map((r) => r.key) : browseFiltered().map((m) => m.ck));

document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#pop") && !ev.target.closest('[data-act="quick"],[data-act="comment"]')) closePopover();
  const el = ev.target.closest("[data-act]");
  if (el && el.tagName === "SELECT") return;
  if (!el) {
    if (ev.target.id === "scrim") { closeDrawer(); $("#sidebar")?.classList.remove("open"); $("#scrim").classList.remove("open"); }
    if (ev.target.id === "modal") closeModal();
    return;
  }
  const d = el.dataset;
  switch (d.act) {
    case "primary": S.ui.primary = d.list; S.ui.secs = []; render(); break;
    case "tri": {
      const cur = S.ui.tri[d.list] || "any";
      S.ui.tri[d.list] = { any: "in", in: "out", out: "any" }[cur];
      render(); break;
    }
    case "tri-reset": S.ui.tri = {}; render(); break;
    case "more-rows": S.compareLimit += 500; render(); break;
    case "add-list": openAddList("mo2"); break;
    case "sig": {
      const on = triMatchesSig(d.sig);
      S.ui.tri = {};
      if (!on) S.lists.forEach((l, i) => { S.ui.tri[l.name] = d.sig[i] === "1" ? "in" : "out"; });
      render(); break;
    }
    case "facet": toggleIn(S.ui[d.facet], d.v); render(); break;
    case "facet-clear": S.ui[d.facet] = []; render(); break;
    case "set-ui": S.ui[d.k] = d.v; render(); break;
    case "toggle-ui": S.ui[d.k] = !S.ui[d.k]; render(); break;
    case "csort": S.ui.csort = d.k; render(); break;
    case "unpill": {
      const k = d.k;
      if (k === "search") { S.search = ""; $("#search").value = ""; }
      else if (k.startsWith("cat:")) toggleIn(S.ui.cats, k.slice(4));
      else if (k.startsWith("sec:")) toggleIn(S.ui.secs, k.slice(4));
      else if (k === "decision") S.ui.decision = "all";
      else if (k === "status") S.ui.status = "all";
      render(); break;
    }
    case "clear-all": S.search = ""; $("#search").value = ""; Object.assign(S.ui, { cats: [], secs: [], status: "all", decision: "all", onlyVdiff: false }); render(); break;
    case "open": if (!ev.target.closest("a")) openDrawer(d.key, d.list || null); break;
    case "close": closeDrawer(); break;
    case "quick": {
      ev.stopPropagation();
      const rect = el.getBoundingClientRect();
      decide(d.key, d.dec).then((next) => { if (next && S.local) commentPopover(rect, d.key); });
      break;
    }
    case "comment":
      ev.stopPropagation();
      if (!S.local) { toast("Read-only — run python tools/serve.py to add comments"); break; }
      commentPopover(el.getBoundingClientRect(), d.key); break;
    case "pop-save": savePopover(); break;
    case "decide": if (S.selected) decide(S.selected.key, d.dec, true); break;
    case "csv": downloadCSV(); break;
    case "bulk-toggle": S.bulk = !S.bulk; S.picked.clear(); render(); break;
    case "pick": toggleSet(S.picked, d.key); render(); break;
    case "pick-shown": shownKeys().forEach((k) => S.picked.add(k)); render(); break;
    case "unpick-shown": shownKeys().forEach((k) => S.picked.delete(k)); render(); break;
    case "pick-none": S.picked.clear(); render(); break;
    case "pick-head": {
      const keys = shownKeys();
      const all = keys.length > 0 && keys.every((k) => S.picked.has(k));
      keys.forEach((k) => (all ? S.picked.delete(k) : S.picked.add(k)));
      render(); break;
    }
    case "bulk-apply": applyBulk(); break;
    case "goto-browse": S.ui.primary = d.list; S.ui.tab = "browse"; render(); window.scrollTo(0, 0); break;
    case "goto-cat": S.ui.cats = [d.v]; S.ui.tab = "browse"; render(); window.scrollTo(0, 0); break;
    case "goto-decision":
      S.ui.tab = "compare"; S.ui.tri = { [S.ui.ovBase]: "in" }; S.ui.decision = d.v; S.ui.cats = [];
      render(); window.scrollTo(0, 0); break;
    case "pair":
      S.ui.tab = "compare"; S.ui.tri = d.a === d.b ? { [d.a]: "in" } : { [d.a]: "in", [d.b]: "in" };
      render(); window.scrollTo(0, 0); break;
    case "resnap": {
      const s = S.local.lists[d.list];
      openAddList("mo2", { mo2: s.mo2, profile: s.profile, name: d.list }); break;
    }
    case "snap-recent": {
      const s = S.local.lists[d.list];
      $("#snapMo2").value = s.mo2; $("#snapName").value = d.list; $("#snapName").dataset.edited = "1"; updateNameHelp($("#snapName")); loadProfiles(s.profile); break;
    }
    case "snap-go": runSnapshot(); break;
    case "modal-tab": modalTab = d.v; uploads = []; renderModalTab(); break;
    case "pick-files": $("#fileInput").click(); break;
    case "pick-folder": $("#folderInput").click(); break;
    case "remove-upload": uploads.splice(+d.i, 1); renderUploads(); break;
    case "import-files": runImportFiles(); break;
    case "modal-close": closeModal(); break;
    case "delete-list": deleteList(d.list); break;
    case "freeze": {
      const l = listByName(d.list);
      fetch("api/freeze", { method: "POST", headers: { "Content-Type": "application/json", "X-Modlist-Atlas": "1" }, body: JSON.stringify({ name: d.list, frozen: !l.frozen }) })
        .then((r) => { if (!r.ok) throw new Error("failed"); l.frozen = !l.frozen; render(); toast(`${d.list} ${l.frozen ? "frozen" : "unfrozen"}`); })
        .catch(() => toast("Could not change the frozen flag"));
      break;
    }
  }
});

document.addEventListener("change", (ev) => {
  const el = ev.target;
  if (el.dataset?.act === "select-ui") { S.ui[el.dataset.k] = el.value; render(); }
  if (el.dataset?.act === "bulk-dec") S.bulkDec = el.value;
});

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  S.ui.tab = t.dataset.tab; render(); window.scrollTo(0, 0);
}));

let searchTimer;
$("#search").addEventListener("input", (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.search = ev.target.value.trim(); S.compareLimit = 500; if (S.ui.tab === "overview") S.ui.tab = "browse"; render(); }, 140);
});

$("#themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : !matchMedia("(prefers-color-scheme: light)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("atlas-theme", root.dataset.theme); } catch (e) { /* ignore */ }
});

$("#snapshotBtn").addEventListener("click", () => openAddList("mo2"));
$("#filtersBtn").addEventListener("click", () => { $("#sidebar")?.classList.add("open"); $("#scrim").classList.add("open"); });

// note field autosave
let noteTimer;
document.addEventListener("input", (ev) => {
  if (ev.target.dataset?.act === "bulk-note") { S.bulkNote = ev.target.value; return; }
  if (ev.target.id !== "decNote" || !S.selected) return;
  const key = S.selected.key;
  const note = ev.target.value;
  $("#decSaved").textContent = "Saving…";
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async () => {
    if (await saveDecision(key, { note })) {
      if ($("#decSaved")) $("#decSaved").textContent = "Saved";
      render();
    }
  }, 600);
});

document.addEventListener("keydown", (ev) => {
  const active = document.activeElement;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName);
  const modalOpen = $("#modal").classList.contains("open");
  if (ev.key === "Tab") {
    if (modalOpen) trapFocus(ev, $("#modal"));
    else if (S.selected) trapFocus(ev, $("#drawer"));
    return;
  }
  if (ev.key === "Escape") {
    if ($("#pop")) closePopover();
    else if (typing && S.selected && $("#drawer").contains(active)) active.blur(); // leave the comment box first
    else if (modalOpen) closeModal();
    else if (S.selected) closeDrawer();
    else if ($("#sidebar")?.classList.contains("open")) { $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("open"); }
    else if (typing) active.blur();
    return;
  }
  // Enter/Space on a focusable table row opens it
  if ((ev.key === "Enter" || ev.key === " ") && active?.tagName === "TR" && active.dataset.act === "open") {
    ev.preventDefault();
    openDrawer(active.dataset.key, active.dataset.list || null);
    return;
  }
  if (typing) return;
  if (ev.key === "/" || (ev.key === "k" && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); $("#search").focus(); return; }
  if (!S.selected || modalOpen || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const map = { k: "keep", d: "drop", m: "maybe" };
  const key = ev.key.toLowerCase();
  if (map[key]) { ev.preventDefault(); decide(S.selected.key, map[key], false); }
  else if (key === "c" && S.local) { ev.preventDefault(); $("#decNote")?.focus(); }
  else if (ev.key === "ArrowRight" || key === "j") { ev.preventDefault(); navDrawer(1); }
  else if (ev.key === "ArrowLeft" || key === "h") { ev.preventDefault(); navDrawer(-1); }
});

// broken remote images (thumbnails, description images) just disappear; no inline handlers needed
document.addEventListener("error", (ev) => { if (ev.target?.tagName === "IMG") ev.target.remove(); }, true);

init();
