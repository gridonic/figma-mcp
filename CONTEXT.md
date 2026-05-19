# figma-mcp Context

`figma-mcp` packages a reusable workflow for turning Figma MCP data into Astro module implementation work. The package favors deterministic local cache artifacts so agents can inspect design data without repeatedly querying Figma.

## Glossary

### Managed Source Node

A configured Figma URL prefixed with `@` in `.cursor/mcp/figma.config.yaml`.

Managed source nodes are included in cache warmup, module manifests, and module generation workflows. Unprefixed URLs are reference links unless a command explicitly targets them.

### Source Node

The Figma node configured for a module. It is the root of the module design from the workflow's point of view.

Users configure source nodes. They do not need to configure child nodes manually.

### Child Node

Any descendant within a source node subtree, at any depth.

Child nodes are discovered from source-node Figma data. Existing URLs that contain extra nested node ids may seed discovery, but those ids are hints rather than readiness requirements.

### Module Manifest

A cache artifact that describes a module source node and the child nodes discovered below it.

The manifest records discovered child-node metadata, fetched and missing tool status, raw payload paths, completeness warnings, and references to shared artifacts such as variable definitions.

### Partial Manifest

A module manifest whose child-node coverage is known to be incomplete.

Partial manifests must be marked as incomplete with warnings and raw payload paths. Agents may use discovered child nodes, but must not assume an undiscovered child node is absent.

### Shared Variable Artifact

A Figma variable/token artifact cached per Figma file or styleguide source.

Modules reference shared variable artifacts instead of fetching variable definitions for every source node or child node.
