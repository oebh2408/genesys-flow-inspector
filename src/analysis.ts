import type { Flow, FlowAction } from './types.js';

/** How an action affects the path it is on. */
export type ActionRole = 'end' | 'jump' | 'transfer' | 'loop' | 'loopControl' | 'step';

const END_TYPES = new Set([
  'disconnect',
  'endTask',
  'endState',
  'endWorkflow',
  'endFlow',
  'exitFlow',
  'exitBotFlow',
  'returnToMenu',
  'previousMenu',
  'repeatMenu',
]);

const JUMP_TYPES = new Set(['jumpToTask', 'jumpToMenu', 'jumpToReusableTask', 'changeState']);
const LOOP_CONTROL_TYPES = new Set(['exitLoop', 'loopNext', 'nextLoop']);
const LOOP_TYPES = new Set(['loop', 'loopAnytime']);
/** Actions that keep the interaction waiting, so a cycle through them is not a busy loop. */
const WAITING_TYPES = new Set(['holdMusic', 'wait', 'playAudioOnSilence', 'askForInput', 'askForYesNo', 'askForIntent', 'askForSlot', 'communicate', 'collectInput', 'getDigits']);

/** Outputs an action must define before all its paths are covered. */
const REQUIRED_OUTPUTS: Record<string, string[]> = {
  decision: ['yes', 'no'],
  callData: ['success', 'failure', 'timeout'],
  callBridge: ['success', 'failure'],
  evaluateSchedule: ['open', 'closed', 'holiday'],
  evaluateScheduleGroup: ['open', 'closed', 'holiday', 'emergency'],
};

export function roleOf(action: FlowAction): ActionRole {
  if (END_TYPES.has(action.type)) return 'end';
  if (JUMP_TYPES.has(action.type) || action.targetRef) return 'jump';
  if (action.type.startsWith('transferTo')) return 'transfer';
  if (LOOP_TYPES.has(action.type)) return 'loop';
  if (LOOP_CONTROL_TYPES.has(action.type)) return 'loopControl';
  return 'step';
}

export function isWaiting(action: FlowAction): boolean {
  return WAITING_TYPES.has(action.type) || /^askFor/.test(action.type);
}

export function requiredOutputs(action: FlowAction): string[] | undefined {
  return REQUIRED_OUTPUTS[action.type];
}

export interface ImplicitEnd {
  blockId: string;
  /** Human-readable description of the path that falls through. */
  via?: string;
  /** Action the issue points at: the last action of the task. */
  action?: FlowAction;
}

export interface Analysis {
  /** First unreachable action of each action list that has dead code. */
  unreachable: FlowAction[];
  implicitEnds: ImplicitEnd[];
  /** Blocks with at least one path that leaves the flow, waits for input, or reaches the end. */
  hasExit: Set<string>;
  /** Jump and menu edges between blocks. */
  blockEdges: Map<string, Set<string>>;
  reachable: Set<string>;
}

export function analyze(flow: Flow): Analysis {
  const analysis: Analysis = {
    unreachable: [],
    implicitEnds: [],
    hasExit: new Set(),
    blockEdges: new Map(),
    reachable: new Set(),
  };

  for (const block of flow.blocks) {
    const edges = new Set<string>();
    analysis.blockEdges.set(block.id, edges);

    if (block.kind === 'menu') {
      analysis.hasExit.add(block.id); // a menu waits for caller input
      for (const c of block.choices) if (c.targetBlockId) edges.add(c.targetBlockId);
      continue;
    }

    const walker = new PathWalker(edges, analysis);
    const terminates = walker.walk(block.actions);
    if (walker.exits) analysis.hasExit.add(block.id);
    if (!terminates) {
      analysis.hasExit.add(block.id);
      const last = block.actions[block.actions.length - 1];
      analysis.implicitEnds.push({ blockId: block.id, action: last, via: last ? describeFallthrough(last) : undefined });
    }
  }

  if (flow.startBlockId) {
    const queue = [flow.startBlockId];
    while (queue.length) {
      const id = queue.shift()!;
      if (analysis.reachable.has(id)) continue;
      analysis.reachable.add(id);
      for (const next of analysis.blockEdges.get(id) ?? []) queue.push(next);
    }
  }
  return analysis;
}

class PathWalker {
  exits = false;

  constructor(
    private readonly edges: Set<string>,
    private readonly analysis: Analysis,
  ) {}

  /** Returns true when every path through the list ends before falling off its end. */
  walk(actions: FlowAction[]): boolean {
    for (let i = 0; i < actions.length; i++) {
      if (this.terminates(actions[i]!)) {
        if (i < actions.length - 1) this.analysis.unreachable.push(actions[i + 1]!);
        return true;
      }
    }
    return false;
  }

  private terminates(action: FlowAction): boolean {
    if (isWaiting(action)) this.exits = true;
    const results = action.branches.map((b) => this.walk(b.actions));
    const allBranches = results.length > 0 && results.every(Boolean);

    switch (roleOf(action)) {
      case 'end':
        this.exits = true;
        return true;
      case 'jump':
        if (action.targetBlockId) this.edges.add(action.targetBlockId);
        return true;
      case 'loopControl':
        return true;
      case 'transfer':
        // A successful transfer ends the flow. On failure execution continues with the failure output.
        this.exits = true;
        return allBranches && action.branches.some((b) => b.label === 'failure');
      case 'loop':
        return false;
      case 'step': {
        if (!allBranches) return false;
        const required = requiredOutputs(action);
        if (required) return required.every((label) => action.branches.some((b) => b.label === label));
        if (action.type === 'switch') return action.branches.some((b) => b.label === 'default');
        return true;
      }
    }
  }
}

/** Explain which path out of the last action of a task reaches the end of the task. */
function describeFallthrough(action: FlowAction): string {
  const name = action.name ? `'${action.name}'` : action.type;
  const role = roleOf(action);
  if (role === 'transfer') return `if the transfer ${name} fails`;
  if (role === 'loop') return `after the loop ${name} finishes`;
  if (action.branches.length === 0) return `after ${name}`;

  const required = requiredOutputs(action) ?? (action.type === 'switch' ? ['default'] : []);
  const missing = required.filter((label) => !action.branches.some((b) => b.label === label));
  if (missing.length) return `through the ${missing.map((m) => `'${m}'`).join(', ')} output of ${name}`;

  for (const branch of action.branches) {
    const last = branch.actions[branch.actions.length - 1];
    if (!last) return `through the empty '${branch.label}' output of ${name}`;
    if (!branchTerminates(branch.actions)) return `through the '${branch.label}' output of ${name}, ${describeFallthrough(last)}`;
  }
  return `after ${name}`;
}

/** Side-effect free version of PathWalker.walk, used for descriptions. */
function branchTerminates(actions: FlowAction[]): boolean {
  const scratch: Analysis = { unreachable: [], implicitEnds: [], hasExit: new Set(), blockEdges: new Map(), reachable: new Set() };
  return new PathWalker(new Set(), scratch).walk(actions);
}

/** Visit every action in a block, including branch contents. */
export function* allActions(actions: FlowAction[]): Generator<FlowAction> {
  for (const a of actions) {
    yield a;
    for (const b of a.branches) yield* allActions(b.actions);
  }
}

/** Strongly connected components of the block graph (Tarjan). */
export function stronglyConnected(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const out: string[][] = [];

  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      out.push(comp.reverse());
    }
  };

  for (const n of nodes) if (!idx.has(n)) strong(n);
  return out;
}
