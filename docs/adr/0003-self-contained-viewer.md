# 3. Self-contained HTML viewer with layout computed up front

## Context

The diagram is most useful when it can be shared: attached to a change request, a ticket or a CI artifact. A viewer that needs a server, a build step or network access to a CDN is harder to share and may not open inside a locked-down network.

## Decision

`view` writes a single HTML file. Layout is computed in Node with dagre when the file is generated, and the result is written as inline SVG. The page has a small inline script for pan, zoom, selection and the issue list. Styles follow the system light or dark setting.

## Consequences

- The file opens from disk in any browser, with no requests.
- The page does not re-layout. Large flows produce large but static diagrams.
- Changing the look of the diagram means changing `render.ts`; the graph itself is available from `buildGraph` for anyone who wants a different renderer.
