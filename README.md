# figma-mcp

`figma-mcp` packages a reusable **Figma MCP to Astro workflow** so you can install it in any project.

- **Cursor rules** — module generation and design implementation (`.cursor/rules/`)
- **CLI** — cache management, token sync, and setup (`npx figma-mcp`)
- **Scripts** — `figma-cache.ts`, `sync-design-tokens.ts`, `modules-setup.ts`
- **Config template** — `templates/figma.config.yaml`

## Quick start

```bash
npm install figma-mcp@github:gridonic/figma-mcp
npx figma-mcp init
```

In `.cursor/mcp/figma.config.yaml`:

1. Set your source (bridge is recommended — bypasses rate limits):

```yaml
# Bridge — bypasses rate limits; one-time plugin setup required
source: bridge

# Desktop — requires Figma Desktop running with MCP enabled
source: desktop
```

2. Fill in your Figma URLs (`styleguide.*` and `modules.*` entries).

3. If using bridge, complete the one-time plugin setup: [docs/bridge-setup.md](docs/bridge-setup.md).

4. Warm cache:

```bash
npx figma-mcp cache warm --refresh
```

## Workflow

Prepare cache, tokens, and scaffolding before running the generation agent:

```bash
npm run figma-mcp -- cache warm --refresh
npm run figma-mcp -- tokens sync --refresh
npm run figma-mcp -- modules setup
```

Then invoke the module-generation rule in Cursor for one module or all managed modules.

To fetch a missing child-node artifact:

```bash
npm run figma-mcp -- cache get --url "<figma-url>" --node <child-node-id> --tool get_design_context
```

> **Note:** `tokens sync` requires marker blocks in `src/sass/root/_colors.scss` and `src/sass/typography/_font-types.scss`:
>
> ```scss
> // @figma-tokens:colors:start
> // @figma-tokens:colors:end
>
> // @figma-tokens:font-types:start
> // @figma-tokens:font-types:end
> ```

## CLI commands

```text
npx figma-mcp init
npx figma-mcp upgrade [--rules-only]
npx figma-mcp bridge setup [--refresh]
npx figma-mcp bridge status
npx figma-mcp cache warm [--refresh]
npx figma-mcp cache inspect [module] [--json]
npx figma-mcp cache get --url <url> --node <nodeId> [--tool <tool>]
npx figma-mcp cache list|clear
npx figma-mcp tokens sync [--refresh]
npx figma-mcp modules setup
npx figma-mcp info|help
```

## License

ISC
