#!/usr/bin/env npx tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { getCachedOrFetch } from './figma-cache.js';

// Project root = wherever the CLI is invoked from (the consuming project)
const ROOT = process.cwd();

const FIGMA_LINKS_PATH = join(ROOT, '.cursor/mcp/figma-links.yaml');
const CACHE_INDEX_PATH = join(ROOT, '.cursor/tmp/figma-mcp-cache/index.json');

type RequiredTool = 'get_screenshot' | 'get_design_context' | 'get_variable_defs';

interface ModuleTarget {
  moduleName: string;
  figmaUrl: string;
  fileKey: string;
  nodeId: string;
  astroPath: string;
}

interface SetupOptions {
  runTokenSync: boolean;
  warmCache: boolean;
  scaffoldMissing: boolean;
  runCreateModules: boolean;
  createModulesCommand: string | null;
}

interface CacheIndex {
  version: number;
  entries: Record<string, unknown>;
}

const REQUIRED_TOOLS: RequiredTool[] = ['get_screenshot', 'get_design_context', 'get_variable_defs'];

function parseArgs(argv: string[]): SetupOptions {
  const commandArg = readArgValue(argv, '--create-modules-command');
  return {
    runTokenSync: !argv.includes('--skip-tokens-sync'),
    warmCache: !argv.includes('--no-warm-cache'),
    scaffoldMissing: !argv.includes('--no-scaffold'),
    runCreateModules: !argv.includes('--skip-create-modules'),
    createModulesCommand: commandArg,
  };
}

function readArgValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function toPascalCase(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function resolveAstroPath(moduleName: string): string {
  const [prefix] = moduleName.split('-');
  const folder = prefix === 'teaser' || prefix === 'cta' ? 'content-modules' : `${prefix}-modules`;
  const fileName = `${toPascalCase(moduleName)}.astro`;
  return join(ROOT, 'src/components', folder, fileName);
}

function parseFigmaUrl(url: string): { fileKey: string; nodeId: string } {
  const clean = url.replace(/^@/, '');
  const fileKeyMatch = clean.match(/\/design\/([^/]+)/);
  const nodeMatch = clean.match(/[?&]node-id=(\d+)-(\d+)/);
  if (!fileKeyMatch || !nodeMatch) {
    throw new Error(`Could not parse fileKey/nodeId from URL: ${url}`);
  }
  return { fileKey: fileKeyMatch[1], nodeId: `${nodeMatch[1]}:${nodeMatch[2]}` };
}

function loadModulesFromFigmaLinks(path: string): ModuleTarget[] {
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');
  const modules: ModuleTarget[] = [];
  let inModules = false;

  for (const line of lines) {
    if (/^\s*modules:\s*$/.test(line)) {
      inModules = true;
      continue;
    }
    if (inModules && /^\S/.test(line)) break;

    if (!inModules) continue;

    const match = line.match(/^\s{2}([a-z0-9-]+):\s*["']([^"']*)["']/i);
    if (!match) continue;

    const moduleName = match[1];
    const figmaLink = match[2];
    if (!figmaLink.startsWith('@http')) continue;

    const figmaUrl = figmaLink.replace(/^@/, '');
    const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
    modules.push({
      moduleName,
      figmaUrl,
      fileKey,
      nodeId,
      astroPath: resolveAstroPath(moduleName),
    });
  }

  return modules;
}

function loadCacheIndex(path: string): CacheIndex {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CacheIndex;
  } catch {
    return { version: 1, entries: {} };
  }
}

function buildCacheKey(tool: RequiredTool, fileKey: string, nodeId: string): string {
  const argsHash = createHash('sha1').update(JSON.stringify({})).digest('hex').slice(0, 12);
  return `${fileKey}__${nodeId.replace(':', '-')}__${tool}__${argsHash}`;
}

function createModuleSkeleton(moduleName: string): string {
  const componentName = toPascalCase(moduleName);
  return `---
import type { ComponentProps } from 'astro/types';

type Props = ComponentProps<'section'>;
const { class: className, ...attrs } = Astro.props;
---

<section class:list={['ui-grid ${moduleName}', className]} {...attrs}>
  <!-- ${componentName}: scaffolded placeholder for figma-mcp-create-modules -->
</section>
`;
}

async function ensureRequiredCache(moduleTarget: ModuleTarget, warmCache: boolean): Promise<string[]> {
  const missingTools: string[] = [];

  for (const tool of REQUIRED_TOOLS) {
    if (warmCache) {
      try {
        await getCachedOrFetch({
          toolName: tool,
          sourceUrl: moduleTarget.figmaUrl,
          nodeId: moduleTarget.nodeId,
        });
        continue;
      } catch {
        missingTools.push(tool);
      }
    } else {
      const index = loadCacheIndex(CACHE_INDEX_PATH);
      const key = buildCacheKey(tool, moduleTarget.fileKey, moduleTarget.nodeId);
      if (!index.entries[key]) {
        missingTools.push(tool);
      }
    }
  }

  return missingTools;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const modules = loadModulesFromFigmaLinks(FIGMA_LINKS_PATH);

  if (options.runTokenSync) {
    console.log('\nStep: syncing design tokens...');
    execSync('npm run tokens:sync', { cwd: ROOT, stdio: 'inherit' });
  } else {
    console.log('\nStep skipped: tokens sync');
  }

  if (modules.length === 0) {
    console.log('No modules with @http links found in .cursor/mcp/figma-links.yaml');
    return;
  }

  const rows: Array<{ moduleName: string; file: string; cache: string; scaffold: string }> = [];

  for (const moduleTarget of modules) {
    const missingCache = await ensureRequiredCache(moduleTarget, options.warmCache);
    const cacheStatus = missingCache.length === 0 ? 'ok' : `missing: ${missingCache.join(',')}`;

    let scaffoldStatus = 'exists';
    if (!existsSync(moduleTarget.astroPath)) {
      if (options.scaffoldMissing) {
        mkdirSync(dirname(moduleTarget.astroPath), { recursive: true });
        writeFileSync(moduleTarget.astroPath, createModuleSkeleton(moduleTarget.moduleName), 'utf-8');
        scaffoldStatus = 'created';
      } else {
        scaffoldStatus = 'missing';
      }
    }

    rows.push({
      moduleName: moduleTarget.moduleName,
      file: scaffoldStatus,
      cache: cacheStatus,
      scaffold: moduleTarget.astroPath.replace(`${ROOT}/`, ''),
    });
  }

  console.log('\nmodules:setup summary');
  console.table(rows);

  const hasBlockingIssue = rows.some((row) => row.cache !== 'ok' || row.file === 'missing');
  if (hasBlockingIssue) {
    process.exitCode = 1;
    console.log(
      '\nSetup is incomplete. Fix missing cache/artifacts (or run without --no-warm-cache) and ensure missing files are scaffolded.'
    );
    return;
  }

  if (!options.runCreateModules) {
    console.log('\nSetup complete. Create-modules step skipped by flag.');
    return;
  }

  if (!options.createModulesCommand) {
    console.log('\nSetup complete. No create-modules command supplied.');
    console.log('Run again with: --create-modules-command "<your command to run @.cursor/rules/figma-mcp-create-modules.mdc>"');
    return;
  }

  console.log('\nStep: running create-modules command...');
  execSync(options.createModulesCommand, { cwd: ROOT, stdio: 'inherit' });
  console.log('\nPipeline complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
