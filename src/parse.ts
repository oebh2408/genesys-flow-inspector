import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import type {
  BlockKind,
  Flow,
  FlowAction,
  FlowBlock,
  MenuChoice,
  ResourceKind,
  ResourceReference,
  SourceLocation,
} from './types.js';

export class FlowParseError extends Error {
  constructor(
    message: string,
    readonly loc?: SourceLocation,
  ) {
    super(message);
    this.name = 'FlowParseError';
  }
}

type Obj = Record<string, unknown>;

/** Positions recorded while converting the YAML AST to plain values. */
interface Positions {
  node: WeakMap<object, SourceLocation>;
  keys: WeakMap<object, Record<string, SourceLocation>>;
}

const BLOCK_SECTIONS: { section: string; item: string; kind: BlockKind }[] = [
  { section: 'menus', item: 'menu', kind: 'menu' },
  { section: 'tasks', item: 'task', kind: 'task' },
  { section: 'reusableTasks', item: 'task', kind: 'task' },
  { section: 'states', item: 'state', kind: 'state' },
];

const REFERENCE_KEYS: Record<string, ResourceKind> = {
  queue: 'queue',
  queues: 'queue',
  targetQueue: 'queue',
  dataAction: 'dataAction',
  targetFlow: 'flow',
  flow: 'flow',
  scheduleGroup: 'scheduleGroup',
  schedule: 'schedule',
  user: 'user',
  group: 'group',
  skill: 'skill',
  skills: 'skill',
};

const PROMPT_PATTERN = /\bPrompt\.([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Parse a flow exported with Archy (`archy export --outputFormat yaml`) or written by hand
 * in the same format. Unknown action types are kept; their branches are discovered from any
 * nested `actions` lists, so new Architect actions do not break parsing.
 */
export function parseFlow(text: string): Flow {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: false });
  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    const pos = err.linePos?.[0];
    throw new FlowParseError(err.message.split('\n')[0]!, pos ? { line: pos.line, column: pos.col } : undefined);
  }

  const positions: Positions = { node: new WeakMap(), keys: new WeakMap() };
  const root = toPlain(doc.contents as Node | null, lineCounter, positions);
  if (!isObj(root)) throw new FlowParseError('Expected a YAML mapping with the flow type as its top-level key.');

  const type = Object.keys(root).find((k) => isObj(root[k]));
  if (!type) throw new FlowParseError('Expected a top-level key such as `inboundCall` holding the flow definition.');
  const def = root[type] as Obj;

  return new FlowBuilder(type, def, positions).build();
}

class FlowBuilder {
  private readonly blocks: FlowBlock[] = [];
  private readonly references: ResourceReference[] = [];
  private readonly usedIds = new Set<string>();

  constructor(
    private readonly type: string,
    private readonly def: Obj,
    private readonly pos: Positions,
  ) {}

  build(): Flow {
    for (const { section, item, kind } of BLOCK_SECTIONS) {
      const list = this.def[section];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!isObj(entry)) continue;
        const body = entry[item];
        if (isObj(body)) this.addBlock(kind, body, this.pos.node.get(entry));
      }
    }

    const flow: Flow = {
      type: this.type,
      name: str(this.def.name) ?? '(unnamed flow)',
      division: str(this.def.division),
      defaultLanguage: str(this.def.defaultLanguage),
      startRef: str(this.def.startUpRef) ?? str(this.def.initialState) ?? str(this.def.startUpTaskRef),
      blocks: this.blocks,
      references: this.references,
      settings: pick(this.def, ['settingsErrorHandling', 'settingsActionDefaults', 'settingsMenu', 'initialGreeting']),
      settingLocations: this.pos.keys.get(this.def) ?? {},
      unresolved: [],
    };

    // Prompts and resources referenced outside blocks, e.g. the initial greeting.
    for (const key of ['initialGreeting', 'settingsErrorHandling', 'settingsMenu']) {
      if (this.def[key] !== undefined) this.collectReferences(this.def[key], this.def, key, undefined, undefined);
    }

    resolveTargets(flow);
    return flow;
  }

  private addBlock(kind: BlockKind, body: Obj, loc: SourceLocation | undefined): FlowBlock {
    const name = str(body.name) ?? `(unnamed ${kind})`;
    const refId = str(body.refId);
    const block: FlowBlock = {
      id: this.uniqueId(`${kind}:${refId ?? name}`),
      kind,
      name,
      refId,
      loc: loc ?? this.pos.node.get(body),
      actions: [],
      choices: [],
    };
    this.blocks.push(block);

    if (kind === 'menu') {
      const choices = Array.isArray(body.choices) ? body.choices : [];
      choices.forEach((entry, i) => {
        const choice = this.parseChoice(entry, block, i);
        if (choice) block.choices.push(choice);
      });
      for (const key of ['audio', 'settingsMenu']) {
        if (body[key] !== undefined) this.collectReferences(body[key], body, key, block.id, undefined);
      }
    } else {
      block.actions = this.parseActions(body.actions, block.id, block.id);
    }
    return block;
  }

  private parseChoice(entry: unknown, menu: FlowBlock, index: number): MenuChoice | undefined {
    if (!isObj(entry)) return undefined;
    const type = Object.keys(entry)[0];
    if (!type) return undefined;
    const value = isObj(entry[type]) ? (entry[type] as Obj) : {};
    const choice: MenuChoice = {
      id: `${menu.id}/choice/${index}`,
      type,
      name: str(value.name),
      dtmf: normalizeDtmf(value.dtmf),
      loc: this.pos.node.get(entry),
      targetRef: findTargetRef(value),
      terminal: !/Jump|Task|SubMenu/i.test(type),
      raw: value,
    };

    // `menuTask` style choices define their task inline.
    const inline = value.task;
    if (isObj(inline)) {
      const block = this.addBlock('task', inline, this.pos.node.get(inline));
      choice.targetBlockId = block.id;
      choice.terminal = false;
    }

    for (const [key, v] of Object.entries(value)) {
      if (key === 'task') continue;
      this.collectReferences(v, value, key, menu.id, choice.id);
    }
    return choice;
  }

  private parseActions(list: unknown, blockId: string, prefix: string): FlowAction[] {
    if (!Array.isArray(list)) return [];
    const actions: FlowAction[] = [];
    list.forEach((entry, i) => {
      if (!isObj(entry)) return;
      const type = Object.keys(entry)[0];
      if (!type) return;
      const value = isObj(entry[type]) ? (entry[type] as Obj) : {};
      const id = `${prefix}/${i}`;
      const action: FlowAction = {
        id,
        type,
        name: str(value.name),
        blockId,
        loc: this.pos.node.get(entry),
        branches: [],
        targetRef: findTargetRef(value),
        raw: value,
      };
      for (const found of findBranches(value, [])) {
        action.branches.push({
          label: found.label,
          actions: this.parseActions(found.actions, blockId, `${id}/${found.label}`),
          loc: found.actions.length ? this.pos.node.get(found.actions) : undefined,
        });
      }
      this.collectReferences(value, entry, type, blockId, id, true);
      actions.push(action);
    });
    return actions;
  }

  /** Walk a value and record resource references. Branch action lists are skipped; they are visited on their own. */
  private collectReferences(
    value: unknown,
    parent: Obj,
    key: string,
    blockId: string | undefined,
    actionId: string | undefined,
    isActionRoot = false,
  ): void {
    const loc = this.pos.keys.get(parent)?.[key] ?? this.pos.node.get(parent);

    if (typeof value === 'string') {
      for (const m of value.matchAll(PROMPT_PATTERN)) {
        this.references.push({ kind: 'prompt', name: m[1]!, loc, blockId, actionId });
      }
      return;
    }

    const kind = isActionRoot ? undefined : REFERENCE_KEYS[key];
    if (kind) {
      for (const name of literalNames(value, kind)) this.references.push({ kind, name, loc, blockId, actionId });
    }

    if (Array.isArray(value)) {
      value.forEach((v, i) => this.collectReferences(v, value as unknown as Obj, String(i), blockId, actionId));
    } else if (isObj(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (k === 'actions' && Array.isArray(v)) continue;
        this.collectReferences(v, value, k, blockId, actionId);
      }
    }
  }

  private uniqueId(base: string): string {
    let id = base;
    for (let n = 2; this.usedIds.has(id); n++) id = `${base}#${n}`;
    this.usedIds.add(id);
    return id;
  }
}

/** Find nested `actions` lists inside an action and give each a readable label. */
function findBranches(value: unknown, path: string[]): { label: string; actions: unknown[] }[] {
  const found: { label: string; actions: unknown[] }[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...findBranches(v, [...path, String(i)])));
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      // `actions:` with nothing under it is an empty output.
      if (k === 'actions' && (Array.isArray(v) || v === null)) found.push({ label: branchLabel(path), actions: v ?? [] });
      else found.push(...findBranches(v, [...path, k]));
    }
  }
  return found;
}

const LABEL_NOISE = new Set(['outputs', 'case', 'evaluate', 'firstTrue', 'firstMatch', 'cases']);

function branchLabel(path: string[]): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const seg = path[i]!;
    if (/^\d+$/.test(seg)) return `case ${Number(seg) + 1}`;
    if (!LABEL_NOISE.has(seg)) return seg;
  }
  return 'actions';
}

function findTargetRef(value: Obj): string | undefined {
  for (const [k, v] of Object.entries(value)) {
    if (/^target\w*Ref$/.test(k) && typeof v === 'string') return v;
  }
  return undefined;
}

/** Resolve jump targets and menu choice targets to block ids. */
function resolveTargets(flow: Flow): void {
  const find = (ref: string): FlowBlock | undefined => {
    const inner = /\[([^\]]+)\]\s*$/.exec(ref)?.[1];
    const candidates = [inner, ref].filter((c): c is string => !!c);
    for (const c of candidates) {
      const hit = flow.blocks.find((b) => b.refId === c) ?? flow.blocks.find((b) => b.name === c);
      if (hit) return hit;
    }
    return undefined;
  };

  if (flow.startRef) flow.startBlockId = find(flow.startRef)?.id;
  if (!flow.startBlockId) {
    const first = flow.blocks.find((b) => b.kind === 'menu') ?? flow.blocks[0];
    if (!flow.startRef) flow.startBlockId = first?.id;
  }

  const visit = (actions: FlowAction[]) => {
    for (const a of actions) {
      if (a.targetRef) {
        a.targetBlockId = find(a.targetRef)?.id;
        if (!a.targetBlockId) flow.unresolved.push({ ref: a.targetRef, loc: a.loc, blockId: a.blockId, sourceId: a.id });
      }
      for (const b of a.branches) visit(b.actions);
    }
  };
  for (const block of flow.blocks) {
    visit(block.actions);
    for (const c of block.choices) {
      if (c.targetRef && !c.targetBlockId) {
        c.targetBlockId = find(c.targetRef)?.id;
        if (!c.targetBlockId) flow.unresolved.push({ ref: c.targetRef, loc: c.loc, blockId: block.id, sourceId: c.id });
      }
    }
  }
}

/** Literal resource names in a value. Expressions (`exp:`) cannot be checked statically and are skipped. */
function literalNames(value: unknown, kind: ResourceKind): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((v) => literalNames(v, kind));
  if (!isObj(value)) return [];
  if ('exp' in value || 'noValue' in value) return [];
  if ('lit' in value) return literalNames(value.lit, kind);
  if (typeof value.name === 'string') return [value.name];
  // `dataAction: { Get Account: { inputs: ... } }`
  if (kind === 'dataAction') {
    const keys = Object.keys(value);
    if (keys.length === 1 && isObj(value[keys[0]!])) return [keys[0]!];
  }
  return [];
}

function normalizeDtmf(v: unknown): string | undefined {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return undefined;
  const m = /^digit_(\w)$/.exec(v);
  if (m) return m[1] === 'star' ? '*' : m[1];
  if (v === 'digit_star') return '*';
  if (v === 'digit_pound') return '#';
  return v;
}

function toPlain(node: Node | null | undefined, lc: LineCounter, pos: Positions): unknown {
  if (!node) return null;
  if (isAlias(node)) return null;
  const at = (offset: number | undefined): SourceLocation | undefined => {
    if (offset === undefined) return undefined;
    const p = lc.linePos(offset);
    return { line: p.line, column: p.col };
  };

  if (isMap(node)) {
    const obj: Obj = {};
    const keys: Record<string, SourceLocation> = {};
    for (const pair of node.items) {
      const keyNode = pair.key as Node | null;
      const key = isScalar(keyNode) ? String(keyNode.value) : String(keyNode);
      obj[key] = toPlain(pair.value as Node | null, lc, pos);
      const keyLoc = at(keyNode?.range?.[0]);
      if (keyLoc) keys[key] = keyLoc;
    }
    const loc = at(node.range?.[0]);
    if (loc) pos.node.set(obj, loc);
    pos.keys.set(obj, keys);
    return obj;
  }
  if (isSeq(node)) {
    const arr = node.items.map((item) => toPlain(item as Node | null, lc, pos));
    const loc = at(node.range?.[0]);
    if (loc) pos.node.set(arr, loc);
    return arr;
  }
  if (isScalar(node)) return node.value;
  return null;
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

function pick(obj: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
