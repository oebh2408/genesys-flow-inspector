import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGraph, format, inspect, renderHtml } from '../src/index.js';

const yaml = readFileSync(new URL('../examples/flows/support-line.yaml', import.meta.url), 'utf8');
const result = inspect(yaml);

describe('graph', () => {
  it('has a node per block, choice and action, plus implicit ends', () => {
    const graph = buildGraph(result.flow, result.issues);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.has('start')).toBe(true);
    expect(ids.has('menu:Main Menu_10/choice/0')).toBe(true);
    expect(ids.has('task:Billing_20/end')).toBe(true);
    // every edge points at a node that exists
    for (const e of graph.edges) {
      expect(ids.has(e.from), e.from).toBe(true);
      expect(ids.has(e.to), e.to).toBe(true);
    }
    // the empty failure output of the data action skips to the transfer
    expect(graph.edges).toContainEqual({ from: 'task:Billing_20/0', to: 'task:Billing_20/1', label: 'failure', kind: 'flow' });
    // jumps are drawn to the target block
    expect(graph.edges).toContainEqual({ from: 'task:Order Lookup_35/1', to: 'task:Order Status_30', kind: 'jump' });
  });

  it('marks dead code', () => {
    const graph = buildGraph(result.flow, result.issues);
    const dead = graph.nodes.filter((n) => n.unreachable).map((n) => n.label);
    expect(dead).toEqual(['Disconnect after order status', 'Survey invite', 'Old Promotions']);
  });
});

describe('html', () => {
  it('is self-contained and embeds the issues', () => {
    const html = renderHtml(result, { source: 'support-line.yaml' });
    expect(html).toContain('<svg');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toContain('{{');
    expect(html).toContain('duplicate-dtmf');
  });

  it('escapes names', () => {
    const r = inspect('inboundCall:\n  name: "<b>x</b>"\n  tasks:\n    - task:\n        name: "</script>"\n        actions:\n          - disconnect:\n              name: d\n');
    const html = renderHtml(r);
    expect(html).not.toContain('<b>x</b>');
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });
});

describe('formats', () => {
  const files = [{ file: 'flows/support-line.yaml', issues: result.issues }];

  it('github annotations', () => {
    const out = format(files, 'github').split('\n');
    expect(out).toContain("::error file=flows/support-line.yaml,line=38,col=13,title=duplicate-dtmf::Key 2 in menu 'Main Menu' is used by both 'Technical support' and 'Order status'; only the first one is reachable.");
  });

  it('sarif', () => {
    const sarif = JSON.parse(format(files, 'sarif'));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results).toHaveLength(result.issues.length);
    expect(sarif.runs[0].results[1].locations[0].physicalLocation.region.startLine).toBe(38);
  });

  it('text summary', () => {
    expect(format(files, 'text')).toContain('1 file checked: 2 errors, 4 warnings, 1 info');
  });
});
