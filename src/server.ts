import { statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, relative, resolve } from 'node:path';
import { collectFiles, inspectFile, loadOptions, type OptionSources } from './files.js';
import { DIAGRAM_CSS, DIAGRAM_SCRIPT, renderDiagram, renderHtml, svgElement } from './render.js';
import { rules } from './rules.js';
import type { InspectOptions, InspectResult, Issue, Severity } from './types.js';

export interface AppOptions extends OptionSources {
  /** Files or directories with flows. */
  paths: string[];
  /** How often to look for changed files, in ms. Default 1000; 0 turns it off. */
  pollMs?: number;
}

interface Entry {
  id: string;
  file: string;
  mtime: number;
  issues: Issue[];
  result?: InspectResult;
}

export interface InspectorApp {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  /** Re-reads changed files; returns true when something changed. */
  refresh: () => boolean;
  close: () => void;
}

/**
 * The `serve` web app: a node:http handler with the page and a small JSON API, plus a poller that
 * re-inspects flows when their files change and tells open pages through server-sent events.
 */
export function createInspectorApp(options: AppOptions): InspectorApp {
  const cwd = process.cwd();
  const entries = new Map<string, Entry>();
  // The last options that loaded; kept while the config or inventory file is broken.
  let settings: { options: InspectOptions; stamp: string; error?: string } = { options: {}, stamp: '' };
  let version = 0;
  const clients = new Set<ServerResponse>();

  const stamp = (files: string[]) => files.map((f) => `${f}:${mtimeOf(f)}`).join('|');

  const refresh = (): boolean => {
    let changed = false;
    try {
      const loaded = loadOptions({ config: options.config, inventory: options.inventory });
      const s = stamp(loaded.files);
      if (s !== settings.stamp || settings.error) {
        settings = { options: { rules: loaded.rules, inventory: loaded.inventory }, stamp: s };
        entries.clear();
        changed = true;
      }
    } catch (err) {
      const message = (err as Error).message;
      if (settings.error !== message) changed = true;
      settings = { ...settings, error: message };
    }
    const inspectOptions = settings.options;

    let files: string[] = [];
    try {
      files = collectFiles(options.paths);
    } catch {
      // a path that disappeared shows up as an empty list
    }
    const seen = new Set<string>();
    for (const file of files) {
      const id = relative(cwd, file) || basename(file);
      seen.add(id);
      const mtime = mtimeOf(file);
      const known = entries.get(id);
      if (known && known.mtime === mtime) continue;
      let found: ReturnType<typeof inspectFile>;
      try {
        found = inspectFile(file, inspectOptions);
      } catch (err) {
        found = { file, issues: [{ rule: 'parse-error', severity: 'error', message: (err as Error).message }] };
      }
      entries.set(id, { id, file, mtime, issues: found.issues, result: found.result });
      changed = true;
    }
    for (const id of [...entries.keys()]) {
      if (!seen.has(id)) {
        entries.delete(id);
        changed = true;
      }
    }
    if (changed) {
      version++;
      for (const c of clients) c.write(`event: change\ndata: ${version}\n\n`);
    }
    return changed;
  };

  refresh();
  const timer = options.pollMs === 0 ? undefined : setInterval(refresh, options.pollMs ?? 1000);
  timer?.unref();
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  const summary = () => {
    const flows = [...entries.values()].map((e) => ({
      id: e.id,
      name: e.result?.flow.name ?? basename(e.file),
      type: e.result?.flow.type,
      blocks: e.result?.flow.blocks.length ?? 0,
      counts: count(e.issues),
      error: e.result ? undefined : e.issues[0]?.message,
      issues: e.issues,
    }));
    return {
      version,
      root: options.paths.map((p) => relative(cwd, resolve(p)) || '.').join(', '),
      configError: settings.error,
      totals: count(flows.flatMap((f) => f.issues)),
      flows,
      rules: rules.map((r) => ({ id: r.id, description: r.description, default: r.severity, severity: settings.options.rules?.[r.id] ?? r.severity })),
    };
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!isLocalHost(req.headers.host)) return send(res, 403, 'text/plain', 'Forbidden');
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');

    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', APP_PAGE);
    if (url.pathname === '/api/flows') return json(res, summary());
    if (url.pathname === '/api/flow' || url.pathname === '/api/flow.html') {
      const entry = entries.get(url.searchParams.get('id') ?? '');
      if (!entry) return json(res, { error: 'Not found' }, 404);
      if (!entry.result) return json(res, { id: entry.id, error: entry.issues[0]?.message, issues: entry.issues });
      if (url.pathname === '/api/flow.html') {
        res.setHeader('content-disposition', `attachment; filename="${basename(entry.file).replace(/\.ya?ml$/i, '').replace(/[^\w.-]+/g, '_')}.html"`);
        return send(res, 200, 'text/html; charset=utf-8', renderHtml(entry.result, { source: basename(entry.file) }));
      }
      const d = renderDiagram(entry.result);
      return json(res, { id: entry.id, file: entry.id, name: d.name, type: d.type, blocks: d.blocks, counts: d.counts, svg: svgElement(d), data: d.data });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${version}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    send(res, 404, 'text/plain', 'Not found');
  };

  return {
    handler,
    refresh,
    close: () => {
      if (timer) clearInterval(timer);
      clearInterval(heartbeat);
      for (const c of clients) c.end();
      clients.clear();
    },
  };
}

/** Starts the web app and resolves once it is listening. */
export function serve(options: AppOptions & { port?: number; host?: string }): Promise<Server> {
  const app = createInspectorApp(options);
  const server = createServer(app.handler);
  server.on('close', app.close);
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 4100, options.host ?? '127.0.0.1', () => done(server));
  });
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

function count(issues: Issue[]): Record<Severity, number> {
  const out = { error: 0, warning: 0, info: 0 };
  for (const i of issues) out[i.severity]++;
  return out;
}

/** Refuses requests whose Host is not a loopback name, so another site cannot reach the app through DNS rebinding. */
function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || process.env.FLOW_INSPECTOR_ALLOW_HOST === name;
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

const APP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flow inspector</title>
<link rel="icon" href="data:,">
<style>
${DIAGRAM_CSS}
body { display: grid; grid-template-rows: auto 1fr; height: 100vh; overflow: hidden; }
a { color: inherit; text-decoration: none; }
.top { display: flex; align-items: center; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }
.brand { font-weight: 650; letter-spacing: -.01em; white-space: nowrap; }
.brand span { color: var(--muted); font-weight: 400; }
.root { color: var(--muted); font-size: 12.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live { margin-left: auto; display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.live i { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.live.on i { background: #22a06b; box-shadow: 0 0 0 3px color-mix(in srgb, #22a06b 25%, transparent); }
.app { display: grid; grid-template-columns: 290px 1fr; min-height: 0; }
.side { border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; min-height: 0; }
.side .search { padding: 12px; border-bottom: 1px solid var(--line); }
.side input { width: 100%; font: inherit; font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 6px 9px; }
.side nav { overflow: auto; padding: 6px; flex: 1; }
.side .item { display: block; padding: 8px 10px; border-radius: 8px; margin-bottom: 2px; }
.side .item:hover { background: var(--hover); }
.side .item.active { background: var(--hover); box-shadow: inset 3px 0 0 var(--accent); }
.side .item .name { font-weight: 550; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side .item .sub { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-top: 2px; }
.side .item .sub span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pips { display: flex; gap: 5px; flex: none; }
.pip { font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px; color: var(--muted); }
.pip:before { content: ""; width: 7px; height: 7px; border-radius: 50%; }
.pip-error:before { background: var(--error); } .pip-warning:before { background: var(--warning); } .pip-info:before { background: var(--info); }
.side .heading { padding: 12px 10px 4px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.side .foot { border-top: 1px solid var(--line); padding: 6px; }
#view { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
.bar h1 { margin: 0; font-size: 16px; font-weight: 600; }
.bar .meta { color: var(--muted); font-size: 12.5px; }
.bar .tools { margin-left: auto; display: flex; gap: 6px; }
.split { flex: 1; display: grid; grid-template-columns: 1fr 360px; min-height: 0; }
.page { flex: 1; overflow: auto; padding: 20px 24px 40px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 22px; max-width: 900px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.card b { display: block; font-size: 24px; font-weight: 600; }
.card span { color: var(--muted); font-size: 12.5px; }
.card.error b { color: var(--error); } .card.warning b { color: var(--warning); } .card.info b { color: var(--info); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.filters button.on { border-color: var(--text); }
.filters select { font: inherit; font-size: 13px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 4px 8px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; font-size: 13px; }
th { text-align: left; font-size: 11.5px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding: 9px 12px; border-bottom: 1px solid var(--line); }
td { padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
tbody tr { cursor: pointer; } tbody tr:hover td { background: var(--hover); }
td.mono, td .mono { white-space: nowrap; }
td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.lvl { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.lvl-error { color: var(--error); } .lvl-warning { color: var(--warning); } .lvl-info { color: var(--info); }
.notice { margin: 16px; padding: 12px 14px; border: 1px solid var(--error); border-radius: 10px; background: var(--panel); }
.notice b { color: var(--error); }
h2.title { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
p.lead { color: var(--muted); margin: 0 0 18px; }
@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
  .side { border-right: 0; border-bottom: 1px solid var(--line); max-height: 34vh; }
  .split { grid-template-columns: 1fr; grid-template-rows: 55vh auto; overflow: auto; }
  .panel { border-left: 0; border-top: 1px solid var(--line); }
}
</style>
</head>
<body>
<header class="top">
  <div class="brand">flow <span>inspector</span></div>
  <div class="root" id="root"></div>
  <div class="counts" id="totals"></div>
  <div class="live" id="live"><i></i><span>connecting</span></div>
</header>
<div class="app">
  <aside class="side">
    <div class="search"><input id="filter" type="search" placeholder="Filter flows" aria-label="Filter flows"></div>
    <nav id="nav"></nav>
    <div class="foot"><a class="item" href="#/rules" id="rules-link"><div class="name">Rules</div></a></div>
  </aside>
  <main id="view"></main>
</div>
<script>
${DIAGRAM_SCRIPT}
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plural = (n, w) => n + ' ' + w + (n === 1 || w === 'info' ? '' : 's');
  const counts = (c) => ['error', 'warning', 'info'].map((s) => '<span class="count count-' + s + '">' + plural(c[s], s) + '</span>').join('');
  const pips = (c) => ['error', 'warning', 'info'].filter((s) => c[s]).map((s) => '<span class="pip pip-' + s + '" title="' + plural(c[s], s) + '">' + c[s] + '</span>').join('');
  const flowHref = (id, node) => '#/flow/' + encodeURIComponent(id) + (node ? '/' + encodeURIComponent(node) : '');
  let state = null, mounted = null, current = null, overviewFilter = { severity: '', rule: '' };

  const route = () => {
    const parts = location.hash.replace(/^#\\/?/, '').split('/');
    if (parts[0] === 'flow' && parts[1]) return { page: 'flow', id: decodeURIComponent(parts[1]), node: parts[2] ? decodeURIComponent(parts[2]) : undefined };
    if (parts[0] === 'rules') return { page: 'rules' };
    return { page: 'overview' };
  };

  const renderNav = () => {
    const q = $('filter').value.trim().toLowerCase();
    const r = route();
    const flows = state.flows.filter((f) => !q || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q));
    $('nav').innerHTML =
      '<a class="item' + (r.page === 'overview' ? ' active' : '') + '" href="#/"><div class="name">Overview</div><div class="sub"><span>' + plural(state.flows.length, 'flow') + '</span><span class="pips">' + pips(state.totals) + '</span></div></a>' +
      '<div class="heading">Flows</div>' +
      (flows.length ? flows.map((f) =>
        '<a class="item' + (r.page === 'flow' && r.id === f.id ? ' active' : '') + '" href="' + flowHref(f.id) + '" title="' + esc(f.id) + '">' +
        '<div class="name">' + esc(f.name) + '</div>' +
        '<div class="sub"><span>' + esc(f.error ? 'cannot be parsed' : f.type) + '</span><span class="pips">' + pips(f.counts) + '</span></div></a>').join('')
        : '<p class="empty" style="padding:8px 10px">No flows match.</p>');
    $('rules-link').classList.toggle('active', r.page === 'rules');
  };

  const renderTop = () => {
    $('root').textContent = state.root;
    $('totals').innerHTML = counts(state.totals);
  };

  const unmount = () => { if (mounted) { mounted.destroy(); mounted = null; } current = null; };

  const showOverview = () => {
    unmount();
    const all = state.flows.flatMap((f) => f.issues.map((i) => ({ ...i, flow: f })));
    const ruleIds = [...new Set(all.map((i) => i.rule))].sort();
    const shown = all.filter((i) => (!overviewFilter.severity || i.severity === overviewFilter.severity) && (!overviewFilter.rule || i.rule === overviewFilter.rule));
    const t = state.totals;
    $('view').innerHTML = '<div class="page">' +
      (state.configError ? '<div class="notice"><b>Config</b> ' + esc(state.configError) + '</div>' : '') +
      '<h2 class="title">Overview</h2><p class="lead">' + plural(state.flows.length, 'flow') + ' in ' + esc(state.root) + '. Files are re-checked when they change.</p>' +
      '<div class="cards"><div class="card"><b>' + state.flows.length + '</b><span>flows</span></div>' +
      ['error', 'warning', 'info'].map((s) => '<div class="card ' + s + '"><b>' + t[s] + '</b><span>' + s + (t[s] === 1 || s === 'info' ? '' : 's') + '</span></div>').join('') + '</div>' +
      '<div class="filters">' + ['', 'error', 'warning', 'info'].map((s) => '<button data-sev="' + s + '" class="' + (overviewFilter.severity === s ? 'on' : '') + '">' + (s || 'All') + '</button>').join('') +
      '<select id="rule-filter"><option value="">All rules</option>' + ruleIds.map((r) => '<option' + (overviewFilter.rule === r ? ' selected' : '') + '>' + esc(r) + '</option>').join('') + '</select></div>' +
      (shown.length
        ? '<table><thead><tr><th>Severity</th><th>Rule</th><th>Flow</th><th>Line</th><th>Message</th></tr></thead><tbody>' +
          shown.map((i) => '<tr data-href="' + flowHref(i.flow.id, i.nodeId || i.blockId) + '"><td class="lvl lvl-' + i.severity + '">' + i.severity + '</td><td class="mono">' + esc(i.rule) + '</td><td title="' + esc(i.flow.id) + '">' + esc(i.flow.name) + '<div class="mono empty">' + esc(i.flow.id.split("/").pop()) + '</div></td><td class="mono">' + (i.loc ? i.loc.line : '') + '</td><td>' + esc(i.message) + '</td></tr>').join('') +
          '</tbody></table>'
        : '<p class="empty">' + (all.length ? 'No issues match the filter.' : 'No issues found.') + '</p>') +
      '</div>';
    $('view').querySelectorAll('[data-sev]').forEach((b) => { b.onclick = () => { overviewFilter.severity = b.dataset.sev; showOverview(); }; });
    $('rule-filter').onchange = (e) => { overviewFilter.rule = e.target.value; showOverview(); };
    $('view').querySelectorAll('tr[data-href]').forEach((tr) => { tr.onclick = () => { location.hash = tr.dataset.href; }; });
  };

  const showRules = () => {
    unmount();
    $('view').innerHTML = '<div class="page"><h2 class="title">Rules</h2><p class="lead">Severity comes from the config file when it sets one; otherwise the default applies.</p>' +
      '<table><thead><tr><th>Rule</th><th>Severity</th><th>Default</th><th>What it finds</th></tr></thead><tbody>' +
      state.rules.map((r) => '<tr><td class="mono">' + esc(r.id) + '</td><td class="lvl lvl-' + r.severity + '">' + r.severity + '</td><td class="mono empty">' + r.default + '</td><td>' + esc(r.description) + '</td></tr>').join('') +
      '</tbody></table></div>';
  };

  const showFlow = async (id, node, keepView) => {
    const res = await fetch('api/flow?id=' + encodeURIComponent(id));
    if (res.status === 404) { $('view').innerHTML = '<div class="notice"><b>Not found</b> ' + esc(id) + ' is no longer in the folder.</div>'; unmount(); return; }
    const flow = await res.json();
    const previous = keepView && mounted ? mounted.view() : undefined;
    const selected = keepView && current ? current.selected : undefined;
    if (mounted) mounted.destroy();
    mounted = null;
    if (flow.error) {
      current = null;
      $('view').innerHTML = '<div class="notice"><b>Cannot parse ' + esc(id) + '</b><br>' + esc(flow.error) + (flow.issues[0] && flow.issues[0].loc ? ' (line ' + flow.issues[0].loc.line + ')' : '') + '</div>';
      return;
    }
    $('view').innerHTML =
      '<div class="bar"><div><h1>' + esc(flow.name) + '</h1><div class="meta">' + esc([flow.type, flow.file, plural(flow.blocks, 'block')].join(' · ')) + '</div></div>' +
      '<div class="counts">' + counts(flow.counts) + '</div>' +
      '<div class="tools"><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="fit">Fit</button><a class="button" href="api/flow.html?id=' + encodeURIComponent(id) + '">Download HTML</a></div></div>' +
      '<div class="split"><div class="canvas" id="canvas">' + flow.svg + '</div>' +
      '<aside class="panel"><section id="details"><h2>Details</h2><p class="empty">Select a node to see its definition.</p></section><section><h2>Issues</h2><div id="issues"></div></section></aside></div>';
    current = { id, selected: undefined };
    mounted = mountDiagram({
      canvas: $('canvas'), details: $('details'), issues: $('issues'), data: flow.data, view: previous,
      onSelect: (nodeId) => { current.selected = nodeId; history.replaceState(null, '', flowHref(id, nodeId)); },
    });
    $('fit').onclick = mounted.fit;
    $('zoom-in').onclick = () => mounted.zoom(1.25);
    $('zoom-out').onclick = () => mounted.zoom(0.8);
    const target = selected || node;
    if (target) mounted.select(target, !selected);
  };

  const render = (fromChange) => {
    renderTop();
    renderNav();
    const r = route();
    if (r.page === 'flow') {
      if (!state.flows.some((f) => f.id === r.id)) { location.hash = '#/'; return; }
      return showFlow(r.id, r.node, fromChange && current && current.id === r.id);
    }
    if (r.page === 'rules') return showRules();
    showOverview();
  };

  const load = async (fromChange) => {
    state = await (await fetch('api/flows')).json();
    await render(fromChange);
  };

  window.addEventListener('hashchange', () => {
    const r = route();
    // Selecting a node rewrites the hash without a reload; only react when the flow or page changes.
    if (r.page === 'flow' && current && current.id === r.id) { if (r.node && r.node !== current.selected) mounted.select(r.node, true); renderNav(); return; }
    render(false);
  });
  $('filter').addEventListener('input', renderNav);

  const connect = () => {
    const live = $('live');
    const events = new EventSource('api/events');
    let seen = null;
    events.addEventListener('hello', (e) => { live.className = 'live on'; live.lastChild.textContent = 'watching for changes'; if (seen !== null && e.data !== seen) load(true); seen = e.data; });
    events.addEventListener('change', (e) => { seen = e.data; load(true); });
    events.onerror = () => { live.className = 'live'; live.lastChild.textContent = 'disconnected, retrying'; };
  };

  load(false).then(connect);
})();
</script>
</body>
</html>
`;
