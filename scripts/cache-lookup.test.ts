import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildCacheKey, normalizeNodeId, resolveCacheRoot, validateModuleCache } from './cache-lookup.js';

function makeCacheRoot(): string {
  return mkdtempSync(join(tmpdir(), 'figma-mcp-cache-test-'));
}

function writeArtifact(cacheRoot: string, key: string): void {
  const dir = join(cacheRoot, 'artifacts', key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'payload.json'), JSON.stringify({ ok: true }));
}

function writeIndex(cacheRoot: string, entries: Record<string, unknown>): void {
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(join(cacheRoot, 'index.json'), JSON.stringify({ version: 1, entries }, null, 2));
}

test('normalizeNodeId handles hyphen and colon', () => {
  assert.equal(normalizeNodeId('7125-11732'), '7125:11732');
  assert.equal(normalizeNodeId('7125:11732'), '7125:11732');
});

test('resolveCacheRoot precedence explicit > env > default', () => {
  const explicit = 'C:/tmp/explicit-cache';
  assert.equal(resolveCacheRoot({ cacheRoot: explicit, cwd: 'C:/project', env: {} }), explicit);
  assert.equal(
    resolveCacheRoot({ cwd: 'C:/project', env: { FIGMA_MCP_CACHE_ROOT: 'C:/tmp/env-cache' } }),
    'C:/tmp/env-cache'
  );
  const resolved = resolveCacheRoot({ cwd: '/repo', env: {} }).replace(/\\/g, '/');
  assert.equal(resolved, '/repo/.cursor/tmp/figma-mcp-cache');
});

test('validateModuleCache finds top-level artifacts with canonical keys', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const fileKey = 'abc123';
    const nodeId = '7125:11732';
    for (const tool of ['get_screenshot', 'get_design_context', 'get_variable_defs'] as const) {
      const key = buildCacheKey(tool, fileKey, nodeId, {});
      writeArtifact(cacheRoot, key);
      writeIndex(cacheRoot, {});
    }
    const result = validateModuleCache({
      cacheRoot,
      figmaUrl: `https://www.figma.com/design/${fileKey}/test?node-id=7125-11732`,
      fileKey,
      topLevelNodeId: '7125-11732',
      requiredTools: ['get_screenshot', 'get_design_context', 'get_variable_defs'],
    });
    assert.equal(result.failures.length, 0);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('validateModuleCache reports nested missing without top-level miss', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const fileKey = 'abc123';
    const topNode = '7125:11576';
    const nestedNode = '7125:11732';
    const entries: Record<string, unknown> = {};
    for (const tool of ['get_screenshot', 'get_design_context', 'get_variable_defs'] as const) {
      const key = buildCacheKey(tool, fileKey, topNode, {});
      writeArtifact(cacheRoot, key);
      entries[key] = {
        key,
        toolName: tool,
        fileKey,
        nodeId: topNode,
        sourceUrl: 'https://www.figma.com',
        argsHash: key.split('__').at(-1),
        artifactDir: join(cacheRoot, 'artifacts', key),
        payloadPath: join(cacheRoot, 'artifacts', key, 'payload.json'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        manualRefreshOnly: true,
      };
    }
    writeIndex(cacheRoot, entries);

    const result = validateModuleCache({
      cacheRoot,
      figmaUrl: `https://www.figma.com/design/${fileKey}/test?node-id=7125-11576&starting-point-node-id=7125-11732`,
      fileKey,
      topLevelNodeId: topNode,
      requiredTools: ['get_screenshot', 'get_design_context', 'get_variable_defs'],
    });

    assert.equal(result.failures.some((f) => f.scope === 'top-level'), false);
    assert.equal(result.failures.length, 3);
    assert.equal(result.failures.every((f) => f.scope === 'nested'), true);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
