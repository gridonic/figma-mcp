---
name: figma-create-modules
description: Create one or all Astro modules from Figma designs using the MCP cache. Use when the user says "create module", "implement modules from Figma", "run figma-create-modules", or wants to build/update Astro components from cached Figma designs.
---

# Figma Create Modules

Implement Astro modules from prepared Figma cache data.

Assume the user already ran the manual preparation workflow:

1. `npm run figma-mcp -- cache warm --refresh`
2. `npm run figma-mcp -- tokens:sync --refresh`
3. Optional validation/scaffolding: `npm run figma-mcp -- modules:setup --no-warm-cache --skip-tokens-sync`

Do not warm cache, refresh cache, sync tokens, scaffold files, edit `.scss`, edit `.gql`, edit docs, edit tests, or change package files. Only existing target `.astro` files may be changed. Temporary validation marker edits in `.astro` files are allowed only when removed before final output.

**Do not ask for any confirmation at any point. Do not summarise what you are about to do. Do not ask whether to proceed. Start preflight immediately and only output text when you require user input mid-task or are writing the final summary table.**

## Invocation

The user may invoke this skill in two ways:

- **All modules** — no argument, or argument is `all`: process every module in `figma.config.yaml` that has a valid Figma link (value starts with `@http`).
- **Single module** — argument is a module name (e.g. `content-accordion`): process only that module.

If the argument is ambiguous, resolve it against the module names in `figma.config.yaml` and proceed without asking.

## Preparation

1. Read `.cursor/mcp/figma.config.yaml`.
2. Use `figma-mcp cache inspect <module> --json` as the primary source for all Figma resource paths and readiness.
3. Determine the module list from the invocation mode above:
   - All modules: every entry whose value starts with `@http`.
   - Single module: the one named module (error if not found or has no valid link).
4. Resolve each module's expected `.astro` path.
5. Run/read preflight for each module:

```bash
npm run figma-mcp -- cache inspect <module-name> --json
```

Skip a module before spawning a subagent when any precondition fails:

- Missing target `.astro` file: `module-name | skipped: setup required | missing component file; run npm run figma-mcp -- modules:setup --no-warm-cache --skip-tokens-sync`
- Missing source-node artifact or module manifest: `module-name | skipped: setup required | missing <artifact-or-manifest>; run npm run figma-mcp -- cache warm --refresh`
- Missing concrete child-node detail already known to be required: `module-name | skipped: missing design detail | missing <tool> for node <node-id>; run npm run figma-mcp -- cache get --url <source-url> --node <node-id> --tool <tool>`

Partial manifests do not block preflight. They put the subagent in cautious mode: the subagent may use discovered child nodes and raw payload paths, but must not assume undiscovered child nodes are absent.

## Processing loop

For each preflight-ready module, spawn a dedicated subagent using the Agent tool and have it complete Steps 1–6 independently.

- Launch all module subagents **in parallel** in one tool call batch when possible.
- Browser validation must use isolated headless sessions per module or be serialized by the parent to keep evidence separate.
- Pass to each subagent: module name, resolved `.astro` path, Figma link (strip leading `@`), cache root `.cursor/tmp/figma-mcp-cache/`, `cache inspect <module> --json` output or exact command, validation route, write constraints, and the full rules below (Steps 1–6 + Generic baseline).
- Parent agent waits for all subagents, then compiles their Step 6 status lines into the final summary table.
- Do not do module implementation work in the parent agent.
- All-module runs continue with ready modules after per-module skips. Stop the whole run only for global failures such as unreadable config, missing cache root, or a validation environment failure that prevents validation for every ready module.

---

### Step 1: Resolve component file path

Convert the module name to an `.astro` file path:

| Module name (kebab-case) | File path |
|---|---|
| `content-accordion` | `src/components/content-modules/ContentAccordion.astro` |
| `header-text-media` | `src/components/header-modules/HeaderTextMedia.astro` |
| `teaser-default` | `src/components/content-modules/TeaserDefault.astro` |

Rules:
- First segment (e.g. `content`, `header`) → subfolder `<segment>-modules/`
- `teaser-*` and `cta-*` live in `content-modules/`
- Full kebab name → PascalCase filename

If the file does not exist, skip with:

`module-name | skipped: setup required | missing component file; run npm run figma-mcp -- modules:setup --no-warm-cache --skip-tokens-sync`

---

### Step 2: Inspect the Figma design (inspect-first)

Run or read the handoff result of:

```bash
npm run figma-mcp -- cache inspect <module-name> --json
```

Use the inspect JSON as the stable source for:

1. Source URL and source node id.
2. Source-node screenshot, design context, and shared variable artifact status.
3. Module manifest, discovered child nodes, completeness warnings, and raw payload paths.
4. Artifact paths to read for source-node and child-node design data.
5. Manual recovery commands for missing child-node detail.

Cache behavior:
- Do not call Figma MCP tools directly.
- Do not run `cache warm`, `cache refresh`, `cache get`, `tokens:sync`, or `modules:setup`.
- If source-node artifacts or the module manifest are missing, skip this module with `skipped: setup required` and the exact manual command to run.
- If a specific child-node detail is required for implementation but missing, skip this module with `skipped: missing design detail` and the exact `cache get` command.
- If the manifest is partial, continue cautiously: use discovered child nodes and raw payload paths, but do not assume undiscovered child nodes are absent.
- Generated SCSS token files are the implementation authority for class/variable names. The shared Figma variable artifact is mapping evidence only. Do not edit SCSS or trust Figma token names blindly when generated files differ.

Design-intent extraction:
- Identify key elements (e.g. title, lead, actions, cards, media).
- For each, assign an intended grid lane from the Figma composition using the generic baseline rules below.
- Store as an internal "intent map" — treat it as source of truth for Steps 4 and 5.

---

### Step 3: Read the current component

Read the existing `.astro` file. Compare to the Figma design and identify what needs to change.

---

### Step 4: Implement changes

Apply only the necessary changes to the `.astro` file. Follow the Generic Baseline below as source of truth. Module-specific constraints:
- Replace invalid/unknown grid tokens with valid placements per the Generic Baseline.
- Keep placement aligned to the Step 2 intent map for each key element.
- Do not add, rename, or delete any `.scss` files.

---

### Step 5: Validate in browser

Force a filesystem change event: append `<!-- mcp-refresh -->` to the `.astro` file, then immediately remove it in a second write.

Validation uses `chrome-devtools-mcp` in headless mode only. Do not use any shared interactive browser window.

Open the module testing route in headless Chrome DevTools MCP. Each component has a testing subpage with the same name: `ContentAccordion` → `/testing/contentaccordion`. Use https. If changes are not visible, hard refresh once and reopen.

Browser validation is mandatory when the dev server and testing route are available. If validation cannot run because the route/server is unavailable, do not report the module as implemented. Use `skipped: validation unavailable` with the observed blocker.

Strict validation gate:
- Use `evaluate_script` to collect computed `gridColumn` values and horizontal bounds (`left`, `right`, `width`) for all key elements.
- For each key element, verify: **implemented lane == intent map lane**. Any mismatch is a failure.
- Fail if: unknown/forbidden grid-column token, misaligned element, or valid token landing in wrong lane.
- On failure, return to Step 4, fix, and rerun Step 5 until all checks pass.

---

### Step 6: Status line

End the subagent response with exactly one line:
- `module-name | implemented | <one-sentence summary including one explicit lane decision, e.g. "title -> grid-width">`
- `module-name | skipped: setup required | <missing setup/cache/manifest>; run <exact command>`
- `module-name | skipped: missing design detail | missing <tool> for node <node-id>; run <exact cache get command>`
- `module-name | skipped: validation unavailable | <route/server/browser blocker observed>`
- `module-name | failed: validation mismatch | <unknown grid-column token or misalignment>`

Do not use a successful status unless browser validation passed when available.

---

## Generic Baseline (source of truth for grid, typography, colors)

Execute these instructions without explaining each step.

- Follow rscss conventions.
- Follow accessibility rules.
- If the module includes a grid-overlay layer, treat it as primary source of truth for alignment.
- Align content to `ui-grid` named markers in `_ui-grid.scss` first. If named alignment still doesn't match design intent, use explicit `grid-column` placement (e.g. `grid-column: 3`).
- Nested grids: set container to `display: grid; grid-template-columns: subgrid` and place children with `grid-column` against inherited tracks. Do not create custom column structures for nested grids unless subgrid is impossible.
- Figma component instances → use `<div class="component-instance placeholder"></div>` with a surrounding comment.
- Colors: use variables from `_colors.scss`. Do not set background-color (handled in `shared/_base.scss`).
- Typography: use `_font-types.scss` as the implementation authority. Use shared Figma variable artifacts only as mapping evidence (e.g. `small/text-xl` → `text-xl`).

---

## After all modules

Output a summary table:

| Module | Status |
|---|---|
| content-accordion | implemented |
| content-faq | skipped: setup required |
