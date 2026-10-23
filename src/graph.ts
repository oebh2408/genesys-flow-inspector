import { requiredOutputs, roleOf } from './analysis.js';
import type { Flow, FlowAction, Issue } from './types.js';

export type NodeKind =
  | 'start'
  | 'menu'
  | 'task'
  | 'state'
  | 'choice'
  | 'decision'
  | 'data'
  | 'transfer'
  | 'end'
  | 'jump'
  | 'audio'
  | 'step'
  | 'fallthrough';

export interface GraphNode {
  id: string;
  label: string;
  detail: string;
  kind: NodeKind;
  blockId?: string;
  line?: number;
  /** Action or choice raw definition, shown in the viewer's side panel. */
  raw?: unknown;
  unreachable?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  kind: 'flow' | 'jump';
}

export interface FlowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Block id → node ids inside it, used to draw block frames. */
  groups: { id: string; label: string; kind: string; members: string[] }[];
}

interface Pending {
  from: string;
  label?: string;
}

/** Turn a parsed flow into nodes and edges for the viewer. Layout happens in render.ts. */
export function buildGraph(flow: Flow, issues: Issue[] = []): FlowGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const groups: FlowGraph['groups'] = [];
  const unreachableActions = new Set(issues.filter((i) => i.rule === 'unreachable-action').map((i) => i.nodeId));
  const unreachableBlocks = new Set(issues.filter((i) => i.rule === 'unreachable-block').map((i) => i.blockId));
  const customerFacing = /^inbound|^outboundCall$/.test(flow.type);

  nodes.push({ id: 'start', label: flow.name, detail: flow.type, kind: 'start' });
  if (flow.startBlockId) edges.push({ from: 'start', to: flow.startBlockId, kind: 'flow' });

  for (const block of flow.blocks) {
    const members: string[] = [block.id];
    const add = (node: GraphNode) => {
      nodes.push(node);
      members.push(node.id);
    };
    nodes.push({
      id: block.id,
      label: block.name,
      detail: block.kind,
      kind: block.kind,
      blockId: block.id,
      line: block.loc?.line,
      unreachable: unreachableBlocks.has(block.id),
    });

    if (block.kind === 'menu') {
      for (const c of block.choices) {
        const key = c.dtmf ? `${c.dtmf} · ` : '';
        add({ id: c.id, label: `${key}${c.name ?? c.type}`, detail: c.type, kind: 'choice', blockId: block.id, line: c.loc?.line, raw: c.raw });
        edges.push({ from: block.id, to: c.id, kind: 'flow' });
        if (c.targetBlockId) edges.push({ from: c.id, to: c.targetBlockId, kind: 'jump' });
      }
    } else {
      let unreachableRun = false;
      const wire = (actions: FlowAction[], pending: Pending[]): Pending[] => {
        const outer = unreachableRun;
        let current = pending;
        for (const a of actions) {
          if (unreachableActions.has(a.id)) unreachableRun = true;
          add({
            id: a.id,
            label: a.name ?? a.type,
            detail: a.type,
            kind: kindOf(a),
            blockId: block.id,
            line: a.loc?.line,
            raw: a.raw,
            unreachable: unreachableRun || undefined,
          });
          for (const p of current) edges.push({ from: p.from, to: a.id, label: p.label, kind: 'flow' });
          current = [];

          for (const b of a.branches) current.push(...wire(b.actions, [{ from: a.id, label: b.label }]));

          const role = roleOf(a);
          if (role === 'jump') {
            if (a.targetBlockId) edges.push({ from: a.id, to: a.targetBlockId, kind: 'jump' });
          } else if (role === 'transfer') {
            if (!a.branches.some((b) => b.label === 'failure')) current.push({ from: a.id, label: 'failure' });
          } else if (role === 'loop') {
            current.push({ from: a.id, label: 'done' });
          } else if (role === 'step') {
            const required = requiredOutputs(a) ?? (a.type === 'switch' ? ['default'] : []);
            for (const label of required) if (!a.branches.some((b) => b.label === label)) current.push({ from: a.id, label });
            if (a.branches.length === 0) current.push({ from: a.id });
          }
          // Paths that start in dead code do not lead anywhere worth drawing.
          if (unreachableRun) current = [];
        }
        unreachableRun = outer;
        return current;
      };

      const dangling = wire(block.actions, [{ from: block.id }]);
      if (dangling.length) {
        const endId = `${block.id}/end`;
        add({
          id: endId,
          label: customerFacing ? 'End of task (disconnects)' : `End of ${block.kind}`,
          detail: 'implicit end',
          kind: 'fallthrough',
          blockId: block.id,
        });
        for (const p of dangling) edges.push({ from: p.from, to: endId, label: p.label, kind: 'flow' });
      }
    }
    groups.push({ id: block.id, label: block.name, kind: block.kind, members });
  }
  return { nodes, edges, groups };
}

function kindOf(a: FlowAction): NodeKind {
  switch (roleOf(a)) {
    case 'end':
      return 'end';
    case 'jump':
      return 'jump';
    case 'transfer':
      return 'transfer';
    default:
      break;
  }
  if (/^call(Data|Bridge|DigitalBot|BotFlow|BotConnector|Lex)/.test(a.type)) return 'data';
  if (/audio|Audio|playMessage|holdMusic/.test(a.type)) return 'audio';
  if (a.branches.length > 0) return 'decision';
  return 'step';
}
