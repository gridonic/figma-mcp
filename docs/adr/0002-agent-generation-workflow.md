# ADR 0002: Agent Generation Workflow

## Status

Accepted

## Context

The source-node cache contract gives agents a stable way to inspect module design data through cache manifests. The next boundary is operational: users need an explicit, predictable preparation flow, while module-generation agents need a narrow write scope so they do not change setup, cache, token, or styling state while implementing Astro modules.

Earlier workflow instructions mixed these responsibilities. Agents read raw cache folders directly, stopped whole batches on a single cache miss, and did not distinguish setup failures from implementation or validation failures.

## Decision

Use explicit manual preparation followed by read-only generation with respect to setup state.

The canonical sequence is:

1. Warm managed source-node cache artifacts.
2. Sync design tokens.
3. Optionally validate/scaffold with `modules:setup --no-warm-cache --skip-tokens-sync`.
4. Invoke the module-generation agent.

Generation agents:

- Use `figma-mcp cache inspect <module> --json` as the first design-data step.
- Require source-node artifacts and a module manifest before editing.
- Treat child-node detail as required only when a concrete implementation decision needs it.
- Do not warm cache, sync tokens, scaffold files, or fetch missing child-node detail.
- Report exact manual recovery commands when setup or design detail is missing.
- Edit only existing target `.astro` files, with any temporary validation marker removed before final output.

The parent generation agent preflights all selected modules and spawns implementation subagents only for modules that pass. Subagents re-check their own module before editing. In all-module runs, modules with recoverable setup or design-detail problems are skipped while ready modules continue. Only global failures stop the run.

Browser validation is required when the dev server and testing route are available. If validation cannot run, the module must not be reported as fully validated.

## Consequences

Users keep control over cache refreshes, token sync, and scaffolding.

Generation output becomes easier to audit because setup problems, missing design detail, validation unavailability, and validation mismatches are reported as distinct statuses.

Agents consume a stable JSON contract instead of reverse-engineering cache directory names. This makes future cache layout changes less likely to break generation instructions.

Lazy child-detail fetching remains available as an explicit recovery or preparation action, but not as a default side effect of module generation.
