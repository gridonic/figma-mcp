# ADR 0001: Source-Node Cache Contract

## Status

Accepted

## Context

Module generation needs reliable Figma data for the configured module root and for child nodes that matter during implementation. Requiring users to encode every nested node id in `.cursor/mcp/figma-links.yaml` makes configuration fragile and couples users to Figma URL details.

The cache also needs to stay small enough for normal project use. Eagerly fetching every descendant node can be slow and can produce large cache directories for complex Figma frames.

## Decision

Use a source-node cache contract:

- `@` marks a managed source node in `.cursor/mcp/figma-links.yaml`.
- A source node is the configured module root.
- A child node is any descendant inside the source-node subtree.
- `cache warm` fetches source-node artifacts and builds a module manifest with discovered child-node metadata.
- Detailed child-node artifacts are fetched lazily through the cache API when an agent needs them.
- Variable definitions are shared per Figma file/styleguide and referenced by module manifests.
- Existing explicit nested node ids in URLs remain optional discovery hints, not readiness requirements.
- Partial manifests are allowed only when marked incomplete with warnings and raw payload paths.

## Consequences

Users configure only module source nodes, not child nodes.

Agents get a stable local entry point for source-node and child-node information through cache inspection. When a needed child-node artifact is missing, the workflow can fetch it through the cache instead of bypassing local cache behavior.

Cache warmup remains bounded because it fetches source-node artifacts and child metadata rather than every descendant detail artifact.

Manifest completeness depends on the structure exposed by the Figma MCP payload. When discovery is incomplete, the workflow must preserve raw payload paths and warn agents not to treat missing child nodes as proof of absence.
