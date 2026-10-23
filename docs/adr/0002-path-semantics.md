# 2. How paths are followed

## Context

Most of the useful rules (implicit end, unreachable actions, loops) depend on knowing where execution goes after each action. Architect has many action types and adds new ones regularly. Hard-coding every action would make the tool break on the next release.

## Decision

The parser treats every nested `actions` list inside an action as a branch, labelled by the nearest meaningful key (`success`, `failure`, `yes`, `case 2`). Path analysis then uses a small set of facts:

- `disconnect`, `endTask`, `endState` and similar actions end the path.
- Jumps (`jumpToTask`, `jumpToMenu`, `changeState`, or any `target*Ref`) end the path and add an edge between blocks.
- `transferTo*` actions end the path on success and continue on their failure output.
- Any other action continues with the next action, unless all of its outputs end the path. For known actions (decision, data action, bridge, schedule evaluation, switch) an output that is missing counts as a path that continues.
- A `loop` action is assumed to finish and continue.

## Consequences

- Unknown actions parse and render. The worst case is a missed warning, not a crash.
- Output names for new branching actions need to be added to `REQUIRED_OUTPUTS` before missing outputs are detected.
- The analysis does not evaluate expressions, so a decision that is always true is still treated as two paths.
