---
name: figma-create-modules
description: Create one or all Astro modules from Figma designs using the MCP cache. Use when the user says "create module", "implement modules from Figma", "run figma-create-modules", or wants to build/update Astro components from cached Figma designs.
---

# Figma Create Modules

Implement Astro modules from cached Figma designs. Do not change `.scss` files. Do not change `.gql` files. Only change `.astro` files.

**Do not ask for any confirmation at any point. Do not summarise what you are about to do. Do not ask whether to proceed. Start implementing immediately and only output text when you require user input mid-task or are writing the final summary table.**

## Invocation

The user may invoke this skill in two ways:

- **All modules** — no argument, or argument is `all`: process every module in `figma-links.yaml` that has a valid Figma link (value starts with `@http`).
- **Single module** — argument is a module name (e.g. `content-accordion`): process only that module.

If the argument is ambiguous, resolve it against the module names in `figma-links.yaml` and proceed without asking.

## Preparation

1. Read `.cursor/mcp/figma-links.yaml`.
2. Use `.cursor/tmp/figma-mcp-cache/` as the primary source for all Figma resources.
3. Determine the module list from the invocation mode above:
   - All modules: every entry whose value starts with `@http`.
   - Single module: the one named module (error if not found or has no valid link).

## Processing loop

For each module in the list, spawn a dedicated subagent using the Agent tool and have it complete Steps 1–6 independently.

- Launch all module subagents **in parallel** in one tool call batch when possible.
- Pass to each subagent: module name, Figma link (strip leading `@`), cache root `.cursor/tmp/figma-mcp-cache/`, and the full rules below (Steps 1–6 + Generic baseline).
- Parent agent waits for all subagents, then compiles their Step 6 status lines into the final summary table.
- Do not do module implementation work in the parent agent.

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

If the file does not exist, skip with a one-line note.

---

### Step 2: Inspect the Figma design (cache-first)

1. Load cached screenshot (`get_screenshot` cache artifact) for visual reference.
2. Load cached `get_design_context` for structure, layout, spacing.
3. Load cached `get_variable_defs` for typography and color variables.

Cache behavior:
- Use cache artifacts as the **required** source. Do not call Figma MCP tools directly.
- If any required artifact is missing, stop immediately and output: `module-name | ✗ skipped | missing required figma artifact(s): <list>; run npm run figma-mcp -- cache warm --refresh and rerun`

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

Strict validation gate:
- Use `evaluate_script` to collect computed `gridColumn` values and horizontal bounds (`left`, `right`, `width`) for all key elements.
- For each key element, verify: **implemented lane == intent map lane**. Any mismatch is a failure.
- Fail if: unknown/forbidden grid-column token, misaligned element, or valid token landing in wrong lane.
- On failure, return to Step 4, fix, and rerun Step 5 until all checks pass.

---

### Step 6: Status line

End the subagent response with exactly one line:
- `module-name | ✓ implemented | <one-sentence summary including one explicit lane decision, e.g. "title -> grid-width">`
- `module-name | ✗ skipped | <reason>`
- `module-name | ✗ skipped | grid validation failed (unknown grid-column token or misalignment)`

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
- Typography: read typography variables from cached `get_variable_defs` (e.g. `small/text-xl`), map to font classes in `_font-types.scss` (e.g. `text-xl`), and apply those classes.

---

## After all modules

Output a summary table:

| Module | Status |
|---|---|
| content-accordion | ✓ implemented |
| content-faq | ✗ no Figma link |
