/** Context graph rendered as a self-contained HTML page. */

import type { ContextGraph } from "../domain/graph.js";

export interface RenderOptions {
  workspace?: string;
  database: string;
  collection: string;
  query?: string;
  liveUrl?: string;
  pollMs?: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function payload(graph: ContextGraph): string {
  return JSON.stringify(graph).replace(/</g, "\\u003c");
}

export function renderGraphHtml(graph: ContextGraph, meta: RenderOptions): string {
  const scope = meta.workspace ? meta.workspace : meta.collection;
  const title = `Context graph — ${scope}`;
  const live = meta.liveUrl ? JSON.stringify(meta.liveUrl) : "null";
  const pollMs = meta.pollMs ?? 2000;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg:#000000;
    --panel:#07090a;
    --line:#161c1f;
    --text:#e8f0ee;
    --dim:#6d7d7a;
    --faint:#3a4644;
    --live:#2ee6c5;
    --stale:#4a5654;
    --cause:#ff5c4d;
    --agent:#c8a2ff;
    --entity:#4d9dff;
    --pack:#ffc857;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;background:var(--bg);color:var(--text);overflow:hidden;
    font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    -webkit-font-smoothing:antialiased;
  }
  canvas{display:block;position:fixed;inset:0;cursor:grab}
  canvas.dragging{cursor:grabbing}

  .overlay{position:fixed;pointer-events:none}
  .overlay>*{pointer-events:auto}

  header{
    top:0;left:0;right:0;padding:16px 20px;
    display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;
    background:linear-gradient(180deg,rgba(0,0,0,.92),rgba(0,0,0,0));
  }
  h1{margin:0;font-size:13px;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
  .scope{color:var(--live)}
  .meta{color:var(--faint);font-size:11px}
  .q{color:var(--dim);font-size:11px}

  .stats{
    position:fixed;top:16px;right:20px;display:flex;gap:2px;
    border:1px solid var(--line);border-radius:2px;overflow:hidden;background:var(--panel);
  }
  .stat{padding:6px 12px;text-align:right;min-width:64px}
  .stat b{display:block;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
  .stat span{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}

  .legend{
    position:fixed;left:20px;bottom:20px;
    background:var(--panel);border:1px solid var(--line);border-radius:2px;
    padding:12px 14px;display:grid;gap:7px;font-size:11px;
  }
  .key{display:flex;align-items:center;gap:9px;color:var(--dim)}
  .dot{width:11px;height:11px;border-radius:50%;flex:none}
  .dot.live{background:var(--live);box-shadow:0 0 9px var(--live)}
  .dot.stale{border:1.5px solid var(--stale);background:transparent}
  .dot.agent{background:var(--agent)}
  .dot.entity{background:var(--entity)}
  .dot.pack{background:transparent;border:1.5px solid var(--pack);box-shadow:0 0 9px rgba(255,200,87,.5)}
  .bar{width:16px;height:2px;background:var(--cause);flex:none;border-radius:1px}

  .detail{
    position:fixed;right:20px;bottom:20px;width:340px;max-height:46vh;overflow:auto;
    background:var(--panel);border:1px solid var(--line);border-radius:2px;
    padding:14px 16px;display:none;
  }
  .detail.on{display:block}
  .detail h2{margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--live)}
  .detail .when{color:var(--faint);font-size:11px;margin-bottom:9px}
  .detail p{margin:0 0 9px;color:var(--text);font-size:12px;line-height:1.6;word-break:break-word}
  .detail .why{color:var(--cause);font-size:11px;border-left:2px solid var(--cause);padding-left:9px}
  .detail button{
    position:absolute;top:10px;right:12px;background:none;border:0;
    color:var(--faint);cursor:pointer;font:inherit;font-size:15px;line-height:1;padding:2px 4px;
  }
  .detail button:hover{color:var(--text)}

  .pulse{
    position:fixed;left:20px;top:56px;display:flex;align-items:center;gap:8px;
    font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);
  }
  .pulse i{width:6px;height:6px;border-radius:50%;background:var(--live);display:block}
  .pulse.on i{animation:beat 2s ease-in-out infinite}
  @keyframes beat{0%,100%{opacity:.25}50%{opacity:1}}

  .empty{
    position:fixed;inset:0;display:grid;place-content:center;text-align:center;
    color:var(--faint);gap:8px;
  }
  .empty b{color:var(--dim);font-weight:600;letter-spacing:.1em;text-transform:uppercase;font-size:12px}
  :focus-visible{outline:1px solid var(--live);outline-offset:2px}
  @media (prefers-reduced-motion:reduce){.pulse.on i{animation:none}}
</style>
</head>
<body>
<canvas id="c"></canvas>

<div class="overlay">
  <header>
    <h1>Context graph · <span class="scope">${escapeHtml(scope)}</span></h1>
    <span class="meta">${escapeHtml(meta.database)}</span>
    ${meta.query ? `<span class="q">“${escapeHtml(meta.query)}”</span>` : ""}
  </header>
</div>

<div class="pulse" id="pulse"><i></i><span id="pulse-text">static snapshot</span></div>

<div class="stats" id="stats"></div>

<div class="legend">
  <div class="key"><span class="dot live"></span>current value</div>
  <div class="key"><span class="dot stale"></span>replaced</div>
  <div class="key"><span class="bar"></span>supersedes · with reason</div>
  <div class="key"><span class="dot entity"></span>entity (HydraDB)</div>
  <div class="key"><span class="dot agent"></span>handoff</div>
  <div class="key"><span class="dot pack"></span>in retrieved pack</div>
</div>

<div class="detail" id="detail">
  <button id="close" aria-label="Close">×</button>
  <h2 id="d-kind"></h2>
  <div class="when" id="d-when"></div>
  <p id="d-text"></p>
  <div class="why" id="d-why"></div>
</div>

<script>
(function(){
"use strict";
var LIVE = ${live};
var POLL = ${pollMs};
var graph = ${payload(graph)};

var COLOR = {
  fact:"#2ee6c5", superseded:"#4a5654", handoff:"#c8a2ff",
  entity:"#4d9dff", chunk:"#243033", session:"#243033"
};
var RADIUS = { fact:9, superseded:7, handoff:8, entity:5, chunk:4, session:5 };

var canvas = document.getElementById("c");
var ctx = canvas.getContext("2d");
var dpr = Math.min(window.devicePixelRatio || 1, 2);
var W = 0, H = 0;

var nodes = [], edges = [], byId = {};
var view = { x:0, y:0, k:1 };
var pointer = { x:0, y:0, down:false, moved:false, sx:0, sy:0 };
var hover = null, selected = null;

function resize(){
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener("resize", function(){ resize(); });
resize();

function adopt(next){
  var prev = byId;
  nodes = next.nodes.map(function(n){
    var old = prev[n.id];
    return Object.assign({}, n, {
      x: old ? old.x : W/2 + (Math.random()-0.5)*Math.min(W,H)*0.6,
      y: old ? old.y : H/2 + (Math.random()-0.5)*Math.min(W,H)*0.6,
      vx: 0, vy: 0,
      born: old ? old.born : performance.now()
    });
  });
  byId = {};
  nodes.forEach(function(n){ byId[n.id] = n; });
  edges = next.edges.filter(function(e){ return byId[e.source] && byId[e.target]; });
  graph = next;
  renderStats();
  if (selected && !byId[selected.id]) closeDetail();
}

function renderStats(){
  var s = graph.stats || {};
  var cells = [
    ["facts", s.facts || 0],
    ["replaced", s.superseded || 0],
    ["entities", s.entities || 0],
    ["explained", (s.explainedChanges || 0) + "/" + (s.totalChanges || 0)]
  ];
  document.getElementById("stats").innerHTML = cells.map(function(c){
    return '<div class="stat"><b>' + c[1] + '</b><span>' + c[0] + '</span></div>';
  }).join("");
}

function step(){
  var n = nodes.length;
  if (!n) return;
  var centreX = W/2, centreY = H/2;

  for (var i=0;i<n;i++){
    var a = nodes[i];
    for (var j=i+1;j<n;j++){
      var b = nodes[j];
      var dx = b.x-a.x, dy = b.y-a.y;
      var d2 = dx*dx + dy*dy || 0.01;
      if (d2 > 360000) continue;
      var d = Math.sqrt(d2);
      var f = 2600 / d2;
      var ux = dx/d, uy = dy/d;
      a.vx -= ux*f; a.vy -= uy*f;
      b.vx += ux*f; b.vy += uy*f;
    }
  }

  for (var e=0;e<edges.length;e++){
    var edge = edges[e];
    var s = byId[edge.source], t = byId[edge.target];
    var dx = t.x-s.x, dy = t.y-s.y;
    var d = Math.sqrt(dx*dx+dy*dy) || 0.01;
    var rest = edge.kind === "supersedes" ? 110 : edge.kind === "relates" ? 190 : 150;
    var f = (d - rest) * 0.014;
    var ux = dx/d, uy = dy/d;
    s.vx += ux*f; s.vy += uy*f;
    t.vx -= ux*f; t.vy -= uy*f;
  }

  for (var k=0;k<n;k++){
    var p = nodes[k];
    p.vx += (centreX - p.x) * 0.0016;
    p.vy += (centreY - p.y) * 0.0016;
    p.vx *= 0.86; p.vy *= 0.86;
    p.x += Math.max(-16, Math.min(16, p.vx));
    p.y += Math.max(-16, Math.min(16, p.vy));
  }
}

function toScreen(p){ return { x: p.x*view.k + view.x, y: p.y*view.k + view.y }; }

function draw(){
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle = "#000"; ctx.fillRect(0,0,W,H);

  for (var e=0;e<edges.length;e++){
    var edge = edges[e];
    var s = toScreen(byId[edge.source]), t = toScreen(byId[edge.target]);
    var causal = edge.kind === "supersedes";

    ctx.save();
    if (edge.kind === "authored") { ctx.setLineDash([3,5]); ctx.strokeStyle = "rgba(200,162,255,.30)"; }
    else if (causal) { ctx.strokeStyle = "rgba(255,92,77,.85)"; }
    else { ctx.strokeStyle = "rgba(120,140,138,.16)"; }
    ctx.lineWidth = causal ? 1.6 : 1;
    ctx.beginPath(); ctx.moveTo(s.x,s.y); ctx.lineTo(t.x,t.y); ctx.stroke();
    ctx.restore();

    if (causal) {
      var ang = Math.atan2(t.y-s.y, t.x-s.x);
      var r = (RADIUS[byId[edge.target].kind] || 6) * view.k + 4;
      var hx = t.x - Math.cos(ang)*r, hy = t.y - Math.sin(ang)*r;
      ctx.fillStyle = "rgba(255,92,77,.95)";
      ctx.beginPath();
      ctx.moveTo(hx,hy);
      ctx.lineTo(hx - Math.cos(ang-0.42)*9, hy - Math.sin(ang-0.42)*9);
      ctx.lineTo(hx - Math.cos(ang+0.42)*9, hy - Math.sin(ang+0.42)*9);
      ctx.closePath(); ctx.fill();

      if (edge.label && view.k > 0.7) {
        var mx = (s.x+t.x)/2, my = (s.y+t.y)/2;
        ctx.font = "10px ui-monospace,Menlo,monospace";
        var label = edge.label.length > 38 ? edge.label.slice(0,37) + "…" : edge.label;
        var w = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,.82)";
        ctx.fillRect(mx-w/2-5, my-14, w+10, 15);
        ctx.fillStyle = "rgba(255,92,77,.95)";
        ctx.textAlign = "center";
        ctx.fillText(label, mx, my-3);
      }
    }
  }

  for (var i=0;i<nodes.length;i++){
    var node = nodes[i];
    var p = toScreen(node);
    var r = (RADIUS[node.kind] || 6) * Math.max(0.65, Math.min(1.6, view.k));
    var stale = node.kind === "superseded";
    var colour = COLOR[node.kind] || "#5c6b68";
    var age = performance.now() - node.born;
    var fresh = age < 1400 ? 1 - age/1400 : 0;

    if (node.inPack) {
      ctx.beginPath(); ctx.arc(p.x,p.y,r+7,0,Math.PI*2);
      ctx.strokeStyle = "rgba(255,200,87,.85)"; ctx.lineWidth = 1.4; ctx.stroke();
    }
    if (fresh > 0) {
      ctx.beginPath(); ctx.arc(p.x,p.y,r + 26*fresh,0,Math.PI*2);
      ctx.strokeStyle = "rgba(46,230,197," + (fresh*0.55).toFixed(3) + ")";
      ctx.lineWidth = 1.5; ctx.stroke();
    }

    ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2);
    if (stale) {
      ctx.strokeStyle = colour; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.shadowColor = colour;
      ctx.shadowBlur = node === hover || node === selected ? 22 : 12;
      ctx.fillStyle = colour; ctx.fill();
      ctx.shadowBlur = 0;
    }

    if (view.k > 0.55 && node.kind !== "chunk") {
      ctx.font = (node === hover ? "600 " : "") + "11px ui-monospace,Menlo,monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = stale ? "rgba(150,166,163,.55)" : "rgba(232,240,238,.92)";
      var text = node.label.length > 30 ? node.label.slice(0,29) + "…" : node.label;
      ctx.fillText(text, p.x, p.y + r + 15);
    }
  }
}

function frame(){ step(); draw(); requestAnimationFrame(frame); }

function pick(mx,my){
  for (var i=nodes.length-1;i>=0;i--){
    var p = toScreen(nodes[i]);
    var r = (RADIUS[nodes[i].kind] || 6) * Math.max(0.65, Math.min(1.6, view.k)) + 6;
    if ((mx-p.x)*(mx-p.x) + (my-p.y)*(my-p.y) <= r*r) return nodes[i];
  }
  return null;
}

canvas.addEventListener("mousedown", function(ev){
  pointer.down = true; pointer.moved = false;
  pointer.sx = ev.clientX - view.x; pointer.sy = ev.clientY - view.y;
  canvas.classList.add("dragging");
});
window.addEventListener("mouseup", function(ev){
  canvas.classList.remove("dragging");
  if (pointer.down && !pointer.moved) {
    var hit = pick(ev.clientX, ev.clientY);
    if (hit) showDetail(hit); else closeDetail();
  }
  pointer.down = false;
});
canvas.addEventListener("mousemove", function(ev){
  pointer.x = ev.clientX; pointer.y = ev.clientY;
  if (pointer.down) {
    pointer.moved = true;
    view.x = ev.clientX - pointer.sx;
    view.y = ev.clientY - pointer.sy;
  } else {
    hover = pick(ev.clientX, ev.clientY);
    canvas.style.cursor = hover ? "pointer" : "grab";
  }
});
canvas.addEventListener("wheel", function(ev){
  ev.preventDefault();
  var factor = ev.deltaY < 0 ? 1.12 : 1/1.12;
  var next = Math.max(0.25, Math.min(3.5, view.k * factor));
  view.x = ev.clientX - (ev.clientX - view.x) * (next/view.k);
  view.y = ev.clientY - (ev.clientY - view.y) * (next/view.k);
  view.k = next;
}, { passive:false });

function showDetail(node){
  selected = node;
  document.getElementById("d-kind").textContent =
    node.kind === "superseded" ? "replaced value" :
    node.kind === "fact" ? "current value" : node.kind;
  var when = node.validFrom ? node.validFrom.slice(0,10) : "";
  if (node.validTo) when += " → " + node.validTo.slice(0,10);
  if (node.agent) when += (when ? " · " : "") + node.agent;
  document.getElementById("d-when").textContent = when;
  document.getElementById("d-text").textContent = node.detail || node.label;
  var why = document.getElementById("d-why");
  var edge = edges.filter(function(e){ return e.kind === "supersedes" && e.target === node.id && e.label; })[0];
  why.textContent = edge ? edge.label : "";
  why.style.display = edge ? "block" : "none";
  document.getElementById("detail").classList.add("on");
}
function closeDetail(){
  selected = null;
  document.getElementById("detail").classList.remove("on");
}
document.getElementById("close").addEventListener("click", closeDetail);
window.addEventListener("keydown", function(ev){ if (ev.key === "Escape") closeDetail(); });

adopt(graph);
frame();

if (LIVE) {
  var pulse = document.getElementById("pulse");
  pulse.classList.add("on");
  document.getElementById("pulse-text").textContent = "live";
  var fingerprint = JSON.stringify(graph.nodes.map(function(n){ return n.id; }));
  setInterval(function(){
    fetch(LIVE, { cache:"no-store" })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(next){
        if (!next || !next.nodes) return;
        var fp = JSON.stringify(next.nodes.map(function(n){ return n.id; }));
        if (fp === fingerprint) { renderStatsFrom(next); return; }
        fingerprint = fp;
        adopt(next);
      })
      .catch(function(){});
  }, POLL);
}
function renderStatsFrom(next){ graph.stats = next.stats; renderStats(); }
})();
</script>
</body>
</html>`;
}
