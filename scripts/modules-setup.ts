#!/usr/bin/env npx tsx

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { getCachedOrFetch } from './figma-cache.js';
import { extractFileKey, normalizeNodeId, parseFigmaNodeIds, resolveCacheRoot, validateModuleCache } from './cache-lookup.js';
import { loadFigmaLinksConfig, resolveConfigPath, stripAtPrefix } from './config-loader.js';

// Project root = wherever the CLI is invoked from (the consuming project)
const ROOT = process.cwd();

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
  debugCache: boolean;
  cacheRoot: string | null;
}

const REQUIRED_TOOLS: RequiredTool[] = ['get_screenshot', 'get_design_context', 'get_variable_defs'];

function parseArgs(argv: string[]): SetupOptions {
  const commandArg = readArgValue(argv, '--create-modules-command');
  const cacheRoot = readArgValue(argv, '--cache-root');
  return {
    runTokenSync: !argv.includes('--skip-tokens-sync'),
    warmCache: !argv.includes('--no-warm-cache'),
    scaffoldMissing: !argv.includes('--no-scaffold'),
    runCreateModules: !argv.includes('--skip-create-modules'),
    createModulesCommand: commandArg,
    debugCache: argv.includes('--debug-cache'),
    cacheRoot,
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

function loadModulesFromFigmaLinks(configPath: string): ModuleTarget[] {
  const config = loadFigmaLinksConfig(configPath);
  const modules: ModuleTarget[] = [];

  for (const [moduleName, rawUrl] of Object.entries(config.modules ?? {})) {
    if (!rawUrl.startsWith('@http')) continue;
    const figmaUrl = stripAtPrefix(rawUrl);
    try {
      const fileKey = extractFileKey(figmaUrl);
      const { topLevelNodeId } = parseFigmaNodeIds(figmaUrl);
      modules.push({
        moduleName,
        figmaUrl,
        fileKey,
        nodeId: topLevelNodeId,
        astroPath: resolveAstroPath(moduleName),
      });
    } catch {
      // skip entries with unparseable URLs
    }
  }

  return modules;
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

async function ensureRequiredCache(
  moduleTarget: ModuleTarget,
  options: { warmCache: boolean; cacheRoot: string; debugCache: boolean }
): Promise<string[]> {
  const topNodeId = normalizeNodeId(moduleTarget.nodeId);
  if (options.warmCache) {
    const missing: string[] = [];
    const { nestedNodeIds } = parseFigmaNodeIds(moduleTarget.figmaUrl);
    const nodes = [topNodeId, ...nestedNodeIds.map(normalizeNodeId).filter((id) => id !== topNodeId)];
    if (options.debugCache) {
      console.log(`[cache-debug] cacheRoot=${options.cacheRoot}`);
      console.log(`[cache-debug] topLevelNodeId=${topNodeId}`);
      console.log(`[cache-debug] nestedNodeIds=${nodes.slice(1).join(',') || '(none)'}`);
    }
    for (const nodeId of nodes) {
      for (const tool of REQUIRED_TOOLS) {
        if (options.debugCache) {
          console.log(`[cache-debug] warm-fetch ${tool} node=${nodeId}`);
        }
        try {
          await getCachedOrFetch({
            toolName: tool,
            sourceUrl: moduleTarget.figmaUrl,
            nodeId,
            allowFetchOnMiss: true,
            name: moduleTarget.moduleName,
          });
        } catch {
          const prefix = nodeId === topNodeId ? '' : '[nested] ';
          missing.push(`${prefix}missing required artifact: ${tool} for node ${nodeId} (cacheRoot=${options.cacheRoot})`);
        }
      }
    }
    return missing;
  }

  const result = validateModuleCache({
    cacheRoot: options.cacheRoot,
    figmaUrl: moduleTarget.figmaUrl,
    fileKey: moduleTarget.fileKey,
    topLevelNodeId: topNodeId,
    requiredTools: REQUIRED_TOOLS,
    debug: options.debugCache,
  });
  if (options.debugCache) {
    for (const line of result.debug) {
      console.log(`[cache-debug] ${line}`);
    }
  }
  return result.failures.map((failure) =>
    failure.scope === 'nested' ? `[nested] ${failure.message}` : failure.message
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);
  const configPath = resolveConfigPath(argv);
  const cacheRoot = resolveCacheRoot({ cacheRoot: options.cacheRoot ?? undefined, cwd: ROOT });
  const modules = loadModulesFromFigmaLinks(configPath);

  if (options.runTokenSync) {
    console.log('\nStep: syncing design tokens...');
    execSync('npm run tokens:sync', { cwd: ROOT, stdio: 'inherit' });
  } else {
    console.log('\nStep skipped: tokens sync');
  }

  if (modules.length === 0) {
    console.log(`No modules with @http links found in ${configPath}`);
    return;
  }

  const rows: Array<{ moduleName: string; file: string; cache: string; scaffold: string }> = [];

  for (const moduleTarget of modules) {
    const missingCache = await ensureRequiredCache(moduleTarget, {
      warmCache: options.warmCache,
      cacheRoot,
      debugCache: options.debugCache,
    });
    const topLevelMissing = missingCache.filter((m) => !m.startsWith('[nested]'));
    const nestedMissing = missingCache.filter((m) => m.startsWith('[nested]'));
    let cacheStatus = 'ok';
    if (topLevelMissing.length > 0 && nestedMissing.length > 0) {
      cacheStatus = `missing top-level + nested: ${[...topLevelMissing, ...nestedMissing].join(' | ')}`;
    } else if (topLevelMissing.length > 0) {
      cacheStatus = `missing top-level: ${topLevelMissing.join(' | ')}`;
    } else if (nestedMissing.length > 0) {
      cacheStatus = `missing nested only: ${nestedMissing.join(' | ')}`;
    }

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
    console.log(
      '\nSetup is incomplete. Fix missing cache/artifacts (or run without --no-warm-cache) and ensure missing files are scaffolded.'
    );
    process.exit(1);
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
