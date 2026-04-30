#!/usr/bin/env npx tsx
/**
 * Sync design tokens (colors, typography) from Figma MCP to SCSS files.
 * Config: .cursor/mcp/figma-links.yaml
 *
 * Requires Figma desktop app with MCP server enabled (http://127.0.0.1:3845/mcp)
 *
 * Usage:
 *   npx figma-mcp tokens:sync             # Interactive: y/n/c confirmation
 *   npx figma-mcp tokens:sync -y          # Skip confirmation (use defaults)
 *   npx figma-mcp tokens:sync --debug     # Log raw MCP response objects
 *   npx figma-mcp tokens:sync --refresh   # Refresh local cache from MCP first
 */

import { createInterface } from 'readline';
import { copyFileSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { getCachedOrFetch } from './figma-cache.js';
import { extractFileKey, parseFigmaNodeIds } from './cache-lookup.js';
import { loadFigmaLinksConfig, resolveConfigPath, stripAtPrefix } from './config-loader.js';

// Project root = wherever the CLI is invoked from (the consuming project)
const ROOT = process.cwd();

const DEFAULT_COLORS_SCSS = join(ROOT, 'src/sass/root/_colors.scss');
const DEFAULT_FONT_TYPES_SCSS = join(ROOT, 'src/sass/typography/_font-types.scss');

const COLORS_START = '// @figma-tokens:colors:start';
const COLORS_END = '// @figma-tokens:colors:end';
const FONT_TYPES_START = '// @figma-tokens:font-types:start';
const FONT_TYPES_END = '// @figma-tokens:font-types:end';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

function question(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function isSkipConfirm(): boolean {
  const args = process.argv.slice(2);
  return args.includes('-y') || args.includes('--yes');
}

function isDebug(): boolean {
  return process.argv.slice(2).includes('--debug');
}

function isRefresh(): boolean {
  return process.argv.slice(2).includes('--refresh');
}

interface Paths {
  configPath: string;
  colorsScss: string;
  fontTypesScss: string;
}

async function resolvePaths(): Promise<Paths> {
  const defaults: Paths = {
    configPath: resolveConfigPath(process.argv.slice(2)),
    colorsScss: DEFAULT_COLORS_SCSS,
    fontTypesScss: DEFAULT_FONT_TYPES_SCSS,
  };

  if (isSkipConfirm()) {
    return defaults;
  }

  const rel = (p: string) => (p.startsWith(ROOT) ? p.slice(ROOT.length).replace(/^\//, '') : p);

  console.log(c.cyan('Current config:'));
  console.log('  Config file:    ', c.dim(rel(defaults.configPath)));
  console.log('  Colors SCSS:    ', c.dim(rel(defaults.colorsScss)));
  console.log('  Font types SCSS:', c.dim(rel(defaults.fontTypesScss)));
  console.log('');

  const answer = await question('Proceed? (y/n/c for custom) > ');

  if (answer === 'n' || answer === 'no') {
    console.log(c.yellow('Aborted.'));
    process.exit(0);
  }

  if (answer === 'y' || answer === 'yes' || answer === '') {
    return defaults;
  }
  if (answer !== 'c' && answer !== 'custom') {
    console.log(c.yellow('Invalid input. Use y, n, or c.'));
    return resolvePaths();
  }

  const configPathStr = await question(`Config path [${rel(defaults.configPath)}] > `);
  const colorsScssStr = await question(`Colors SCSS [${rel(defaults.colorsScss)}] > `);
  const fontTypesScssStr = await question(`Font types SCSS [${rel(defaults.fontTypesScss)}] > `);

  return {
    configPath: configPathStr ? resolve(configPathStr) : defaults.configPath,
    colorsScss: colorsScssStr ? resolve(colorsScssStr) : defaults.colorsScss,
    fontTypesScss: fontTypesScssStr ? resolve(fontTypesScssStr) : defaults.fontTypesScss,
  };
}

interface FigmaNodeConfig {
  colorsNodeId: string;
  typographyNodeId: string;
  colorsUrl: string;
  typographyUrl: string;
}

function loadFigmaConfig(configPath: string): FigmaNodeConfig {
  const config = loadFigmaLinksConfig(configPath);
  const rawColors = config.styleguide?.colors ?? '';
  const rawTypography = config.styleguide?.typography ?? '';

  if (!rawColors || !rawColors.includes('figma.com/design/')) {
    throw new Error(`styleguide.colors URL missing or invalid in ${configPath}`);
  }
  if (!rawTypography || !rawTypography.includes('figma.com/design/')) {
    throw new Error(`styleguide.typography URL missing or invalid in ${configPath}`);
  }

  const colorsUrl = stripAtPrefix(rawColors);
  const typographyUrl = stripAtPrefix(rawTypography);

  return {
    colorsNodeId: parseFigmaNodeIds(colorsUrl).topLevelNodeId,
    typographyNodeId: parseFigmaNodeIds(typographyUrl).topLevelNodeId,
    colorsUrl,
    typographyUrl,
  };
}

function parseVariableDefs(content: Array<{ type: string; text?: string }>): Record<string, string> {
  const textContent = content?.find((c) => c.type === 'text' && c.text);
  if (!textContent?.text) return {};
  try {
    return JSON.parse(textContent.text) as Record<string, string>;
  } catch {
    return {};
  }
}

function hexToHsla(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const a = h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 1000) / 1000 : 1;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  let sat = 0;
  const light = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    sat = light > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        hue = ((b - r) / d + 2) / 6;
        break;
      default:
        hue = ((r - g) / d + 4) / 6;
        break;
    }
  }

  const hDeg = Math.round(hue * 360);
  const sPct = Math.round(sat * 100);
  const lPct = Math.round(light * 100);
  const aStr = a === 1 ? '1' : String(a).replace(/\.?0+$/, '');
  return `hsla(${hDeg}, ${sPct}%, ${lPct}%, ${aStr})`;
}

function sanitizeColorName(name: string): string {
  return name
    .replace(/^Colors\//, '')
    .replace(/@/g, '-')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function transformColorsToScss(vars: Record<string, string>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) continue;
    const scssName = sanitizeColorName(name);
    if (!scssName) continue;
    lines.push(`  --color-${scssName}: ${hexToHsla(value)};`);
  }
  return lines.join('\n');
}

interface FontProps {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: number;
}

function parseFontString(str: string): FontProps | null {
  const m = str.match(
    /Font\(family:\s*"([^"]+)",\s*style:\s*\w+,\s*size:\s*([\d.]+),\s*weight:\s*(\d+),\s*lineHeight:\s*([\d.]+),\s*letterSpacing:\s*(-?[\d.]+)\)/
  );
  if (!m) return null;
  return {
    fontFamily: m[1],
    fontSize: parseFloat(m[2]),
    fontWeight: parseInt(m[3], 10),
    lineHeight: parseFloat(m[4]),
    letterSpacing: parseFloat(m[5]),
  };
}

function fontFamilyToVar(family: string): string {
  const varName = family
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  return `'var(--font-${varName}), ${family}, sans-serif'`;
}

function pxToRem(px: number): string {
  return `${px / 16}rem`;
}

function lineHeightToScss(lh: number): string {
  if (lh > 0 && lh <= 3) return String(Math.round(lh * 100) / 100);
  return String(lh);
}

function transformTypographyToScss(vars: Record<string, string>): string {
  const entries = new Map<string, { vs?: FontProps; vl?: FontProps }>();

  for (const [key, value] of Object.entries(vars)) {
    if (!value.startsWith('Font(')) continue;
    const props = parseFontString(value);
    if (!props) continue;

    const viewport = key.includes('small/') ? 'vs' : key.includes('large/') ? 'vl' : null;
    if (!viewport) continue;

    const typeKey = key.replace(/^.*(?:small|large)\//, '');

    if (!entries.has(typeKey)) {
      entries.set(typeKey, {});
    }
    entries.get(typeKey)![viewport] = props;
  }

  const blocks: string[] = [];
  for (const [typeKey, { vs, vl }] of entries) {
    const viewports: string[] = [];
    for (const vp of ['vs', 'vl'] as const) {
      const p = vp === 'vs' ? vs : vl;
      if (!p) continue;
      const parts = [
        `font-family: ${fontFamilyToVar(p.fontFamily)}`,
        `font-size: ${pxToRem(p.fontSize)}`,
        'font-style: normal',
        `font-weight: ${p.fontWeight}`,
        `line-height: ${lineHeightToScss(p.lineHeight)}`,
      ];
      if (p.letterSpacing !== 0) {
        parts.push(`letter-spacing: ${pxToRem(p.letterSpacing)}`);
      }
      viewports.push(`    ${vp}: (\n      ${parts.join(',\n      ')}\n    )`);
    }
    if (viewports.length > 0) {
      blocks.push(`  ${typeKey}: (\n${viewports.join(',\n')}\n  )`);
    }
  }

  return blocks.join(',\n');
}

function updateScssSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
  newContent: string
): void {
  const content = readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Markers not found in ${filePath}. Add:\n${startMarker}\n...\n${endMarker}`);
  }
  if (startIdx >= endIdx) {
    throw new Error(
      `Markers out of order in ${filePath}: "${startMarker}" must appear before "${endMarker}".`
    );
  }

  const backupPath = `${filePath}.figma-mcp.bak`;
  copyFileSync(filePath, backupPath);

  const before = content.slice(0, startIdx + startMarker.length);
  const after = content.slice(endIdx);
  const updated = `${before}\n${newContent}\n  ${after}`;
  writeFileSync(filePath, updated);

  const displayPath = filePath.startsWith(ROOT) ? filePath.slice(ROOT.length).replace(/^\//, '') : filePath;
  console.log(c.green('✓') + ` Updated ${c.dim(displayPath)} ${c.dim(`(backup: ${displayPath}.figma-mcp.bak)`)}`);
}

async function main(): Promise<void> {
  const paths = await resolvePaths();
  const start = performance.now();
  const figmaConfig = loadFigmaConfig(paths.configPath);
  const refresh = isRefresh();

  console.log(c.yellow('Config:'), c.dim(JSON.stringify(figmaConfig)));
  console.log('');
  console.log(
    c.cyan(refresh ? 'Refreshing token cache from MCP...' : 'Reading token cache (use --refresh to update)...')
  );
  console.log('');

  let colorVars: Record<string, string> = {};
  let typographyVars: Record<string, string> = {};

  try {
    const colorsResult = await getCachedOrFetch({
      toolName: 'get_variable_defs',
      sourceUrl: figmaConfig.colorsUrl,
      nodeId: figmaConfig.colorsNodeId,
      extraArgs: {
        clientLanguages: 'scss,css',
        clientFrameworks: 'unknown',
      },
      refresh,
      allowFetchOnMiss: true,
    });
    const colorsPayload = colorsResult.data as Record<string, unknown>;
    const colorsToolResult = (colorsPayload.result ?? colorsPayload) as { content?: Array<{ type: string; text?: string }> };
    colorVars = parseVariableDefs(colorsToolResult.content ?? []);
    console.log(
      `${colorsResult.fromCache ? c.yellow('cache') : c.green('fresh')} colors ${c.dim(figmaConfig.colorsNodeId)}`
    );

    const typographyResult = await getCachedOrFetch({
      toolName: 'get_variable_defs',
      sourceUrl: figmaConfig.typographyUrl,
      nodeId: figmaConfig.typographyNodeId,
      extraArgs: {
        clientLanguages: 'scss,css',
        clientFrameworks: 'unknown',
      },
      refresh,
      allowFetchOnMiss: true,
    });
    const typographyPayload = typographyResult.data as Record<string, unknown>;
    const typographyToolResult = (typographyPayload.result ?? typographyPayload) as {
      content?: Array<{ type: string; text?: string }>;
    };
    typographyVars = parseVariableDefs(typographyToolResult.content ?? []);
    console.log(
      `${typographyResult.fromCache ? c.yellow('cache') : c.green('fresh')} typography ${c.dim(figmaConfig.typographyNodeId)}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${msg}\nNo cached token data available. Run once with --refresh after rate limits reset to seed the local cache.`
    );
  }

  if (isDebug()) {
    console.log(c.dim('[debug] Colors from cache/MCP:'));
    console.log(c.dim(JSON.stringify(colorVars, null, 2)));
    console.log('');
    console.log(c.dim('[debug] Typography from cache/MCP:'));
    console.log(c.dim(JSON.stringify(typographyVars, null, 2)));
    console.log('');
  }

  if (Object.keys(colorVars).length > 0) {
    const colorEntries = Object.entries(colorVars).filter(([, v]) =>
      /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)
    );
    if (colorEntries.length > 0) {
      const colorsScss = transformColorsToScss(colorVars);
      updateScssSection(paths.colorsScss, COLORS_START, COLORS_END, colorsScss);
    }
  }

  const fontEntries = Object.entries(typographyVars).filter(([, v]) => v.startsWith('Font('));
  if (fontEntries.length > 0) {
    const fontTypesInner = transformTypographyToScss(typographyVars);
    const fontTypesScss = `$font-types: (\n${fontTypesInner}\n);`;
    updateScssSection(paths.fontTypesScss, FONT_TYPES_START, FONT_TYPES_END, fontTypesScss);
  }

  const elapsed = Math.round(performance.now() - start);
  console.log(c.green(`Done.`) + ` (${c.dim(elapsed + 'ms')})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
