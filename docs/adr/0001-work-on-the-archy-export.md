# 1. Work on the Archy export, not the API

## Context

Flows live in Genesys Cloud. They can be read through the Platform API (the flow configuration JSON) or exported to YAML with Archy. The API format is the internal representation used by the Architect UI and changes without notice. The Archy YAML format is documented, stable across releases, and is what teams keep in version control when they manage flows as code.

## Decision

The tool reads Archy YAML files and never calls the API. Anything that needs org data, such as checking that a queue exists, comes from an inventory file that the user produces.

## Consequences

- It runs offline and in CI without credentials.
- It can lint a flow before it is published, which is the point of linting.
- Users who do not export their flows yet need to add that step.
- Resource checks are only as fresh as the inventory file.
