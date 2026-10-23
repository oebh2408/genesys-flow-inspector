import dagre from '@dagrejs/dagre';
import { stringify } from 'yaml';
import { buildGraph, type GraphNode, type NodeKind } from './graph.js';
import type { InspectResult, Issue, Severity } from './types.js';

const NODE_W = 216;
const NODE_H = 46;

interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderOptions {
  /** Shown in the page header, usually the file name. */
  source?: string;
}

/** The flow diagram, laid out: SVG markup plus what the side panel needs. Used by the static page and by `serve`. */
export interface Diagram {
  name: string;
  type: string;
  blocks: number;
  counts: Record<Severity, number>;
  width: number;
  height: number;
  svg: string;
  data: { issues: Issue[]; details: Record<string, unknown> };
}

export function renderDiagram(result: InspectResult): Diagram {
  const { flow, issues } = result;
  const graph = buildGraph(flow, issues);

  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({ rankdir: 'TB', nodesep: 28, ranksep: 42, edgesep: 14, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes) {
    const width = n.kind === 'start' ? NODE_W + 20 : NODE_W;
    g.setNode(n.id, { width, height: NODE_H });
  }
  for (const group of graph.groups) {
    g.setNode(`group:${group.id}`, { paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12 });
    for (const m of group.members) g.setParent(m, `group:${group.id}`);
  }
  graph.edges.forEach((e, i) => {
    const label = e.label ?? '';
    g.setEdge(e.from, e.to, { label, width: label ? label.length * 6.6 + 10 : 0, height: label ? 16 : 0, labelpos: 'c', minlen: e.kind === 'jump' ? 2 : 1 }, `e${i}`);
  });

  dagre.layout(g);

  const issuesByNode = new Map<string, Issue[]>();
  for (const issue of issues) {
    const key = issue.nodeId ?? issue.blockId;
    if (!key) continue;
    const list = issuesByNode.get(key) ?? [];
    list.push(issue);
    issuesByNode.set(key, list);
  }

  const parts: string[] = [];
  let maxX = 0;
  let maxY = 0;
  const grow = (p: Placed) => {
    maxX = Math.max(maxX, p.x + p.width / 2 + 40);
    maxY = Math.max(maxY, p.y + p.height / 2 + 40);
  };

  for (const group of graph.groups) {
    const c = g.node(`group:${group.id}`) as Placed | undefined;
    if (!c) continue;
    grow(c);
    parts.push(
      `<rect class="group group-${group.kind}" x="${c.x - c.width / 2}" y="${c.y - c.height / 2}" width="${c.width}" height="${c.height}" rx="12"/>`,
    );
  }

  graph.edges.forEach((e, i) => {
    const placed = g.edge({ v: e.from, w: e.to, name: `e${i}` }) as { points: { x: number; y: number }[]; x?: number; y?: number };
    if (!placed?.points?.length) return;
    parts.push(`<path class="edge edge-${e.kind}" d="${curve(placed.points)}" marker-end="url(#arrow-${e.kind})"/>`);
    if (e.label && placed.x !== undefined && placed.y !== undefined) {
      const w = e.label.length * 6.6 + 10;
      parts.push(
        `<g class="edge-label"><rect x="${placed.x - w / 2}" y="${placed.y - 9}" width="${w}" height="18" rx="9"/><text x="${placed.x}" y="${placed.y + 4}">${esc(e.label)}</text></g>`,
      );
    }
  });

  for (const n of graph.nodes) {
    const p = g.node(n.id) as Placed;
    grow(p);
    parts.push(renderNode(n, p, issuesByNode.get(n.id) ?? []));
  }

  const details: Record<string, unknown> = {};
  for (const n of graph.nodes) {
    details[n.id] = { label: n.label, detail: n.detail, kind: n.kind, line: n.line, raw: n.raw === undefined ? undefined : stringify(n.raw, { nullStr: '' }).trimEnd(), block: n.blockId ? flow.blocks.find((b) => b.id === n.blockId)?.name : undefined };
  }
  return {
    name: flow.name,
    type: flow.type,
    blocks: flow.blocks.length,
    counts: countBySeverity(issues),
    width: Math.ceil(maxX),
    height: Math.ceil(maxY),
    svg: parts.join('\n'),
    data: { issues, details },
  };
}

/** Render a self-contained HTML page with the flow diagram and its issues. No network access is needed to open it. */
export function renderHtml(result: InspectResult, options: RenderOptions = {}): string {
  const d = renderDiagram(result);
  return PAGE.replace('{{TITLE}}', () => esc(d.name))
    .replace('{{FLOW_NAME}}', () => esc(d.name))
    .replace('{{FLOW_META}}', () => esc([d.type, options.source, `${d.blocks} blocks`].filter(Boolean).join(' · ')))
    .replace('{{COUNTS}}', () => countsHtml(d.counts))
    .replace('{{SVG}}', () => svgElement(d))
    .replace('{{DATA}}', () => JSON.stringify(d.data).replace(/</g, '\\u003c'));
}

export function countsHtml(counts: Record<Severity, number>): string {
  return (['error', 'warning', 'info'] as Severity[]).map((s) => `<span class="count count-${s}">${counts[s]} ${s}${counts[s] === 1 || s === 'info' ? '' : 's'}</span>`).join('');
}

/** The `<svg>` element with arrow markers, ready to put inside the canvas. */
export function svgElement(d: Diagram): string {
  return `<svg class="diagram" xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}">
<defs>
<marker id="arrow-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="marker-flow" d="M0,0 L10,5 L0,10 z"/></marker>
<marker id="arrow-jump" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="marker-jump" d="M0,0 L10,5 L0,10 z"/></marker>
</defs>
${d.svg}
</svg>`;
}

function renderNode(n: GraphNode, p: Placed, nodeIssues: Issue[]): string {
  const x = p.x - p.width / 2;
  const y = p.y - p.height / 2;
  const worst = worstSeverity(nodeIssues);
  const classes = ['node', `kind-${n.kind}`, n.unreachable ? 'unreachable' : '', worst ? `has-${worst}` : ''].filter(Boolean).join(' ');
  const badge = worst
    ? `<g class="badge badge-${worst}"><circle cx="${x + p.width - 4}" cy="${y + 4}" r="9"/><text x="${x + p.width - 4}" y="${y + 8}">${nodeIssues.length}</text></g>`
    : '';
  return `<g class="${classes}" data-id="${esc(n.id)}" tabindex="0">
<rect class="box" x="${x}" y="${y}" width="${p.width}" height="${p.height}" rx="8"/>
<rect class="bar" x="${x}" y="${y}" width="5" height="${p.height}" rx="2"/>
<text class="label" x="${x + 16}" y="${y + 19}">${esc(truncate(n.label, 28))}</text>
<text class="detail" x="${x + 16}" y="${y + 35}">${esc(KIND_TEXT[n.kind] ?? n.detail)}${KIND_TEXT[n.kind] && n.detail !== n.kind && n.detail !== KIND_TEXT[n.kind] ? ` · ${esc(truncate(n.detail, 18))}` : ''}</text>
${badge}
</g>`;
}

const KIND_TEXT: Partial<Record<NodeKind, string>> = {
  start: 'start',
  menu: 'menu',
  task: 'task',
  state: 'state',
  fallthrough: 'implicit end',
};

/** Smooth path through dagre's edge points. */
function curve(points: { x: number; y: number }[]): string {
  const [first, ...rest] = points;
  if (!first) return '';
  if (rest.length === 0) return `M${first.x},${first.y}`;
  let d = `M${r(first.x)},${r(first.y)}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const c = rest[i]!;
    const next = rest[i + 1]!;
    d += ` Q${r(c.x)},${r(c.y)} ${r((c.x + next.x) / 2)},${r((c.y + next.y) / 2)}`;
  }
  const last = rest[rest.length - 1]!;
  d += ` L${r(last.x)},${r(last.y)}`;
  return d;
}

const r = (n: number) => Math.round(n * 10) / 10;

function worstSeverity(list: Issue[]): Severity | undefined {
  if (list.some((i) => i.severity === 'error')) return 'error';
  if (list.some((i) => i.severity === 'warning')) return 'warning';
  if (list.length) return 'info';
  return undefined;
}

function countBySeverity(list: Issue[]): Record<Severity, number> {
  const out = { error: 0, warning: 0, info: 0 };
  for (const i of list) out[i.severity]++;
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Colours, diagram and side panel styles shared by the static page and the `serve` app. */
export const DIAGRAM_CSS = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --line: #dfe3e8; --text: #1b1f24; --muted: #5f6b7a;
  --node: #ffffff; --group: #eef1f5; --edge: #8a96a6; --jump: #7a5af5; --hover: #eef1f5;
  --error: #d1343b; --warning: #c77700; --info: #2f6fd6; --accent: #2f6fd6;
  --menu: #7a5af5; --task: #1f8a70; --state: #1f8a70; --choice: #9b87f5; --decision: #2f6fd6;
  --data: #0e8fb3; --transfer: #c77700; --end: #5f6b7a; --jump-c: #7a5af5; --audio: #3aa776; --step: #8a96a6;
  --start: #1b1f24; --fallthrough: #d1343b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #161a20; --line: #2a313b; --text: #e6e9ee; --muted: #93a0b1;
    --node: #1c2129; --group: #141920; --edge: #5d6979; --jump: #a08cff; --hover: #1c2129;
    --error: #ff6b6b; --warning: #f0a83a; --info: #6aa1ff; --accent: #6aa1ff;
    --menu: #a08cff; --task: #3cc3a0; --state: #3cc3a0; --choice: #b9a9ff; --decision: #6aa1ff;
    --data: #3bbbe0; --transfer: #f0a83a; --end: #93a0b1; --jump-c: #a08cff; --audio: #5fd39b; --step: #6b7787;
    --start: #e6e9ee; --fallthrough: #ff6b6b;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
button, .button { display: inline-block; font: inherit; font-size: 13px; text-decoration: none; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 4px 10px; cursor: pointer; }
button:hover, .button:hover { border-color: var(--muted); }
.counts { display: flex; gap: 8px; flex-wrap: wrap; }
.count { font-size: 12px; padding: 2px 9px; border-radius: 99px; border: 1px solid var(--line); white-space: nowrap; }
.count-error { color: var(--error); } .count-warning { color: var(--warning); } .count-info { color: var(--info); }
.canvas { position: relative; overflow: hidden; cursor: grab; touch-action: none; }
.canvas.dragging { cursor: grabbing; }
.canvas svg { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
.panel { border-left: 1px solid var(--line); background: var(--panel); overflow: auto; }
.panel section { padding: 14px 16px; border-bottom: 1px solid var(--line); }
.panel h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.issue { display: block; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 6px; border-radius: 8px; border: 1px solid var(--line); background: transparent; }
.issue .rule { font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.issue.sev-error .rule { color: var(--error); } .issue.sev-warning .rule { color: var(--warning); } .issue.sev-info .rule { color: var(--info); }
.issue .line { float: right; color: var(--muted); font-size: 11.5px; }
.empty { color: var(--muted); }
pre { margin: 8px 0 0; padding: 10px; background: var(--bg); border-radius: 8px; overflow: auto; font-size: 12px; max-height: 320px; }
dl { margin: 0; display: grid; grid-template-columns: 70px 1fr; gap: 4px 10px; font-size: 13px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.group { fill: var(--group); stroke: var(--line); }
.edge { fill: none; stroke: var(--edge); stroke-width: 1.4; }
.edge-jump { stroke: var(--jump); stroke-dasharray: 5 4; }
.edge-label rect { fill: var(--bg); stroke: var(--line); }
.edge-label text { fill: var(--muted); font-size: 11px; text-anchor: middle; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.node { cursor: pointer; }
.node .box { fill: var(--node); stroke: var(--line); }
.node:hover .box, .node:focus .box { stroke: var(--muted); }
.node.selected .box { stroke: var(--text); stroke-width: 2; }
.node.has-error .box { stroke: var(--error); } .node.has-warning .box { stroke: var(--warning); }
.node .label { fill: var(--text); font-size: 12.5px; font-weight: 600; }
.node .detail { fill: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.node.unreachable { opacity: .45; }
.node:focus { outline: none; }
.badge circle { stroke: var(--panel); stroke-width: 2; }
.badge text { fill: #fff; font-size: 10.5px; font-weight: 700; text-anchor: middle; }
.badge-error circle { fill: var(--error); } .badge-warning circle { fill: var(--warning); } .badge-info circle { fill: var(--info); }
${(['menu', 'task', 'state', 'choice', 'decision', 'data', 'transfer', 'end', 'audio', 'step', 'start', 'fallthrough'] as const).map((k) => `.kind-${k} .bar { fill: var(--${k}); }`).join('\n')}
.kind-jump .bar { fill: var(--jump-c); }
.kind-start .box { fill: var(--start); } .kind-start .label { fill: var(--bg); } .kind-start .detail { fill: var(--bg); opacity: .7; }
.kind-fallthrough .box { stroke: var(--fallthrough); stroke-dasharray: 4 3; }
.marker-flow { fill: var(--edge); } .marker-jump { fill: var(--jump); }
`;

/**
 * Defines `mountDiagram(opts)`: pan and zoom on the canvas, node selection, the details panel and the issue list.
 * Returns `{ fit, select, zoom, view, destroy }`; pass a previous `view()` as `opts.view` to keep the zoom
 * and position across a re-render. Plain browser JavaScript, no dependencies.
 */
export const DIAGRAM_SCRIPT = String.raw`
function mountDiagram(opts) {
  const { canvas, details: detailsEl, issues: list, data } = opts;
  const svg = canvas.querySelector('svg');
  const W = svg.width.baseVal.value, H = svg.height.baseVal.value;
  const ac = new AbortController();
  const on = (el, ev, fn, o) => el.addEventListener(ev, fn, { signal: ac.signal, ...(o || {}) });
  let scale = 1, tx = 0, ty = 0;
  const apply = () => { svg.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; };
  const fit = () => {
    const r = canvas.getBoundingClientRect();
    scale = Math.min(r.width / W, r.height / H, 1);
    tx = (r.width - W * scale) / 2; ty = Math.max(0, (r.height - H * scale) / 2);
    apply();
  };
  const zoomAt = (factor, cx, cy) => {
    const next = Math.min(3, Math.max(0.15, scale * factor));
    tx = cx - (cx - tx) * (next / scale); ty = cy - (cy - ty) * (next / scale); scale = next; apply();
  };
  const zoom = (factor) => { const r = canvas.getBoundingClientRect(); zoomAt(factor, r.width / 2, r.height / 2); };
  on(canvas, 'wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  let drag = null;
  on(canvas, 'pointerdown', (e) => { if (e.target.closest('.node')) return; drag = { x: e.clientX - tx, y: e.clientY - ty }; canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId); });
  on(canvas, 'pointermove', (e) => { if (!drag) return; tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply(); });
  on(canvas, 'pointerup', () => { drag = null; canvas.classList.remove('dragging'); });

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const intro = detailsEl.innerHTML;
  const select = (id, center) => {
    svg.querySelectorAll('.node.selected').forEach((n) => n.classList.remove('selected'));
    const el = svg.querySelector('.node[data-id="' + CSS.escape(id) + '"]');
    const d = data.details[id];
    if (!el || !d) { detailsEl.innerHTML = intro; return false; }
    el.classList.add('selected');
    const own = data.issues.filter((i) => (i.nodeId || i.blockId) === id);
    detailsEl.innerHTML = '<h2>Details</h2><dl>' +
      '<dt>Name</dt><dd>' + esc(d.label) + '</dd>' +
      '<dt>Type</dt><dd>' + esc(d.detail) + '</dd>' +
      (d.block ? '<dt>Block</dt><dd>' + esc(d.block) + '</dd>' : '') +
      (d.line ? '<dt>Line</dt><dd>' + d.line + '</dd>' : '') + '</dl>' +
      own.map((i) => '<p class="issue sev-' + i.severity + '"><span class="rule">' + esc(i.rule) + '</span><br>' + esc(i.message) + '</p>').join('') +
      (d.raw ? '<pre>' + esc(d.raw) + '</pre>' : '');
    if (center) {
      const box = el.getBBox(), r = canvas.getBoundingClientRect();
      scale = Math.max(scale, 0.8);
      tx = r.width / 2 - (box.x + box.width / 2) * scale; ty = r.height / 2 - (box.y + box.height / 2) * scale; apply();
    }
    if (opts.onSelect) opts.onSelect(id);
    return true;
  };
  svg.querySelectorAll('.node').forEach((n) => {
    on(n, 'click', () => select(n.dataset.id, false));
    on(n, 'keydown', (e) => { if (e.key === 'Enter') select(n.dataset.id, false); });
  });
  list.innerHTML = data.issues.length ? '' : '<p class="empty">No issues found.</p>';
  data.issues.forEach((i) => {
    const b = document.createElement('button');
    b.className = 'issue sev-' + i.severity;
    b.innerHTML = (i.loc ? '<span class="line">line ' + i.loc.line + '</span>' : '') + '<span class="rule">' + esc(i.rule) + '</span><br>' + esc(i.message);
    b.onclick = () => { const id = i.nodeId || i.blockId; if (id) select(id, true); };
    list.appendChild(b);
  });
  on(window, 'resize', fit);
  if (opts.view) { scale = opts.view.scale; tx = opts.view.tx; ty = opts.view.ty; apply(); } else fit();
  return { fit, select, zoom, view: () => ({ scale, tx, ty }), destroy: () => ac.abort() };
}
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}} · flow inspector</title>
<style>
${DIAGRAM_CSS}
header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { margin: 0; font-size: 16px; font-weight: 600; }
header .meta { color: var(--muted); font-size: 12.5px; }
.tools { margin-left: auto; display: flex; gap: 6px; }
main { display: grid; grid-template-columns: 1fr 360px; height: calc(100% - 57px); }
@media (max-width: 800px) {
  main { grid-template-columns: 1fr; grid-template-rows: 60vh auto; height: auto; }
  .panel { border-left: 0; border-top: 1px solid var(--line); }
  .tools { margin-left: 0; }
}
</style>
</head>
<body>
<header>
  <div><h1>{{FLOW_NAME}}</h1><div class="meta">{{FLOW_META}}</div></div>
  <div class="counts">{{COUNTS}}</div>
  <div class="tools"><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="fit">Fit</button></div>
</header>
<main>
  <div class="canvas" id="canvas">{{SVG}}</div>
  <aside class="panel">
    <section id="details"><h2>Details</h2><p class="empty">Select a node to see its definition.</p></section>
    <section><h2>Issues</h2><div id="issues"></div></section>
  </aside>
</main>
<script type="application/json" id="data">{{DATA}}</script>
<script>
${DIAGRAM_SCRIPT}
const view = mountDiagram({
  canvas: document.getElementById('canvas'),
  details: document.getElementById('details'),
  issues: document.getElementById('issues'),
  data: JSON.parse(document.getElementById('data').textContent),
});
document.getElementById('fit').onclick = view.fit;
document.getElementById('zoom-in').onclick = () => view.zoom(1.25);
document.getElementById('zoom-out').onclick = () => view.zoom(0.8);
</script>
</body>
</html>
`;
