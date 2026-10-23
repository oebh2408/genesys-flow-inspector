import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInspectorApp, type InspectorApp } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'flows-'));
cpSync(new URL('../examples/flows', import.meta.url), dir, { recursive: true });
const inventory = new URL('../examples/inventory.json', import.meta.url).pathname;

let app: InspectorApp;
let server: Server;
let base = '';

beforeAll(async () => {
  app = createInspectorApp({ paths: [dir], inventory, pollMs: 0 });
  server = createServer(app.handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  base = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
  app.close();
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text(), headers: res.headers };
};

describe('serve', () => {
  it('serves the page and lists every flow with its issues', async () => {
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('mountDiagram');
    const list = JSON.parse((await get('/api/flows')).body);
    expect(list.flows.map((f: { name: string }) => f.name).sort()).toEqual(['After Hours', 'Support In-Queue', 'Support Line', 'Web Chat']);
    expect(list.totals).toEqual({ error: 3, warning: 6, info: 1 });
  });

  it('returns the laid-out diagram for one flow', async () => {
    const list = JSON.parse((await get('/api/flows')).body);
    const id = list.flows.find((f: { name: string }) => f.name === 'Support Line').id;
    const flow = JSON.parse((await get(`/api/flow?id=${encodeURIComponent(id)}`)).body);
    expect(flow.svg).toMatch(/^<svg class="diagram"/);
    expect(flow.data.issues.map((i: { rule: string }) => i.rule)).toContain('duplicate-dtmf');
    const html = await get(`/api/flow.html?id=${encodeURIComponent(id)}`);
    expect(html.headers.get('content-disposition')).toContain('support-line.html');
  });

  it('only serves flows it found, and only to local hosts', async () => {
    expect((await get('/api/flow?id=../../etc/passwd')).status).toBe(404);
    const status = await new Promise<number>((done) => {
      request(base + '/api/flows', { headers: { host: 'attacker.example' } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      }).end();
    });
    expect(status).toBe(403);
  });

  it('picks up new and broken files on refresh', async () => {
    writeFileSync(join(dir, 'broken.yaml'), 'inboundCall:\n  name: [unclosed\n');
    expect(app.refresh()).toBe(true);
    const list = JSON.parse((await get('/api/flows')).body);
    const broken = list.flows.find((f: { id: string }) => f.id.endsWith('broken.yaml'));
    expect(broken.error).toBeTruthy();
    expect(app.refresh()).toBe(false);
  });
});
