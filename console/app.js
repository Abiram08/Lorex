/** Lorex console — the single point of working. Vanilla ESM, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, init = {}) {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data && data.error ? data.error : res.statusText);
  return data;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer;
function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `visible${isError ? " error-toast" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = ""; }, 4500);
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast("Copied to clipboard");
  } catch {
    toast("Clipboard unavailable. Select and copy the text instead.", true);
  }
}

function renderFailure(page, error) {
  page.innerHTML = `<div class="page-heading"><h1>Could not load this page</h1><p>${esc(error.message)}</p></div>
    <button class="btn" id="retry-page">Retry</button>`;
  $("#retry-page", page).addEventListener("click", () => navigate(currentPage));
}

const fmtTime = (iso) => {
  try { return new Date(iso).toLocaleTimeString([], { hour12: false }); } catch { return "—"; }
};

function itemHtml(source) {
  const excerpt = esc(source.excerpt || source.content || "(no text)");
  const badges = [
    source.memory_type ? `<span class="badge hot">${esc(source.memory_type)}</span>` : "",
    source.status ? `<span class="badge">${esc(source.status)}</span>` : "",
    source.score !== undefined ? `<span class="badge">${Number(source.score).toFixed(2)}</span>` : "",
  ].join(" ");
  const meta = [source.source_ref, source.agent, source.valid_from && String(source.valid_from).slice(0, 10)]
    .filter(Boolean).map(esc).join(" · ");
  return `<div class="item clickable" data-id="${esc(source.id ?? "")}" data-fact="${esc(source.fact_key ?? source.id ?? "")}" data-corpus="${esc(source.corpus ?? "memory")}">
    <div class="text">${excerpt}</div>
    <div class="meta">${badges}${meta ? `<span>${meta}</span>` : ""}</div>
  </div>`;
}

// ── Live activity (SSE) ──────────────────────────────────────────────────────

const activity = [];
const activityListeners = new Set();
let pendingDetail = null;
let pendingKnowledge = null;

function connectEvents() {
  const es = new EventSource("/v1/events");
  es.onmessage = (event) => {
    try {
      const ev = JSON.parse(event.data);
      if (ev.type === "hello") return;
      activity.unshift(ev);
      if (activity.length > 120) activity.pop();
      activityListeners.forEach((fn) => fn());
    } catch { /* ignore malformed frames */ }
  };
  es.onerror = () => {
    $("#side-status").textContent = "Service disconnected — retrying";
    $(".topbar-status").textContent = "Reconnecting";
  };
  es.onopen = () => refreshSideStatus();
  return es;
}

function activityHtml() {
  if (!activity.length) return `<div class="muted">Nothing yet — activity appears as agents read and write.</div>`;
  return `<div class="activity">${activity
    .slice(0, 40)
    .map((ev) => `<div class="ev"><time>${fmtTime(ev.at)}</time><span class="t">${esc(ev.type)}</span><span class="m">${esc(ev.summary || ev.name || ev.id || "")}${ev.error ? ` <span class="error">${esc(ev.error)}</span>` : ""}</span></div>`)
    .join("")}</div>`;
}

// ── Pages ────────────────────────────────────────────────────────────────────

async function refreshSideStatus() {
  try {
    const s = await api("/v1/status");
    $("#side-status").innerHTML = `v${esc(s.version)} · ${s.currentMemories ?? 0} memories<br/>space: ${esc(s.spaces?.current?.name ?? "—")}`;
    $(".topbar-status").innerHTML = `<i aria-hidden="true"></i> Local service`;
  } catch {
    $("#side-status").textContent = "Service disconnected";
    $(".topbar-status").textContent = "Disconnected";
  }
}

async function renderHome() {
  const page = $("#page-home");
  page.innerHTML = `<div class="loading">Loading…</div>`;
  let status, recent;
  try {
    [status, recent] = await Promise.all([api("/v1/status"), api("/v1/memories?maxResults=5")]);
  } catch (error) {
    renderFailure(page, error);
    return;
  }

  const space = status.spaces?.current;
  const renamePrompt = status.spaces?.autoNamed
    ? `<div class="notice row spread" id="name-space">
        <span>New project detected — this space is auto-named <b>${esc(space?.name ?? "")}</b>. Name it to confirm.</span>
        <button class="btn primary" id="name-space-btn">Name space</button>
      </div>`
    : "";

  const base = location.origin;
  page.innerHTML = `
    <div class="page-heading"><div><div class="eyebrow">OVERVIEW</div><h1>Your memory layer is live.</h1>
      <p>Lorex keeps project context available to every connected coding agent. Everything here runs on your machine.</p></div>
      <span class="live-pill"><i aria-hidden="true"></i> Running locally</span></div>
    ${renamePrompt}
    <div class="hero-grid">
      <div class="card hero-card"><div class="eyebrow">LOCAL API ENDPOINT</div>
        <div class="endpoint-row"><code>${esc(base)}</code><button class="btn" id="copy-endpoint">Copy</button></div>
        <p>Use this address with the REST API or connect an MCP client at <code>${esc(base)}/mcp</code>.</p>
        <div class="row"><button class="btn primary" id="open-api">Explore API</button><button class="btn" id="open-connections">Connect an agent</button></div>
      </div>
      <div class="card space-card"><div class="eyebrow">CURRENT SPACE</div><div class="v">${esc(space?.name ?? status.project.label)}</div>
        <div class="note mono">${esc(space?.id ?? status.project.collection)}</div><div class="space-stat"><strong>${status.currentMemories ?? 0}</strong> items in this space</div>
      </div>
    </div>
    <div class="grid metrics">
      <div class="card"><div class="k">All memories</div><div class="v">${status.memories ?? 0}</div><div class="note">Across ${status.spaces?.total ?? 0} spaces</div></div>
      <div class="card"><div class="k">Current agent</div><div class="v small">${esc(status.project.agent)}</div><div class="note">${esc(status.project.label)}</div></div>
      <div class="card"><div class="k">Background learning</div><div class="v small">${status.dream?.shouldRun ? "Ready" : "Up to date"}</div><div class="note">${esc(status.dream?.reason ?? "")}</div></div>
    </div>
    <div class="two-col">
      <div><div class="section-heading"><h2>What Lorex remembers</h2><button class="text-btn" id="all-memories">View all →</button></div>
        <div id="recent-memories">${(recent.sources ?? []).length ? recent.sources.map(itemHtml).join("") : `<div class="empty"><b>No memories yet</b><p>Add a fact or connect a coding agent to start building project memory.</p><button class="btn primary" id="first-memory">Add a memory</button></div>`}</div></div>
      <div><div class="section-heading"><h2>Session-start context</h2><span class="muted">What agents see</span></div>
        <pre class="pack" id="pack-preview">Loading…</pre></div>
    </div>
    <div class="section-heading"><h2>Live activity</h2><span class="muted">This session</span></div>
    <div class="card" id="home-activity">${activityHtml()}</div>
  `;

  $("#copy-endpoint").addEventListener("click", () => copyText(base));
  $("#open-api").addEventListener("click", () => { location.hash = "api"; });
  $("#open-connections").addEventListener("click", () => { location.hash = "connections"; });
  $("#all-memories").addEventListener("click", () => { location.hash = "memories"; });
  $("#first-memory")?.addEventListener("click", () => { location.hash = "memories"; });
  page.querySelectorAll("#recent-memories .item.clickable").forEach((item) => item.addEventListener("click", () => {
    if (item.dataset.corpus === "knowledge") {
      pendingKnowledge = (recent.sources ?? []).find((source) => source.id === item.dataset.id);
      location.hash = "knowledge";
    } else {
      pendingDetail = item.dataset.fact;
      location.hash = "memories";
    }
  }));

  api("/v1/context?maxTokens=1200").then((ctx) => {
    const pack = $("#pack-preview");
    if (pack) pack.textContent = ctx.text || ctx.summary || "(empty — nothing to inject yet)";
  }).catch(() => {
    const pack = $("#pack-preview");
    if (pack) pack.textContent = "(context pack unavailable)";
  });

  const onActivity = () => {
    const node = $("#home-activity");
    if (node) node.innerHTML = activityHtml();
  };
  activityListeners.clear();
  activityListeners.add(onActivity);

  const nameBtn = $("#name-space-btn");
  if (nameBtn && space) {
    nameBtn.addEventListener("click", async () => {
      const name = prompt("Space name", space.name);
      if (!name) return;
      try {
        await api(`/v1/spaces/${encodeURIComponent(space.id)}`, { method: "PATCH", body: { name } });
        toast("Space renamed");
        renderHome();
      } catch (error) { toast(error.message, true); }
    });
  }
  refreshSideStatus();
}

let memoryQuery = "";
let memoryType = "all";

async function renderMemories() {
  const page = $("#page-memories");
  page.innerHTML = `
    <h1>Memories</h1>
    <div class="sub">Browse recent items, search, add, or retire a fact. History is always kept.</div>
    <div class="row" style="margin-bottom:10px">
      <input type="text" id="m-query" placeholder="Search memory… (empty = recent)" style="flex:1" value="${esc(memoryQuery)}" />
      <select id="m-type">
        <option value="all">all</option><option value="memory">memory</option><option value="knowledge">knowledge</option>
      </select>
      <button class="btn" id="m-search">Search</button>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="k" style="margin-bottom:6px">Add a memory</div>
      <div class="row">
        <input type="text" id="m-add-text" placeholder='Fact, e.g. "Sessions moved to Redis because Atlas timed out"' style="flex:1" />
        <input type="text" id="m-add-because" placeholder="because… (optional)" style="width:220px" />
        <button class="btn primary" id="m-add">Remember</button>
      </div>
    </div>
    <div id="m-results"><div class="loading">Loading…</div></div>
  `;
  $("#m-type").value = memoryType;

  const search = async () => {
    memoryQuery = $("#m-query").value.trim();
    memoryType = $("#m-type").value;
    const box = $("#m-results");
    box.innerHTML = `<div class="loading">Loading…</div>`;
    try {
      const params = new URLSearchParams({ type: memoryType });
      if (memoryQuery) params.set("query", memoryQuery);
      const data = await api(`/v1/memories?${params}`);
      const sources = data.sources ?? [];
      const head = data.abstained
        ? `<div class="muted" style="margin-bottom:8px">Abstained: ${esc(data.abstention_reason ?? "no evidence")}</div>`
        : data.answer
          ? `<div class="card" style="margin-bottom:10px"><div class="k">Answer</div><div style="white-space:pre-wrap">${esc(data.answer)}</div>
             <div class="row" style="margin-top:8px"><button class="btn" data-report="positive" data-request="${esc(data.request_id ?? "")}">Good answer</button>
             <button class="btn" data-report="negative" data-request="${esc(data.request_id ?? "")}">Bad answer</button></div></div>`
          : `<div class="muted" style="margin-bottom:8px">${esc(data.summary ?? "")}</div>`;
      box.innerHTML = head + (sources.length ? sources.map(itemHtml).join("") : `<div class="muted">Nothing stored yet.</div>`);
      box.querySelectorAll("[data-report]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await api("/v1/report", { method: "POST", body: { requestId: btn.dataset.request, rating: btn.dataset.report, query: memoryQuery } });
            btn.textContent = "Thanks";
          } catch (error) { btn.disabled = false; toast(error.message, true); }
        });
      });
      box.querySelectorAll(".item.clickable").forEach((item) => {
        item.addEventListener("click", () => {
          if (item.dataset.corpus === "knowledge") {
            pendingKnowledge = sources.find((source) => source.id === item.dataset.id);
            location.hash = "knowledge";
          } else showDetail(item.dataset.fact);
        });
      });
    } catch (error) {
      box.innerHTML = `<div class="error">${esc(error.message)}</div>`;
    }
  };

  $("#m-search").addEventListener("click", search);
  $("#m-query").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  $("#m-add").addEventListener("click", async () => {
    const text = $("#m-add-text").value.trim();
    const because = $("#m-add-because").value.trim();
    if (!text) return;
    const button = $("#m-add");
    button.disabled = true;
    try {
      await api("/v1/memories", { method: "POST", body: { text, because: because || undefined } });
      $("#m-add-text").value = "";
      $("#m-add-because").value = "";
      toast("Memory stored");
      await search();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });

  await search();
  if (pendingDetail) {
    const factId = pendingDetail;
    pendingDetail = null;
    await showDetail(factId);
  }
}

async function showDetail(factId) {
  const box = $("#m-results");
  try {
    const receipt = await api(`/v1/memories/${encodeURIComponent(factId)}`);
    const versions = receipt.sources ?? [];
    box.innerHTML = `
      <div class="row spread" style="margin-bottom:10px">
        <button class="btn" id="m-back">← Back</button>
        <button class="btn danger" id="m-forget">Forget this topic</button>
      </div>
      <h2 style="margin-top:0">Version timeline</h2>
      ${versions.length ? versions.map((v) => `
        <div class="item">
          <div class="text">${esc(v.excerpt || v.content || "")}</div>
          <div class="meta">
            <span>${esc(v.status ?? "current")}</span>
            ${v.valid_from ? `<span>from ${esc(String(v.valid_from).slice(0, 19).replace("T", " "))}</span>` : ""}
            ${v.valid_to ? `<span>until ${esc(String(v.valid_to).slice(0, 19).replace("T", " "))}</span>` : ""}
            ${v.reason ? `<span>because: ${esc(v.reason)}</span>` : ""}
            ${v.agent ? `<span>${esc(v.agent)}</span>` : ""}
          </div>
        </div>`).join("") : `<div class="muted">No versions found.</div>`}
    `;
    $("#m-back").addEventListener("click", renderMemories);
    $("#m-forget").addEventListener("click", async () => {
      if (!confirm("Soft-delete this topic? History is retained.")) return;
      try {
        await api("/v1/forget", { method: "POST", body: { factId } });
        toast("Topic forgotten; history retained");
        renderMemories();
      } catch (error) { toast(error.message, true); }
    });
  } catch (error) {
    box.innerHTML = `<div class="error">${esc(error.message)}</div>`;
  }
}

let knowledgeQuery = "";
async function renderKnowledge() {
  const page = $("#page-knowledge");
  page.innerHTML = `<div class="page-heading"><div><div class="eyebrow">SOURCES</div><h1>Knowledge</h1>
    <p>Store source text alongside extracted memories, so agents can return to the original evidence.</p></div></div>
    <div class="card form-card"><h2>Add source text</h2><p class="muted">Paste a note, runbook, or document excerpt. Lorex stores this verbatim in the current space.</p>
      <label for="k-label">Source label</label><input type="text" id="k-label" placeholder="e.g. architecture.md" />
      <label for="k-content">Content</label><textarea id="k-content" placeholder="Paste source text here…"></textarea>
      <div class="row spread"><span class="muted" id="k-count">0 characters</span><button class="btn primary" id="k-add">Add knowledge</button></div>
    </div>
    <div class="section-heading"><h2>Stored knowledge</h2></div>
    <div class="row search-row"><input type="text" id="k-query" placeholder="Search source text…" value="${esc(knowledgeQuery)}" />
      <button class="btn" id="k-search">Search</button></div>
    <div id="k-results"><div class="loading">Loading…</div></div>`;

  const input = $("#k-content", page);
  input.addEventListener("input", () => { $("#k-count", page).textContent = `${input.value.length.toLocaleString()} characters`; });
  const search = async () => {
    knowledgeQuery = $("#k-query", page).value.trim();
    const box = $("#k-results", page);
    box.innerHTML = `<div class="loading">Loading…</div>`;
    try {
      const params = new URLSearchParams({ type: "knowledge", maxResults: "50" });
      if (knowledgeQuery) params.set("query", knowledgeQuery);
      const data = await api(`/v1/memories?${params}`);
      const sources = data.sources ?? [];
      box.innerHTML = sources.length
        ? sources.map(itemHtml).join("")
        : `<div class="empty"><b>No source text found</b><p>Add knowledge above or try another search.</p></div>`;
      const showSource = (source) => {
        box.innerHTML = `<button class="btn" id="k-back">← Back to results</button>
          <div class="card source-detail"><div class="eyebrow">SOURCE TEXT</div><h2>${esc(source.source_ref || "Untitled source")}</h2>
          <div class="meta muted">${esc(source.id)}</div><pre class="pack">${esc(source.content || source.excerpt || "")}</pre></div>`;
        $("#k-back", box).addEventListener("click", search);
      };
      box.querySelectorAll(".item.clickable").forEach((item) => {
        item.addEventListener("click", () => {
          const source = sources.find((entry) => entry.id === item.dataset.id);
          if (source) showSource(source);
        });
      });
      if (pendingKnowledge) {
        const source = pendingKnowledge;
        pendingKnowledge = null;
        showSource(source);
      }
    } catch (error) { box.innerHTML = `<div class="error">${esc(error.message)}</div>`; }
  };
  $("#k-search", page).addEventListener("click", search);
  $("#k-query", page).addEventListener("keydown", (event) => { if (event.key === "Enter") search(); });
  $("#k-add", page).addEventListener("click", async () => {
    const content = input.value.trim();
    if (!content) { toast("Add some source text first", true); input.focus(); return; }
    const button = $("#k-add", page);
    button.disabled = true;
    try {
      await api("/v1/knowledge", { method: "POST", body: { content, sourceRef: $("#k-label", page).value.trim() || undefined } });
      input.value = "";
      $("#k-label", page).value = "";
      $("#k-count", page).textContent = "0 characters";
      toast("Knowledge stored");
      await search();
    } catch (error) { toast(error.message, true); }
    finally { button.disabled = false; }
  });
  await search();
}

async function renderSpaces() {
  const page = $("#page-spaces");
  page.innerHTML = `<div class="loading">Loading…</div>`;
  const data = await api("/v1/spaces");

  const rows = (data.spaces ?? []).map((s) => `
    <tr class="${s.id === data.current ? "current" : ""}">
      <td>${esc(s.name)} ${s.id === data.current ? `<span class="badge ok">current</span>` : ""}</td>
      <td class="mono">${esc(s.id)}</td>
      <td>${s.memories}</td>
      <td><span class="badge ${s.source === "auto" ? "warn" : ""}">${esc(s.source)}</span>${s.archived_at ? ` <span class="badge">archived</span>` : ""}</td>
      <td>
        <button class="btn" data-rename="${esc(s.id)}" data-name="${esc(s.name)}">Rename</button>
        <button class="btn" data-archive="${esc(s.id)}" data-archived="${s.archived_at ? "1" : "0"}">${s.archived_at ? "Unarchive" : "Archive"}</button>
      </td>
    </tr>`).join("");

  page.innerHTML = `
    <h1>Spaces</h1>
    <div class="sub">A space is a named memory pool. Agents naming the same space share memory —
      set <span class="mono">LOREX_SPACE=&lt;name&gt;</span> or add <span class="mono">{"space": "&lt;name&gt;"}</span> to a project's <span class="mono">.lorex.json</span>.</div>
    <div class="card" style="margin-bottom:16px">
      <div class="row">
        <input type="text" id="s-name" placeholder="New space name (e.g. checkout)" style="width:240px" />
        <input type="text" id="s-desc" placeholder="Description (optional)" style="flex:1" />
        <button class="btn primary" id="s-create">Create</button>
      </div>
    </div>
    ${data.supported ? `
    <table class="spaces">
      <thead><tr><th>Space</th><th>Id</th><th>Memories</th><th>Source</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted">No spaces yet — they appear as memory is written.</td></tr>`}</tbody>
    </table>` : `<div class="muted">Spaces require the local SQLite backend.</div>`}
  `;

  $("#s-create").addEventListener("click", async () => {
    const name = $("#s-name").value.trim();
    if (!name) return;
    try {
      await api("/v1/spaces", { method: "POST", body: { name, description: $("#s-desc").value.trim() } });
      toast("Space created");
      renderSpaces();
    } catch (error) { toast(error.message, true); }
  });
  page.querySelectorAll("[data-rename]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = prompt("Space name", btn.dataset.name);
      if (!name) return;
      try {
        await api(`/v1/spaces/${encodeURIComponent(btn.dataset.rename)}`, { method: "PATCH", body: { name } });
        toast("Space renamed");
        renderSpaces();
      } catch (error) { toast(error.message, true); }
    });
  });
  page.querySelectorAll("[data-archive]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/v1/spaces/${encodeURIComponent(btn.dataset.archive)}`, {
          method: "PATCH",
          body: { archived: btn.dataset.archived !== "1" },
        });
        toast(btn.dataset.archived === "1" ? "Space restored" : "Space archived");
        renderSpaces();
      } catch (error) { toast(error.message, true); }
    });
  });
}

async function renderLearner() {
  const page = $("#page-learner");
  page.innerHTML = `<div class="loading">Loading…</div>`;
  const [reflect, loops, reviews] = await Promise.all([
    api("/v1/reflect"), api("/v1/open-loops"), api("/v1/reviews"),
  ]);

  const findings = (reflect.findings ?? []).map((f) => `
    <div class="item"><div class="text">${esc(f.kind ?? f.type ?? "finding")}: ${esc(f.detail ?? f.message ?? JSON.stringify(f))}</div></div>`).join("");

  const loopItems = (loops.loops ?? []).map((l) => `
    <div class="item"><div class="text">${esc(l.text)}</div><div class="meta"><span>${l.age_days}d old</span></div></div>`).join("");

  const reviewItems = (reviews.items ?? []).map((r) => `
    <div class="item" data-review="${esc(r.id)}">
      <div class="text">${esc(r.payload?.text ?? "Proposed learned memory")}</div>
      <div class="meta"><span>${Math.round(Number(r.confidence ?? 0) * 100)}% confidence · ${esc(r.kind)}</span></div>
      <div class="row" style="margin-top:8px"><button class="btn primary" data-review-action="approve">Approve</button><button class="btn danger" data-review-action="decline">Decline</button></div>
    </div>`).join("");

  page.innerHTML = `
    <div class="page-heading"><div><div class="eyebrow">MEMORY QUALITY</div><h1>Health</h1>
      <p>Inspect stale or conflicting memories, unfinished work, and background pattern discovery.</p></div></div>
    <div class="grid">
      <div class="card"><div class="k">Memory health</div><div class="v">${reflect.healthy ? "clean" : `${(reflect.findings ?? []).length} findings`}</div><div class="note">${reflect.total ?? 0} memories inspected</div></div>
      <div class="card"><div class="k">Open loops</div><div class="v">${(loops.loops ?? []).length}</div></div>
      <div class="card"><div class="k">Needs review</div><div class="v">${(reviews.items ?? []).length}</div><div class="note">Uncertain learned patterns</div></div>
    </div>

    <h2>Actions</h2>
    <div class="row">
      <button class="btn" id="l-dream">Run dream now</button>
      <button class="btn" id="l-consolidate">Plan consolidation</button>
    </div>
    <pre class="pack" id="l-out" style="margin-top:10px; display:none"></pre>

    <h2>Learning review</h2>
    ${reviewItems || `<div class="muted">No uncertain learned memories are waiting.</div>`}

    <h2>Findings</h2>
    ${findings || `<div class="muted">${reflect.available === false ? "Quality metrics need the SQLite backend." : "Nothing to report — memory looks clean."}</div>`}

    <h2>Open loops</h2>
    ${loopItems || `<div class="muted">Nothing unfinished.</div>`}
  `;

  const show = (label, value) => {
    const out = $("#l-out");
    out.style.display = "block";
    out.textContent = label + "\n" + JSON.stringify(value, null, 2);
  };
  $("#l-dream").addEventListener("click", async () => {
    $("#l-dream").disabled = true;
    try { show("dream", await api("/v1/dream", { method: "POST" })); }
    catch (error) { toast(error.message, true); }
    finally { $("#l-dream").disabled = false; }
  });
  $("#l-consolidate").addEventListener("click", async () => {
    $("#l-consolidate").disabled = true;
    try { show("consolidate", await api("/v1/consolidate", { method: "POST" })); }
    catch (error) { toast(error.message, true); }
    finally { $("#l-consolidate").disabled = false; }
  });
  page.querySelectorAll("[data-review-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = button.closest("[data-review]");
      button.disabled = true;
      try {
        await api(`/v1/reviews/${encodeURIComponent(item.dataset.review)}`, { method: "POST", body: { decision: button.dataset.reviewAction } });
        toast(`Learned memory ${button.dataset.reviewAction === "approve" ? "approved" : "declined"}`);
        await renderLearner();
      } catch (error) { button.disabled = false; toast(error.message, true); }
    });
  });
}

function renderGraph() {
  const frame = $("#graph-frame");
  if (frame && !frame.src) frame.src = "/graph";
}

async function renderConnections() {
  const page = $("#page-connections");
  page.innerHTML = `<div class="loading">Loading…</div>`;
  const data = await api("/v1/connections");
  const hooks = data.hooks ?? [];

  page.innerHTML = `
    <h1>Connections</h1>
    <div class="sub">Which agents in <span class="mono">${esc(data.cwd)}</span> load Lorex automatically at session start.</div>
    ${hooks.map((h) => `
      <div class="item row spread">
        <div>
          <div class="text">${esc(h.agent)} ${h.configured ? `<span class="badge ok">wired</span>` : `<span class="badge">not wired</span>`}</div>
          <div class="meta"><span>${esc(h.detail)}</span></div>
        </div>
        <div>
          ${h.configured
            ? `<button class="btn danger" data-hook="${esc(h.agent)}" data-action="uninstall">Uninstall</button>`
            : `<button class="btn primary" data-hook="${esc(h.agent)}" data-action="install">Install hooks</button>`}
        </div>
      </div>`).join("")}
    <h2>MCP</h2>
    <div class="muted" style="margin-bottom:8px">MCP config is written per project: <span class="mono">lorex wire</span> adds Lorex to <span class="mono">.mcp.json</span>. The daemon also serves MCP over HTTP at <span class="mono">/mcp</span>.</div>
  `;

  page.querySelectorAll("[data-hook]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api("/v1/connections", { method: "POST", body: { agent: btn.dataset.hook, action: btn.dataset.action, cwd: data.cwd } });
        toast(`Connection ${btn.dataset.action === "uninstall" ? "removed" : "installed"}`);
      } catch (error) { toast(error.message, true); }
      finally {
        renderConnections();
      }
    });
  });
}

async function renderApi() {
  const page = $("#page-api");
  const base = location.origin;
  page.innerHTML = `
    <div class="page-heading"><div><div class="eyebrow">DEVELOPER TOOLS</div><h1>Local API</h1>
      <p>Build against the same memory engine used by the console and connected agents.</p></div></div>
    <div class="card hero-card"><div class="eyebrow">BASE URL</div><div class="endpoint-row"><code>${esc(base)}</code><button class="btn" id="api-copy">Copy</button></div>
      <p>The service listens on loopback. REST and MCP use the current project's space.</p></div>
    <div class="two-col api-layout">
      <div><div class="section-heading"><h2>Endpoints</h2></div>
        <div class="api-route"><span class="method get">GET</span><code>/health</code><span>Service status</span></div>
        <div class="api-route"><span class="method get">GET</span><code>/v1/status</code><span>Workspace and store</span></div>
        <div class="api-route"><span class="method get">GET</span><code>/v1/memories</code><span>Browse or search</span></div>
        <div class="api-route"><span class="method post">POST</span><code>/v1/memories</code><span>Remember a fact</span></div>
        <div class="api-route"><span class="method post">POST</span><code>/v1/knowledge</code><span>Store source text</span></div>
        <div class="api-route"><span class="method post">POST</span><code>/v4/search</code><span>Recall with evidence</span></div>
        <div class="api-route"><span class="method get">GET</span><code>/v1/context</code><span>Session-start pack</span></div>
        <div class="api-route"><span class="method post">POST</span><code>/mcp</code><span>MCP transport</span></div>
      </div>
      <div><div class="section-heading"><h2>Try a search</h2></div>
        <div class="card form-card"><label for="api-query">Question</label><input type="text" id="api-query" placeholder="What does this project use for storage?" />
          <div class="row"><button class="btn primary" id="api-run">Run search</button><button class="btn" id="api-copy-example">Copy example</button></div>
          <pre class="pack" id="api-output" aria-live="polite">Results will appear here.</pre></div></div>
    </div>
    <div class="section-heading"><h2>JavaScript quickstart</h2><button class="text-btn" id="api-copy-code">Copy code</button></div>
    <pre class="pack code-block" id="api-code"></pre>`;
  const example = `const response = await fetch("${base}/v4/search", {\n  method: "POST",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({ query: "What does this project use for storage?" }),\n});\nconst { answer, sources, abstained } = await response.json();`;
  $("#api-code", page).textContent = example;
  $("#api-copy", page).addEventListener("click", () => copyText(base));
  $("#api-copy-code", page).addEventListener("click", () => copyText(example));
  $("#api-copy-example", page).addEventListener("click", () => copyText(example));
  const run = async () => {
    const query = $("#api-query", page).value.trim();
    if (!query) { toast("Enter a question first", true); return; }
    const output = $("#api-output", page);
    output.textContent = "Searching…";
    try { output.textContent = JSON.stringify(await api("/v4/search", { method: "POST", body: { query } }), null, 2); }
    catch (error) { output.textContent = error.message; toast(error.message, true); }
  };
  $("#api-run", page).addEventListener("click", run);
  $("#api-query", page).addEventListener("keydown", (event) => { if (event.key === "Enter") run(); });
}

async function renderSettings() {
  const page = $("#page-settings");
  page.innerHTML = `<div class="loading">Loading…</div>`;
  const s = await api("/v1/settings");
  page.innerHTML = `
    <h1>Settings</h1>
    <div class="sub">Memory is stored locally. Optional model integrations use the endpoints you configure.</div>
    <div class="card" style="margin-bottom:14px">
      <div class="row spread"><span class="muted">Lorex home</span><span class="mono">${esc(s.home)}</span></div>
      <div class="row spread" style="margin-top:6px"><span class="muted">Store</span><span class="mono">${esc(s.storePath)}</span></div>
      <div class="row spread" style="margin-top:6px"><span class="muted">Version</span><span class="mono">${esc(s.version)}</span></div>
    </div>

    <h2>Daemon</h2>
    <div class="row">
      <label class="muted" style="width:90px">Port</label>
      <input type="number" id="set-port" value="${s.port}" style="width:110px" />
      <button class="btn" id="set-port-save">Save (restart required)</button>
    </div>
    <div class="row" style="margin-top:10px">
      <label class="muted" style="width:90px">Data dir</label>
      <input type="text" id="set-datadir" value="${esc(s.dataDir ?? "")}" placeholder="(default: Lorex home)" style="flex:1" />
      <button class="btn" id="set-datadir-save">Save</button>
    </div>

    <h2>Backup</h2>
    <div class="row">
      <a class="btn" href="/v1/export" download="lorex-export.jsonl">Download JSONL export</a>
    </div>
    <div style="margin-top:12px">
      <div class="k muted" style="margin-bottom:6px">Import JSONL (merge; local rows win unless forced)</div>
      <textarea id="set-import" placeholder='{"id":"…","text":"…","corpus":"memory"} — one per line'></textarea>
      <div class="row" style="margin-top:8px">
        <label class="check"><input type="checkbox" id="set-force" /> force overwrite</label>
        <button class="btn" id="set-import-btn">Import</button>
        <span id="set-import-out" class="muted"></span>
      </div>
    </div>
  `;

  $("#set-port-save").addEventListener("click", async () => {
    const port = Number($("#set-port").value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { toast("Enter a valid port (1–65535)", true); return; }
    try {
      await api("/v1/settings", { method: "PATCH", body: { port } });
      $("#set-port-save").textContent = "Saved — restart to apply";
    } catch (error) { toast(error.message, true); }
  });
  $("#set-datadir-save").addEventListener("click", async () => {
    const dataDir = $("#set-datadir").value.trim();
    try {
      await api("/v1/settings", { method: "PATCH", body: { dataDir: dataDir || null } });
      $("#set-datadir-save").textContent = "Saved — restart to apply";
    } catch (error) { toast(error.message, true); }
  });
  $("#set-import-btn").addEventListener("click", async () => {
    const jsonl = $("#set-import").value;
    try {
      const r = await api("/v1/import", { method: "POST", body: { jsonl, force: $("#set-force").checked } });
      $("#set-import-out").textContent = `Imported ${r.imported}, skipped ${r.skipped}.`;
    } catch (error) {
      $("#set-import-out").innerHTML = `<span class="error">${esc(error.message)}</span>`;
    }
  });
}

// ── Router ───────────────────────────────────────────────────────────────────

const RENDERERS = {
  home: renderHome,
  memories: renderMemories,
  knowledge: renderKnowledge,
  spaces: renderSpaces,
  learner: renderLearner,
  graph: renderGraph,
  connections: renderConnections,
  api: renderApi,
  settings: renderSettings,
};

let currentPage = "";

function navigate(page) {
  const target = RENDERERS[page] ? page : "home";
  currentPage = target;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.page === target));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${target}`));
  Promise.resolve().then(() => RENDERERS[target]()).catch((error) => renderFailure($(`#page-${target}`), error));
}

document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => { location.hash = b.dataset.page; }));
window.addEventListener("hashchange", () => navigate(location.hash.replace("#", "") || "home"));

connectEvents();
navigate(location.hash.replace("#", "") || "home");
