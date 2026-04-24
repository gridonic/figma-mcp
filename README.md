# figma-mcp

`figma-mcp` packages a reusable **Figma MCP to Astro workflow** so you can install it in any project.

It provides:

- Cursor rules for module generation and design implementation
- Scripts for cache management and design token sync (colors and typography)
- A CLI (`figma-mcp`) with setup, cache, and token sync commands
- Templates and scripts for deterministic Figma data workflows

## What this package includes

- `.cursor/rules/`
  - `figma-mcp-create-modules.mdc`
  - `figma-mcp-generic.mdc`
  - `figma-mcp-import-colors.mdc`
  - `figma-mcp-import-styleguide.mdc`
  - `figma-design-module.mdc`
- `scripts/`
  - `figma-mcp.js` (CLI entry point)
  - `figma-cache.ts` (cache management)
  - `sync-design-tokens.ts` (SCSS token sync)
  - `modules-setup.ts` (orchestrated setup)
- `templates/figma-links.yaml`

## Install

```bash
npm install figma-mcp@github:gridonic/figma-mcp
```

## Quick start

1. Initialize workflow files in your project:

```bash
npx figma-mcp init
```

1. Fill in Figma URLs in:

```text
.cursor/mcp/figma-links.yaml
```

1. Warm cache from configured nodes:

```bash
npx figma-mcp cache warm --refresh
```

1. Sync design tokens to SCSS:

```bash
npx figma-mcp tokens:sync --refresh
```

1. Run module setup flow:

```bash
npx figma-mcp modules:setup
```

## CLI commands

```text
npx figma-mcp init
npx figma-mcp upgrade
npx figma-mcp cache list
npx figma-mcp cache clear
npx figma-mcp cache warm [--config <path>] [--tool <tool>] [--node <nodeId>] [--refresh]
npx figma-mcp cache refresh [--config <path>] [--tool <tool>] [--node <nodeId>]
npx figma-mcp cache get --url <figma-url> --node <nodeId> [--tool <tool>] [--refresh]
npx figma-mcp tokens:sync [-y|--yes] [--debug] [--refresh]
npx figma-mcp modules:setup
npx figma-mcp info
npx figma-mcp help
```

### `init`

`init`:

- Copies package cursor rules into `.cursor/rules/`
- Creates `.cursor/mcp/figma-links.yaml` from template (if missing)
- Adds npm scripts to the target project's `package.json` (without overwriting existing keys)

### `upgrade`

`upgrade` re-copies the package rules to pick up updates in an existing project.

### `cache` subcommands

Artifacts are stored under:

```text
.cursor/tmp/figma-mcp-cache/
```

Supported tools for cache actions:

- `get_screenshot`
- `get_variable_defs`
- `get_design_context`
- `get_metadata`
- `get_figjam`

### `tokens:sync`

Syncs color and typography tokens from Figma MCP into:

- `src/sass/root/_colors.scss`
- `src/sass/typography/_font-types.scss`

Expected markers in target files:

```scss
// @figma-tokens:colors:start
// ...
// @figma-tokens:colors:end

// @figma-tokens:font-types:start
// ...
// @figma-tokens:font-types:end
```

If markers are missing, sync fails with guidance.

## NPM scripts injected by `init`

`init` adds these scripts when absent:

```json
{
  "tokens:sync": "npx figma-mcp tokens:sync",
  "figma:cache:list": "npx figma-mcp cache list",
  "figma:cache:clear": "npx figma-mcp cache clear",
  "figma:cache:warm": "npx figma-mcp cache warm",
  "figma:cache:refresh": "npx figma-mcp cache refresh",
  "figma:cache:get": "npx figma-mcp cache get",
  "modules:setup": "npx figma-mcp modules:setup"
}
```

## Requirements

- Node.js with npm
- Figma Desktop app running with MCP server available at:

```text
http://127.0.0.1:3845/mcp
```

- A project configured for the expected SCSS paths, or custom paths when supported by command flags

## Recommended workflow

1. Install package
2. Run `npx figma-mcp init`
3. Add/verify Figma node links in `.cursor/mcp/figma-links.yaml`
4. Run `npx figma-mcp cache warm --refresh`
5. Run `npx figma-mcp tokens:sync --refresh`
6. Run `npx figma-mcp modules:setup`
7. Use Cursor rules to generate/update modules

## Troubleshooting

- `Cache miss ... allowFetchOnMiss false`
  - Seed cache first with `npx figma-mcp cache warm --refresh` or run token sync with `--refresh`.
- `Could not parse node IDs`
  - Validate `figma-links.yaml` URLs include `node-id=...`.
- Token sync marker errors
  - Add required marker blocks in your SCSS files.
- MCP connection failures
  - Confirm Figma Desktop MCP is running on `127.0.0.1:3845`.

## License

ISC
