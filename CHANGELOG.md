# Changelog

## Unreleased

- Fixed cache validation false-negatives in `modules:setup` caused by ad-hoc key checks and mixed node-id formats (`7125-11732` vs `7125:11732`).
- Introduced centralized cache lookup/validation in `scripts/cache-lookup.ts` with deterministic cache-root resolution (explicit arg -> env -> default), canonical key construction, index-first checks, and canonical directory fallback checks.
- Updated module validation output to report exact missing artifact scope and details (top-level vs nested, node id, cache root), and added `--debug-cache` for lookup diagnostics.
- Added tests for node-id normalization, cache-root precedence, top-level artifact detection, nested-node-only missing behavior, and mixed separator handling.

### Before
- `modules:setup --no-warm-cache` used local ad-hoc index key checks that could misreport missing artifacts.
- Diagnostics were vague (`missing: get_screenshot,...`) and did not identify node scope or cache root.

### After
- Cache validation uses a single shared lookup implementation and canonical key strategy.
- Present artifacts under canonical cache folders are detected reliably.
- Missing artifacts are reported with precise context, including top-level vs nested node failures.
