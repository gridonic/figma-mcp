import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildCacheKey,
  buildLegacyVariableDefsCacheKey,
  createModuleManifest,
  getArtifactStatus,
  loadModuleManifest,
  lookupArtifact,
  normalizeNodeId,
  resolveCacheRoot,
  saveModuleManifest,
  validateModuleCache,
  validateSourceNodeCache,
} from './cache-lookup.js';

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

test('variable definitions include node identity in cache keys', () => {
  const fileKey = 'abc123';
  const first = buildCacheKey('get_variable_defs', fileKey, '7125:11732', {});
  const second = buildCacheKey('get_variable_defs', fileKey, '7125:11823', {});
  assert.notEqual(first, second);
  assert.match(first, /__7125-11732__get_variable_defs__/);
  assert.match(second, /__7125-11823__get_variable_defs__/);
});

test('get_variable_defs index keys remain unique across modules and nodes', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const fileKey = 'abc123';
    const fixtures = [
      { moduleName: 'header-hero', nodeId: '7125:11732' },
      { moduleName: 'header-text', nodeId: '7125:11823' },
    ] as const;

    const entries: Record<string, unknown> = {};
    const keys: string[] = [];
    for (const fixture of fixtures) {
      const key = buildCacheKey('get_variable_defs', fileKey, fixture.nodeId, {});
      keys.push(key);
      const dirName = `${fixture.moduleName}__${key}`;
      writeArtifact(cacheRoot, key, 'payload', dirName);
      entries[key] = {
        key,
        toolName: 'get_variable_defs',
        fileKey,
        nodeId: fixture.nodeId,
        sourceUrl: 'https://www.figma.com',
        argsHash: key.split('__').at(-1),
        artifactDir: join(cacheRoot, 'artifacts', dirName),
        payloadPath: join(cacheRoot, 'artifacts', dirName, 'payload.json'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        manualRefreshOnly: true,
      };
    }
    writeIndex(cacheRoot, entries);

    assert.equal(new Set(keys).size, fixtures.length);
    for (const fixture of fixtures) {
      const status = getArtifactStatus(cacheRoot, fixture.moduleName, fileKey, fixture.nodeId, 'get_variable_defs');
      assert.equal(status.ready, true);
      assert.equal(status.found.length, 1);
      assert.equal(status.found[0]?.includes(`${fixture.moduleName}__`), true);
    }
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('lookupArtifact falls back to legacy get_variable_defs key when needed', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const fileKey = 'abc123';
    const nodeId = '7125:11732';
    const legacyKey = buildLegacyVariableDefsCacheKey(fileKey, {});
    const dirName = `header-text__${legacyKey}`;
    writeArtifact(cacheRoot, legacyKey, 'payload', dirName);
    writeIndex(cacheRoot, {
      [legacyKey]: {
        key: legacyKey,
        toolName: 'get_variable_defs',
        fileKey,
        nodeId,
        sourceUrl: 'https://www.figma.com',
        argsHash: legacyKey.split('__').at(-1),
        artifactDir: join(cacheRoot, 'artifacts', dirName),
        payloadPath: join(cacheRoot, 'artifacts', dirName, 'payload.json'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        manualRefreshOnly: true,
      },
    });

    const result = lookupArtifact(
      { version: 1, entries: JSON.parse(readFileSync(join(cacheRoot, 'index.json'), 'utf-8')).entries },
      cacheRoot,
      'get_variable_defs',
      fileKey,
      nodeId,
      {}
    );
    assert.equal(result.hit, true);
    assert.equal(result.key, legacyKey);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('lookupArtifact prefers new get_variable_defs key over legacy key', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const fileKey = 'abc123';
    const nodeId = '7125:11732';
    const newKey = buildCacheKey('get_variable_defs', fileKey, nodeId, {});
    const legacyKey = buildLegacyVariableDefsCacheKey(fileKey, {});
    writeArtifact(cacheRoot, newKey, 'payload', `header-text__${newKey}`);
    writeArtifact(cacheRoot, legacyKey, 'payload', `header-text__${legacyKey}`);
    writeIndex(cacheRoot, {
      [legacyKey]: {
        key: legacyKey,
        toolName: 'get_variable_defs',
        fileKey,
        nodeId,
        sourceUrl: 'https://www.figma.com',
        argsHash: legacyKey.split('__').at(-1),
        artifactDir: join(cacheRoot, 'artifacts', `header-text__${legacyKey}`),
        payloadPath: join(cacheRoot, 'artifacts', `header-text__${legacyKey}`, 'payload.json'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        manualRefreshOnly: true,
      },
      [newKey]: {
        key: newKey,
        toolName: 'get_variable_defs',
        fileKey,
        nodeId,
        sourceUrl: 'https://www.figma.com',
        argsHash: newKey.split('__').at(-1),
        artifactDir: join(cacheRoot, 'artifacts', `header-text__${newKey}`),
        payloadPath: join(cacheRoot, 'artifacts', `header-text__${newKey}`, 'payload.json'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        manualRefreshOnly: true,
      },
    });

    const result = lookupArtifact(
      { version: 1, entries: JSON.parse(readFileSync(join(cacheRoot, 'index.json'), 'utf-8')).entries },
      cacheRoot,
      'get_variable_defs',
      fileKey,
      nodeId,
      {}
    );
    assert.equal(result.hit, true);
    assert.equal(result.key, newKey);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
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

test('validateSourceNodeCache ignores explicit nested node hints as readiness requirements', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const moduleName = 'header-hero';
    const fileKey = 'abc123';
    const sourceNode = '7125:11576';
    for (const tool of ['get_screenshot', 'get_design_context', 'get_variable_defs'] as const) {
      const key = buildCacheKey(tool, fileKey, sourceNode, {});
      writeArtifact(cacheRoot, key, tool === 'get_screenshot' ? 'image' : 'payload', `${moduleName}__${key}`);
    }

    const result = validateSourceNodeCache({
      cacheRoot,
      moduleName,
      fileKey,
      sourceNodeId: sourceNode,
      requiredTools: ['get_screenshot', 'get_design_context', 'get_variable_defs'],
    });
    assert.equal(result.failures.length, 0);
    assert.deepEqual(result.nestedNodeIds, []);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('module manifest records discovered child nodes and explicit hints', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const fileKey = 'abc123';
    const moduleName = 'header-hero';
    const sourceNode = '7125:11576';
    const designKey = buildCacheKey('get_design_context', fileKey, sourceNode, {});
    const screenshotKey = buildCacheKey('get_screenshot', fileKey, sourceNode, {});
    const variableKey = buildCacheKey('get_variable_defs', fileKey, sourceNode, {});
    writeArtifact(cacheRoot, designKey, 'payload', `${moduleName}__${designKey}`);
    writeArtifact(cacheRoot, screenshotKey, 'image', `${moduleName}__${screenshotKey}`);
    writeArtifact(cacheRoot, variableKey, 'payload', `${moduleName}__${variableKey}`);

    const manifest = createModuleManifest({
      cacheRoot,
      moduleName,
      fileKey,
      sourceUrl: `https://www.figma.com/design/${fileKey}/test?node-id=7125-11576&starting-point-node-id=7125-11999`,
      sourceNodeId: sourceNode,
      designContext: {
        id: sourceNode,
        name: 'Header Hero',
        children: [{ id: '7125:11732', name: 'Headline', type: 'TEXT' }],
      },
      updatedAt: '2026-05-18T00:00:00.000Z',
    });
    const manifestPath = saveModuleManifest(cacheRoot, manifest);
    const loaded = loadModuleManifest(cacheRoot, moduleName, fileKey, sourceNode);

    assert.equal(manifestPath.endsWith(`${moduleName}__${fileKey}__7125-11576.json`), true);
    assert.equal(loaded?.complete, true);
    assert.deepEqual(
      loaded?.childNodes.map((node) => [node.nodeId, node.source]),
      [
        ['7125:11732', 'discovered'],
        ['7125:11999', 'hint'],
      ]
    );
    assert.equal(loaded?.sharedVariableArtifact?.key, variableKey);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('module manifest marks undiscoverable payloads as partial', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const manifest = createModuleManifest({
      cacheRoot,
      moduleName: 'header-text',
      fileKey: 'abc123',
      sourceUrl: 'https://www.figma.com/design/abc123/test?node-id=7125-11823',
      sourceNodeId: '7125:11823',
      designContext: { content: [{ type: 'text', text: 'plain text without node ids' }] },
    });
    assert.equal(manifest.complete, false);
    assert.equal(manifest.warnings.length > 0, true);
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
    assert.equal(result.failures.some((f) => f.toolName === 'get_variable_defs'), true);
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
