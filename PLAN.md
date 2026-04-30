# figma-mcp — Implementation Plan

A standalone npm package that installs the Figma MCP → Astro components workflow into any project.
Follows the same packaging and distribution pattern as [dastro](https://github.com/gridonic/dastro).

---

## What this package provides

### 1. Cursor rules (`.cursor/rules/`)

Agent workflow rules that Claude uses inside the consuming project. Prefixed `figma-mcp-` for namespacing.

| File | Purpose |
|---|---|
| `figma-mcp-create-modules.mdc` | Main rule — reads `figma-links.yaml`, spawns one subagent per module in parallel, runs 6-step implement → validate loop |
| `figma-mcp-generic.mdc` | Baseline rules for grid alignment, typography mapping, color usage (referenced by other rules via `@figma-mcp-generic.mdc`) |
| `figma-mcp-import-colors.mdc` | Pull color tokens from Figma MCP → `_colors.scss` |
| `figma-mcp-import-styleguide.mdc` | Pull typography tokens from Figma MCP → `_font-types.scss` |
| `figma-design-module.mdc` | Single-module design pattern (static markup + optional interactivity) |

### 2. TypeScript scripts (`scripts/`)

Deterministic tooling that runs independently of Claude.

| File | Purpose |
|---|---|
| `figma-cache.ts` | Manage the persistent local MCP response cache (list, clear, warm, refresh, get) |
| `sync-design-tokens.ts` | Fetch color + typography variables from Figma MCP, transform and write to SCSS files |
| `modules-setup.ts` | Orchestrator — runs tokens sync → cache warm → scaffold missing `.astro` files → create-modules |

### 3. CLI entry point (`scripts/figma-mcp.js`)

Node.js CLI script (like `dastro.js`) exposed via `bin` in `package.json`.

### 4. Config template (`templates/`)

| File | Purpose |
|---|---|
| `figma-links.yaml` | Template config mapping modules and styleguide sections to their Figma node URLs |

---

## CLI commands

| Command | What it does |
|---|---|
| `figma-mcp init` | Copies cursor rules to `.cursor/rules/`, creates `.cursor/mcp/figma-links.yaml` from template, adds a single npm wrapper script to `package.json` |
| `figma-mcp upgrade` | Re-copies cursor rules from `node_modules/figma-mcp/.cursor/rules/` (picks up rule updates) |
| `figma-mcp cache list` | List all cached Figma MCP artifacts |
| `figma-mcp cache clear` | Delete entire cache |
| `figma-mcp cache warm` | Pre-populate cache from `figma-links.yaml` |
| `figma-mcp cache refresh` | Force-refresh cache from MCP |
| `figma-mcp cache get` | Fetch and cache a single artifact by URL + node ID |
| `figma-mcp tokens:sync` | Run `sync-design-tokens.ts` |
| `figma-mcp modules:setup` | Run `modules-setup.ts` |
| `figma-mcp info` | Show installed version and links |
| `figma-mcp help` | Show usage |

---

## npm script added to consuming project on `init`

```json
{
  "figma-mcp": "npx figma-mcp"
}
```

> Note: scripts are wrappers around the CLI — the actual logic lives in the package, not copied into the project.

---

## Package structure

```
figma-mcp/
├── package.json
├── PLAN.md
├── CHANGELOG.md
├── scripts/
│   ├── figma-mcp.js            ← CLI entry point
│   ├── figma-cache.ts
│   ├── sync-design-tokens.ts
│   └── modules-setup.ts
├── .cursor/
│   └── rules/
│       ├── figma-mcp-create-modules.mdc
│       ├── figma-mcp-generic.mdc
│       ├── figma-mcp-import-colors.mdc
│       ├── figma-mcp-import-styleguide.mdc
│       └── figma-design-module.mdc
└── templates/
    └── figma-links.yaml
```

`package.json` `files` field includes `.cursor`, `scripts`, and `templates` so all of these are published with the package.

---

## How it gets installed in a new project

```bash
# Install from GitHub (same pattern as dastro)
npm install figma-mcp@github:gridonic/figma-mcp

# Scaffold the workflow into the project
npx figma-mcp init
```

`init` does:
1. Copy all `figma-mcp-*.mdc` and `figma-design-module.mdc` rules from `node_modules/figma-mcp/.cursor/rules/` → `.cursor/rules/`
2. Create `.cursor/mcp/figma-links.yaml` from `templates/figma-links.yaml` (skip if already exists)
3. Inject one npm wrapper script into project `package.json` (skip if it already exists)

---

## How rules are updated in an existing project

```bash
npm install figma-mcp@github:gridonic/figma-mcp  # get latest
npx figma-mcp upgrade                             # re-copy rules
```

`upgrade` only touches `.cursor/rules/figma-mcp-*.mdc` and `figma-design-module.mdc` — never overwrites `figma-links.yaml` or any project-specific files.

---

## Skill in the skills repo

A `figma-mcp/SKILL.md` skill is added to the [skills repo](https://github.com/gridonic/skills) following the same shape as `dastro-cli/SKILL.md`. It triggers when Claude needs to:

- Run cache warming or token sync commands
- Explain how to install or upgrade the workflow
- Invoke `figma-mcp init` in a new project

---

## Naming decisions

- All distributed cursor rules are prefixed `figma-mcp-` to avoid collisions in the consuming project's `.cursor/rules/` folder
- Cross-references inside rules use the prefixed name (e.g. `@figma-mcp-generic.mdc` instead of `@mcp-generic.mdc`)
- The exception is `figma-design-module.mdc` which has no prefix dependency conflict

---

## Source migration from Boilerplate-MR3-Experimente

The following files are extracted from the boilerplate and moved into this package:

| Source (boilerplate) | Destination (package) |
|---|---|
| `.cursor/rules/mcp-create-modules.mdc` | `.cursor/rules/figma-mcp-create-modules.mdc` + update `@` references |
| `.cursor/rules/mcp-generic.mdc` | `.cursor/rules/figma-mcp-generic.mdc` |
| `.cursor/rules/mcp-import-colors.mdc` | `.cursor/rules/figma-mcp-import-colors.mdc` |
| `.cursor/rules/mcp-import-styleguide.mdc` | `.cursor/rules/figma-mcp-import-styleguide.mdc` |
| `.cursor/rules/design-module.mdc` | `.cursor/rules/figma-design-module.mdc` |
| `scripts/figma-cache.ts` | `scripts/figma-cache.ts` |
| `scripts/sync-design-tokens.ts` | `scripts/sync-design-tokens.ts` |
| `scripts/modules-setup.ts` | `scripts/modules-setup.ts` |
| `.cursor/mcp/figma-links.yaml` | `templates/figma-links.yaml` (as template, not live config) |

The boilerplate keeps its own `figma-links.yaml` with real project URLs. After migration, it installs this package and its rules/scripts are driven through the CLI instead of being local copies.
