import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildCacheKey, normalizeNodeId, resolveCacheRoot, validateModuleCache } from './cache-lookup.js';

function makeCacheRoot(): string {
  return mkdtempSync(join(tmpdir(), 'figma-mcp-cache-test-'));
}

function writeArtifact(
  cacheRoot: string,
  key: string,
  type: 'payload' | 'image' | 'metadata' = 'payload',
  dirNameOverride?: string
): void {
  const dir = join(cacheRoot, 'artifacts', dirNameOverride ?? key);
  mkdirSync(dir, { recursive: true });
  if (type === 'payload') {
    writeFileSync(join(dir, 'payload.json'), JSON.stringify({ ok: true }));
    return;
  }
  if (type === 'image') {
    writeFileSync(join(dir, 'image.png'), 'png-bytes');
    return;
  }
  writeFileSync(join(dir, 'payload.json'), JSON.stringify({ metadata: true }));
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
      writeArtifact(cacheRoot, key, tool === 'get_screenshot' ? 'image' : 'payload');
      writeIndex(cacheRoot, {});
    }
    const result = validateModuleCache({
      cacheRoot,
      moduleName: 'header-hero',
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
      writeArtifact(cacheRoot, key, tool === 'get_screenshot' ? 'image' : 'payload');
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
      moduleName: 'header-hero',
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

test('readiness uses direct fs and succeeds in .cursor/tmp-like ignored path', () => {
  const root = makeCacheRoot();
  const cacheRoot = join(root, '.cursor/tmp/figma-mcp-cache');
  try {
    const moduleName = 'header-hero';
    const fileKey = 'abc123';
    const nodeId = '7125-11732';
    for (const tool of ['get_screenshot', 'get_design_context', 'get_variable_defs'] as const) {
      const key = buildCacheKey(tool, fileKey, nodeId, {});
      const dirName = `${moduleName}__${key}`;
      writeArtifact(cacheRoot, key, tool === 'get_screenshot' ? 'image' : 'payload', dirName);
    }

    const result = validateModuleCache({
      cacheRoot,
      moduleName,
      figmaUrl: `https://www.figma.com/design/${fileKey}/test?node-id=${nodeId}`,
      fileKey,
      topLevelNodeId: nodeId,
      requiredTools: ['get_screenshot', 'get_design_context', 'get_variable_defs'],
      debug: true,
    });
    assert.equal(result.failures.length, 0);
    assert.equal(result.debug.some((line) => line.includes('lookupMode=direct-fs')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node-id format mismatch resolves between hyphen and colon', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const moduleName = 'header-hero';
    const fileKey = 'abc123';
    const nodeIdFromCache = '7125-11732';
    for (const tool of ['get_screenshot', 'get_design_context', 'get_variable_defs'] as const) {
      const key = buildCacheKey(tool, fileKey, nodeIdFromCache, {});
      writeArtifact(cacheRoot, key, tool === 'get_screenshot' ? 'image' : 'payload');
    }

    const result = validateModuleCache({
      cacheRoot,
      moduleName,
      figmaUrl: `https://www.figma.com/design/${fileKey}/test?node-id=7125:11732`,
      fileKey,
      topLevelNodeId: '7125:11732',
      requiredTools: ['get_screenshot', 'get_design_context', 'get_variable_defs'],
    });
    assert.equal(result.failures.length, 0);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('metadata-only artifacts do not satisfy required readiness', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const moduleName = 'header-text';
    const fileKey = 'abc123';
    const nodeId = '7125-11823';
    const metadataKey = buildCacheKey('get_metadata', fileKey, nodeId, {});
    writeArtifact(cacheRoot, metadataKey, 'metadata');

    const result = validateModuleCache({
      cacheRoot,
      moduleName,
      figmaUrl: `https://www.figma.com/design/${fileKey}/test?node-id=${nodeId}`,
      fileKey,
      topLevelNodeId: nodeId,
      requiredTools: ['get_screenshot', 'get_design_context', 'get_variable_defs'],
    });
    assert.equal(result.failures.length, 3);
    assert.equal(result.failures.every((failure) => failure.missingFiles.length > 0), true);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('regression fixtures header-hero and header-text pass readiness', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const fileKey = 'abc123';
    const fixtures = [
      { moduleName: 'header-hero', nodeId: '7125-11732' },
      { moduleName: 'header-text', nodeId: '7125-11823' },
    ] as const;

    for (const fixture of fixtures) {
      for (const tool of ['get_screenshot', 'get_design_context', 'get_variable_defs'] as const) {
        const key = buildCacheKey(tool, fileKey, fixture.nodeId, {});
        const dirName = `${fixture.moduleName}__${key}`;
        writeArtifact(cacheRoot, key, tool === 'get_screenshot' ? 'image' : 'payload', dirName);
      }
    }

    for (const fixture of fixtures) {
      const result = validateModuleCache({
        cacheRoot,
        moduleName: fixture.moduleName,
        figmaUrl: `https://www.figma.com/design/${fileKey}/test?node-id=${fixture.nodeId}`,
        fileKey,
        topLevelNodeId: fixture.nodeId,
        requiredTools: ['get_screenshot', 'get_design_context', 'get_variable_defs'],
      });
      assert.equal(result.failures.length, 0, `${fixture.moduleName} should be cache-ready`);
    }
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
