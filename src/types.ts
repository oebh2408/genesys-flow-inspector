export type Severity = 'error' | 'warning' | 'info';

export interface SourceLocation {
  line: number;
  column: number;
}

/** A branch of an action, such as the `failure` output of a data action. */
export interface Branch {
  label: string;
  actions: FlowAction[];
  loc?: SourceLocation;
}

export interface FlowAction {
  /** Stable id inside the flow, e.g. `task:Billing_12/2/failure/0`. */
  id: string;
  /** Archy action key, e.g. `callData`, `decision`, `transferToAcd`. */
  type: string;
  name?: string;
  blockId: string;
  loc?: SourceLocation;
  branches: Branch[];
  /** Raw target reference for jumps (`targetTaskRef`, `targetMenuRef`, `targetStateRef`). */
  targetRef?: string;
  /** Block id the target reference resolved to, when it resolved. */
  targetBlockId?: string;
  raw: Record<string, unknown>;
}

export interface MenuChoice {
  id: string;
  type: string;
  name?: string;
  dtmf?: string;
  loc?: SourceLocation;
  targetRef?: string;
  targetBlockId?: string;
  /** Choice types that end the interaction, such as `menuDisconnect`. */
  terminal: boolean;
  raw: Record<string, unknown>;
}

export type BlockKind = 'menu' | 'task' | 'state';

export interface FlowBlock {
  id: string;
  kind: BlockKind;
  name: string;
  refId?: string;
  loc?: SourceLocation;
  actions: FlowAction[];
  choices: MenuChoice[];
}

export type ResourceKind =
  | 'queue'
  | 'dataAction'
  | 'prompt'
  | 'flow'
  | 'scheduleGroup'
  | 'schedule'
  | 'user'
  | 'group'
  | 'skill';

export interface ResourceReference {
  kind: ResourceKind;
  name: string;
  loc?: SourceLocation;
  blockId?: string;
  actionId?: string;
}

export interface Flow {
  /** Top-level Archy key: `inboundCall`, `inboundChat`, `inQueueCall`, `workflow`, ... */
  type: string;
  name: string;
  division?: string;
  defaultLanguage?: string;
  startRef?: string;
  startBlockId?: string;
  blocks: FlowBlock[];
  references: ResourceReference[];
  /** Top-level settings that rules may inspect (error handling, action defaults). */
  settings: Record<string, unknown>;
  /** Source positions of the top-level keys of the flow definition. */
  settingLocations: Record<string, SourceLocation>;
  /** References that could not be matched to a block. */
  unresolved: { ref: string; loc?: SourceLocation; blockId: string; sourceId: string }[];
}

export interface Issue {
  rule: string;
  severity: Severity;
  message: string;
  loc?: SourceLocation;
  blockId?: string;
  /** Action or menu choice the issue points at. */
  nodeId?: string;
}

/** Names of resources that exist in the target org, used by the `unknown-resource` rule. */
export type Inventory = Partial<Record<ResourceKind, string[]>>;

export type RuleSetting = Severity | 'off';

export interface InspectOptions {
  inventory?: Inventory;
  rules?: Record<string, RuleSetting>;
}

export interface InspectResult {
  flow: Flow;
  issues: Issue[];
}
