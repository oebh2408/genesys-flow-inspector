import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FlowParseError, inspect, normalizeInventory, parseFlow } from '../src/index.js';

const example = (name: string) => readFileSync(new URL(`../examples/flows/${name}`, import.meta.url), 'utf8');
const inventory = normalizeInventory(JSON.parse(readFileSync(new URL('../examples/inventory.json', import.meta.url), 'utf8')));
const rulesOf = (yaml: string, opts = {}) => inspect(yaml, opts).issues.map((i) => i.rule);

/** Build an inbound call flow from task definitions written as YAML lines. */
function callFlow(tasks: string, extra = ''): string {
  return `inboundCall:
  name: Test
  startUpRef: "/inboundCall/tasks/task[Start_1]"
${extra}  tasks:
${tasks}`;
}

describe('example flows', () => {
  it('finds the documented problems in support-line.yaml', () => {
    const { issues } = inspect(example('support-line.yaml'), { inventory });
    expect(issues.map((i) => [i.rule, i.loc?.line])).toEqual([
      ['silent-error-handling', 13],
      ['duplicate-dtmf', 38],
      ['unresolved-reference', 42],
      ['unhandled-failure', 54],
      ['implicit-end', 83],
      ['unreachable-action', 113],
      ['unreachable-block', 133],
      ['unknown-resource', 140],
    ]);
  });

  it('reports nothing for after-hours.yaml', () => {
    expect(inspect(example('after-hours.yaml'), { inventory }).issues).toEqual([]);
  });
});

describe('parser', () => {
  it('reads blocks, choices, branches and references', () => {
    const flow = parseFlow(example('support-line.yaml'));
    expect(flow.type).toBe('inboundCall');
    expect(flow.name).toBe('Support Line');
    expect(flow.blocks.map((b) => b.id)).toEqual([
      'menu:Main Menu_10',
      'task:Billing_20',
      'task:Order Status_30',
      'task:Order Lookup_35',
      'task:Old Promotions_50',
    ]);
    expect(flow.startBlockId).toBe('menu:Main Menu_10');
    const menu = flow.blocks[0]!;
    expect(menu.choices.map((c) => c.dtmf)).toEqual(['1', '2', '2', '3', '9']);
    const lookup = flow.blocks[1]!.actions[0]!;
    expect(lookup.branches.map((b) => b.label)).toEqual(['success', 'failure', 'timeout']);
    expect(flow.references).toContainEqual(expect.objectContaining({ kind: 'dataAction', name: 'Get Account By Phone' }));
    expect(flow.references).toContainEqual(expect.objectContaining({ kind: 'queue', name: 'Billing' }));
  });

  it('resolves references by refId path, refId or name', () => {
    const flow = parseFlow(
      callFlow(`    - task:
        name: Start
        refId: Start_1
        actions:
          - jumpToTask:
              targetTaskRef: Second
    - task:
        name: Second
        refId: Second_2
        actions:
          - jumpToTask:
              targetTaskRef: Third_3
    - task:
        name: Third
        refId: Third_3
        actions:
          - disconnect:
              name: Bye
`),
    );
    expect(flow.blocks[0]!.actions[0]!.targetBlockId).toBe('task:Second_2');
    expect(flow.blocks[1]!.actions[0]!.targetBlockId).toBe('task:Third_3');
    expect(flow.unresolved).toEqual([]);
  });

  it('labels switch cases and keeps unknown actions', () => {
    const flow = parseFlow(
      callFlow(`    - task:
        name: Start
        refId: Start_1
        actions:
          - someFutureAction:
              name: Future
          - switch:
              name: Pick
              evaluate:
                firstTrue:
                  default:
                    actions:
                      - disconnect:
                          name: A
                  cases:
                    - case:
                        value:
                          exp: true
                        actions:
                          - disconnect:
                              name: B
`),
    );
    const [future, pick] = flow.blocks[0]!.actions;
    expect(future!.type).toBe('someFutureAction');
    expect(pick!.branches.map((b) => b.label)).toEqual(['default', 'case 1']);
  });

  it('throws FlowParseError with a location on invalid YAML', () => {
    try {
      parseFlow('inboundCall:\n  name: [broken\n');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FlowParseError);
      expect((err as FlowParseError).loc?.line).toBeGreaterThan(0);
    }
  });

  it('rejects documents without a flow definition', () => {
    expect(() => parseFlow('- just a list')).toThrow(FlowParseError);
  });
});

describe('rules', () => {
  it('implicit-end: flags a task that falls off its end', () => {
    const issues = inspect(
      callFlow(`    - task:
        name: Start
        refId: Start_1
        actions:
          - playAudio:
              name: Hello
`),
    ).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.rule).toBe('implicit-end');
    expect(issues[0]!.message).toContain("after 'Hello'");
  });

  it('implicit-end: explains a missing decision output', () => {
    const issues = inspect(
      callFlow(`    - task:
        name: Start
        refId: Start_1
        actions:
          - decision:
              name: VIP?
              condition:
                exp: true
              outputs:
                yes:
                  actions:
                    - disconnect:
                        name: Bye
`),
    ).issues;
    expect(issues.map((i) => i.rule)).toEqual(['implicit-end']);
    expect(issues[0]!.message).toContain("'no' output of 'VIP?'");
  });

  it('implicit-end: does not apply to workflows', () => {
    const yaml = `workflow:
  name: Wf
  startUpRef: "/workflow/states/state[Initial_1]"
  states:
    - state:
        name: Initial
        refId: Initial_1
        actions:
          - updateData:
              name: Set
`;
    expect(rulesOf(yaml)).toEqual([]);
  });

  it('jump-loop: flags tasks that only jump to each other', () => {
    const issues = inspect(
      callFlow(`    - task:
        name: Start
        refId: Start_1
        actions:
          - jumpToTask:
              targetTaskRef: Ping
    - task:
        name: Ping
        refId: Ping_2
        actions:
          - updateData:
              name: Count
          - jumpToTask:
              targetTaskRef: Pong
    - task:
        name: Pong
        refId: Pong_3
        actions:
          - jumpToTask:
              targetTaskRef: Ping
`),
    ).issues;
    expect(issues.map((i) => i.rule)).toEqual(['jump-loop']);
    expect(issues[0]!.message).toContain("'Ping' -> 'Pong'");
  });

  it('jump-loop: a loop with a way out is fine', () => {
    const yaml = callFlow(`    - task:
        name: Start
        refId: Start_1
        actions:
          - decision:
              name: Retry?
              condition:
                exp: Flow.tries < 3
              outputs:
                yes:
                  actions:
                    - jumpToTask:
                        targetTaskRef: Start
                no:
                  actions:
                    - disconnect:
                        name: Give up
`);
    expect(rulesOf(yaml)).toEqual([]);
  });

  it('jump-loop: ignored for in-queue flows, which loop by design', () => {
    const yaml = `inQueueCall:
  name: Hold
  startUpRef: "/inQueueCall/tasks/task[Loop_1]"
  tasks:
    - task:
        name: Loop
        refId: Loop_1
        actions:
          - jumpToTask:
              targetTaskRef: Loop
`;
    expect(rulesOf(yaml)).toEqual([]);
  });

  it('unreachable-action: inside a branch', () => {
    const issues = inspect(
      callFlow(`    - task:
        name: Start
        refId: Start_1
        actions:
          - decision:
              name: Check
              condition:
                exp: true
              outputs:
                yes:
                  actions:
                    - disconnect:
                        name: Bye
                    - playAudio:
                        name: Never
          - disconnect:
              name: End
`),
    ).issues;
    expect(issues.map((i) => [i.rule, i.message])).toEqual([['unreachable-action', "'Never' never runs: every path before it ends earlier."]]);
  });

  it('unhandled-failure: flags a missing timeout output', () => {
    const issues = inspect(
      callFlow(`    - task:
        name: Start
        refId: Start_1
        actions:
          - callData:
              name: Lookup
              outputs:
                success:
                  actions:
                failure:
                  actions:
                    - updateData:
                        name: Note
          - disconnect:
              name: Bye
`),
    ).issues;
    expect(issues.map((i) => i.rule)).toEqual(['unhandled-failure']);
    expect(issues[0]!.message).toContain('does nothing on timeout');
  });

  it('empty-block: menu without choices and task without actions', () => {
    const yaml = `inboundCall:
  name: Empty
  startUpRef: "/inboundCall/menus/menu[M_1]"
  menus:
    - menu:
        name: M
        refId: M_1
        choices: []
  tasks:
    - task:
        name: T
        refId: T_1
        actions: []
`;
    const rules = rulesOf(yaml, { rules: { 'unreachable-block': 'off' } });
    expect(rules.sort()).toEqual(['empty-block', 'empty-block', 'implicit-end']);
  });

  it('unknown-resource: only with an inventory, case-insensitive', () => {
    const yaml = callFlow(`    - task:
        name: Start
        refId: Start_1
        actions:
          - transferToAcd:
              name: Go
              targetQueue:
                lit:
                  name: sales
              outputs:
                failure:
                  actions:
                    - disconnect:
                        name: Bye
          - transferToAcd:
              name: Dynamic
              targetQueue:
                exp: Flow.queue
              outputs:
                failure:
                  actions:
                    - disconnect:
                        name: Bye
`);
    expect(rulesOf(yaml)).toEqual(['unreachable-action']);
    expect(rulesOf(yaml, { inventory: { queue: ['Sales'] } })).toEqual(['unreachable-action']);
    expect(rulesOf(yaml, { inventory: { queue: ['Support'] } })).toEqual(['unknown-resource', 'unreachable-action']);
  });

  it('unresolved-reference: bad start reference', () => {
    const yaml = `inboundCall:
  name: Bad
  startUpRef: "/inboundCall/tasks/task[Missing_9]"
  tasks:
    - task:
        name: T
        refId: T_1
        actions:
          - disconnect:
              name: Bye
`;
    expect(rulesOf(yaml)).toEqual(['unresolved-reference']);
  });

  it('rule settings change severity or turn rules off', () => {
    const yaml = example('support-line.yaml');
    const result = inspect(yaml, { rules: { 'duplicate-dtmf': 'warning', 'silent-error-handling': 'off' } });
    expect(result.issues.find((i) => i.rule === 'duplicate-dtmf')?.severity).toBe('warning');
    expect(result.issues.some((i) => i.rule === 'silent-error-handling')).toBe(false);
  });
});

describe('inventory', () => {
  it('accepts plural keys and API-style objects', () => {
    expect(normalizeInventory({ queues: [{ name: 'A', id: '1' }, 'B'], prompt: ['P'], other: ['x'] })).toEqual({ queue: ['A', 'B'], prompt: ['P'] });
    expect(normalizeInventory({ queues: { entities: [{ name: 'Q' }], pageSize: 25 } })).toEqual({ queue: ['Q'] });
  });
});
