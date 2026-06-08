## [1.0.11](https://github.com/gridonic/figma-mcp/compare/v1.0.10...v1.0.11)

- add guides and improve readme

## [1.0.10](https://github.com/gridonic/figma-mcp/compare/v1.0.9...v1.0.10)

- add partials to pre-pass

## [1.0.9](https://github.com/gridonic/figma-mcp/compare/v1.0.8...v1.0.9)

- add readme for bridge-setup

## [1.0.8](https://github.com/gridonic/figma-mcp/compare/v1.0.7...v1.0.8)

- Add bridge commands
- rename commands using colon styling

## [1.0.7](https://github.com/gridonic/figma-mcp/compare/v1.0.6...v1.0.7)

- refactored config file

## [1.0.6](https://github.com/gridonic/figma-mcp/compare/v1.0.5...v1.0.6)

- improve cache

## [1.0.5](https://github.com/gridonic/figma-mcp/compare/v1.0.4...v1.0.5)

- improve cache

## [1.0.4](https://github.com/gridonic/figma-mcp/compare/v1.0.3...v1.0.4)

- Improved cache functionality
- Updated rules workflow
- Changed cache list output style

## [1.0.3](https://github.com/gridonic/figma-mcp/compare/v1.0.2...v1.0.3)

- added create module skill

## [1.0.2](https://github.com/gridonic/figma-mcp/compare/v1.0.1...v1.0.2)

- fix tokens:sync for fonts with spaces in title

## [1.0.1](https://github.com/gridonic/figma-mcp/compare/v1.0.0...v1.0.1)

- init

# Changelog

## Unreleased

- Sparse source-node design context now auto-warms direct child design contexts during cache warm, with manifest metadata for auto-fetched/missing children and incomplete reasons.
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
