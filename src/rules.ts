import { allActions, requiredOutputs, roleOf, stronglyConnected, type Analysis } from './analysis.js';
import type { Flow, FlowBlock, Inventory, Issue, ResourceKind, Severity } from './types.js';

export interface RuleContext {
  flow: Flow;
  analysis: Analysis;
  inventory?: Inventory;
}

export interface Rule {
  id: string;
  severity: Severity;
  description: string;
  check(ctx: RuleContext): Omit<Issue, 'rule' | 'severity'>[];
}

/** Flow types where reaching the end of a task disconnects the customer. */
const CUSTOMER_FACING = /^inbound|^outboundCall$/;
/** Flow types that are expected to loop until an agent answers. */
const IN_QUEUE = /^inQueue/;

const label = (b: FlowBlock) => `${b.kind} '${b.name}'`;

export const rules: Rule[] = [
  {
    id: 'unresolved-reference',
    severity: 'error',
    description: 'A jump, menu choice or start reference points at a task, menu or state that does not exist in the flow.',
    check({ flow }) {
      const issues: Omit<Issue, 'rule' | 'severity'>[] = flow.unresolved.map((u) => ({
        message: `Reference '${u.ref}' does not match any task, menu or state in this flow.`,
        loc: u.loc,
        blockId: u.blockId,
        nodeId: u.sourceId,
      }));
      if (flow.startRef && !flow.startBlockId) {
        issues.push({ message: `Start reference '${flow.startRef}' does not match any task, menu or state.` });
      }
      return issues;
    },
  },
  {
    id: 'unreachable-block',
    severity: 'warning',
    description: 'A task, menu or state cannot be reached from the start of the flow.',
    check({ flow, analysis }) {
      if (!flow.startBlockId) return [];
      return flow.blocks
        .filter((b) => !analysis.reachable.has(b.id))
        .map((b) => ({ message: `The ${label(b)} is never reached from the start of the flow.`, loc: b.loc, blockId: b.id }));
    },
  },
  {
    id: 'unreachable-action',
    severity: 'warning',
    description: 'Actions placed after a disconnect, jump or other action that always ends the path.',
    check({ analysis }) {
      return analysis.unreachable.map((a) => ({
        message: `'${a.name ?? a.type}' never runs: every path before it ends earlier.`,
        loc: a.loc,
        blockId: a.blockId,
        nodeId: a.id,
      }));
    },
  },
  {
    id: 'implicit-end',
    severity: 'warning',
    description: 'A path reaches the end of a task without an explicit disconnect or transfer, so the customer is dropped without a message.',
    check({ flow, analysis }) {
      if (!CUSTOMER_FACING.test(flow.type)) return [];
      return analysis.implicitEnds.map((end) => {
        const block = flow.blocks.find((b) => b.id === end.blockId)!;
        const how = end.via ? ` ${end.via}` : ' because it has no actions';
        return {
          message: `The ${label(block)} reaches its end${how}. The interaction is disconnected without a message.`,
          loc: end.action?.loc ?? block.loc,
          blockId: block.id,
          nodeId: end.action?.id,
        };
      });
    },
  },
  {
    id: 'unhandled-failure',
    severity: 'warning',
    description: 'A data action or integration call has no actions on its failure or timeout output.',
    check({ flow }) {
      const issues: Omit<Issue, 'rule' | 'severity'>[] = [];
      for (const block of flow.blocks) {
        for (const a of allActions(block.actions)) {
          if (roleOf(a) === 'transfer') continue; // covered by implicit-end
          const expected = (requiredOutputs(a) ?? []).filter((o) => o === 'failure' || o === 'timeout');
          const present = a.branches.filter((b) => b.label === 'failure' || b.label === 'timeout').map((b) => b.label);
          const outputs = new Set([...expected, ...present]);
          const empty = [...outputs].filter((o) => !a.branches.find((b) => b.label === o)?.actions.length);
          if (empty.length) {
            issues.push({
              message: `'${a.name ?? a.type}' does nothing on ${empty.join(' or ')}; the flow continues as if the call had succeeded.`,
              loc: a.loc,
              blockId: a.blockId,
              nodeId: a.id,
            });
          }
        }
      }
      return issues;
    },
  },
  {
    id: 'jump-loop',
    severity: 'error',
    description: 'Tasks or states that jump to each other with no path that waits for input, transfers or disconnects.',
    check({ flow, analysis }) {
      if (IN_QUEUE.test(flow.type)) return [];
      const ids = flow.blocks.map((b) => b.id);
      const issues: Omit<Issue, 'rule' | 'severity'>[] = [];
      for (const comp of stronglyConnected(ids, analysis.blockEdges)) {
        const set = new Set(comp);
        const cyclic = comp.length > 1 || analysis.blockEdges.get(comp[0]!)?.has(comp[0]!);
        if (!cyclic) continue;
        const leaves = comp.some((id) => analysis.hasExit.has(id) || [...(analysis.blockEdges.get(id) ?? [])].some((t) => !set.has(t)));
        if (leaves) continue;
        const blocks = comp.map((id) => flow.blocks.find((b) => b.id === id)!);
        issues.push({
          message: `${blocks.map((b) => `'${b.name}'`).join(' -> ')} jump in a cycle with no way out. The interaction loops until the flow hits its execution limit.`,
          loc: blocks[0]!.loc,
          blockId: blocks[0]!.id,
        });
      }
      return issues;
    },
  },
  {
    id: 'duplicate-dtmf',
    severity: 'error',
    description: 'Two choices in the same menu use the same key.',
    check({ flow }) {
      const issues: Omit<Issue, 'rule' | 'severity'>[] = [];
      for (const menu of flow.blocks.filter((b) => b.kind === 'menu')) {
        const seen = new Map<string, string>();
        for (const c of menu.choices) {
          if (!c.dtmf) continue;
          const first = seen.get(c.dtmf);
          if (first !== undefined) {
            issues.push({
              message: `Key ${c.dtmf} in menu '${menu.name}' is used by both '${first}' and '${c.name ?? c.type}'; only the first one is reachable.`,
              loc: c.loc,
              blockId: menu.id,
              nodeId: c.id,
            });
          } else {
            seen.set(c.dtmf, c.name ?? c.type);
          }
        }
      }
      return issues;
    },
  },
  {
    id: 'empty-block',
    severity: 'warning',
    description: 'A menu without choices or a task or state without actions.',
    check({ flow }) {
      return flow.blocks
        .filter((b) => (b.kind === 'menu' ? b.choices.length === 0 : b.actions.length === 0))
        .map((b) => ({
          message: b.kind === 'menu' ? `Menu '${b.name}' has no choices.` : `The ${label(b)} has no actions.`,
          loc: b.loc,
          blockId: b.id,
        }));
    },
  },
  {
    id: 'unknown-resource',
    severity: 'error',
    description: 'A queue, data action, prompt or other resource referenced by name is not in the inventory file. Only runs when an inventory is given.',
    check({ flow, inventory }) {
      if (!inventory) return [];
      const lists = new Map<ResourceKind, Set<string>>();
      for (const [kind, names] of Object.entries(inventory)) {
        if (Array.isArray(names)) lists.set(kind as ResourceKind, new Set(names.map((n) => n.toLowerCase())));
      }
      return flow.references
        .filter((r) => lists.has(r.kind) && !lists.get(r.kind)!.has(r.name.toLowerCase()))
        .map((r) => ({
          message: `${KIND_LABEL[r.kind]} '${r.name}' is not in the inventory. Check the name or create it before publishing.`,
          loc: r.loc,
          blockId: r.blockId,
          nodeId: r.actionId,
        }));
    },
  },
  {
    id: 'silent-error-handling',
    severity: 'info',
    description: 'Flow-level error handling disconnects without playing a message first.',
    check({ flow }) {
      const handling = flow.settings.settingsErrorHandling as Record<string, unknown> | undefined;
      if (!handling) return [];
      const action = handling.errorHandling as Record<string, unknown> | undefined;
      const audio = handling.preHandlingAudio;
      if (action && 'disconnect' in action && (audio === undefined || audio === null)) {
        return [{ loc: flow.settingLocations.settingsErrorHandling, message: 'When an error occurs the flow disconnects without telling the customer. Consider a short message or a transfer to a fallback queue.' }];
      }
      return [];
    },
  },
];

const KIND_LABEL: Record<ResourceKind, string> = {
  queue: 'Queue',
  dataAction: 'Data action',
  prompt: 'Prompt',
  flow: 'Flow',
  scheduleGroup: 'Schedule group',
  schedule: 'Schedule',
  user: 'User',
  group: 'Group',
  skill: 'Skill',
};

