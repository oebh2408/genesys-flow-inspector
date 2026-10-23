# Changelog

## 0.1.0

- Parser for Archy YAML exports: menus, tasks, states, branches, jumps and resource references, with line numbers.
- Ten rules: `unresolved-reference`, `jump-loop`, `duplicate-dtmf`, `unknown-resource`, `implicit-end`, `unhandled-failure`, `unreachable-action`, `unreachable-block`, `empty-block`, `silent-error-handling`.
- Inventory file for resource checks, accepting plain names or Platform API list responses.
- Config file to change rule severities.
- CLI with `lint`, `view` and `rules`; output as text, JSON, GitHub annotations or SARIF.
- Self-contained HTML viewer with pan, zoom, node details and issue navigation.
