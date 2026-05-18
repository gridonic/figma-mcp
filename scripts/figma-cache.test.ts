import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildCacheKey, createModuleManifest } from './cache-lookup.js';
import { analyzeSparseDesignContext, warmSparseChildDesignContexts } from './figma-cache.js';

function makeCacheRoot(): string {
  return mkdtempSync(join(tmpdir(), 'figma-cache-warm-test-'));
}

function writeDesignContextArtifact(cacheRoot: string, moduleName: string, fileKey: string, nodeId: string): void {
  const key = buildCacheKey('get_design_context', fileKey, nodeId, {});
  const dir = join(cacheRoot, 'artifacts', `${moduleName}__${key}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'payload.json'), JSON.stringify({ ok: true }));
}

test('sparse parent with two child ids auto-fetches both and produces complete manifest', async () => {
  const cacheRoot = makeCacheRoot();
  try {
    const moduleName = 'header-hero';
    const fileKey = 'abc123';
    const sourceNodeId = '7125:11732';
    const childA = '7125:11576';
    const childB = '7125:11577';
    const fetched: string[] = [];
    const payload = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id: sourceNodeId,
            children: [
              { id: childA, type: 'INSTANCE' },
              { id: childB, type: 'FRAME' },
            ],
            note: 'MUST call get_design_context on the nodes or sublayers individually.',
          }),
        },
      ],
    };

    const analysis = analyzeSparseDesignContext(payload, sourceNodeId);
    assert.equal(analysis.isSparse, true);
    assert.deepEqual(analysis.directChildNodeIds, [childA, childB]);

    const warm = await warmSparseChildDesignContexts({
      analysis,
      cacheRoot,
      moduleName,
      fileKey,
      fetchDesignContext: async (nodeId) => {
        fetched.push(nodeId);
        writeDesignContextArtifact(cacheRoot, moduleName, fileKey, nodeId);
        return { fromCache: false };
      },
    });

    assert.deepEqual(fetched, [childA, childB]);

    const manifest = createModuleManifest({
      cacheRoot,
      moduleName,
      fileKey,
      sourceUrl: `https://www.figma.com/design/${fileKey}/test?node-id=7125-11732`,
      sourceNodeId,
      designContext: payload,
      sparseChildNodeHints: warm.childNodeIds,
      autoFetchedChildNodes: warm.autoFetchedChildNodeIds,
      missingChildNodes: warm.missingChildNodeIds,
      sparseDetectionReasons: warm.sparseReasons,
    });

    assert.equal(manifest.complete, true);
    assert.deepEqual(
      manifest.childNodes.map((node) => node.nodeId),
      [childA, childB]
    );
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('sparse warm reuses cached child artifact and fetches only missing child', async () => {
  const cacheRoot = makeCacheRoot();
  try {
    const moduleName = 'header-hero';
    const fileKey = 'abc123';
    const sourceNodeId = '7125:11732';
    const childCached = '7125:11576';
    const childMissing = '7125:11577';
    const fetched: string[] = [];
    writeDesignContextArtifact(cacheRoot, moduleName, fileKey, childCached);
    const payload = {
      id: sourceNodeId,
      children: [
        { id: childCached, type: 'INSTANCE' },
        { id: childMissing, type: 'INSTANCE' },
      ],
      note: 'MUST call get_design_context on child nodes individually.',
    };
    const analysis = analyzeSparseDesignContext(payload, sourceNodeId);

    await warmSparseChildDesignContexts({
      analysis,
      cacheRoot,
      moduleName,
      fileKey,
      fetchDesignContext: async (nodeId) => {
        fetched.push(nodeId);
        writeDesignContextArtifact(cacheRoot, moduleName, fileKey, nodeId);
        return { fromCache: false };
      },
    });

    assert.deepEqual(fetched, [childMissing]);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('child fetch failure marks manifest partial and continues', async () => {
  const cacheRoot = makeCacheRoot();
  try {
    const moduleName = 'header-text';
    const fileKey = 'abc123';
    const sourceNodeId = '7125:11823';
    const childOk = '7125:11901';
    const childFail = '7125:11902';
    const payload = {
      id: sourceNodeId,
      children: [
        { id: childOk, type: 'INSTANCE' },
        { id: childFail, type: 'INSTANCE' },
      ],
      note: 'You must call get_design_context on these nodes individually.',
    };
    const analysis = analyzeSparseDesignContext(payload, sourceNodeId);

    const warm = await warmSparseChildDesignContexts({
      analysis,
      cacheRoot,
      moduleName,
      fileKey,
      fetchDesignContext: async (nodeId) => {
        if (nodeId === childFail) throw new Error('simulated MCP error');
        writeDesignContextArtifact(cacheRoot, moduleName, fileKey, nodeId);
        return { fromCache: false };
      },
    });

    const manifest = createModuleManifest({
      cacheRoot,
      moduleName,
      fileKey,
      sourceUrl: `https://www.figma.com/design/${fileKey}/test?node-id=7125-11823`,
      sourceNodeId,
      designContext: payload,
      sparseChildNodeHints: warm.childNodeIds,
      autoFetchedChildNodes: warm.autoFetchedChildNodeIds,
      missingChildNodes: warm.missingChildNodeIds,
      sparseDetectionReasons: warm.sparseReasons,
    });

    assert.equal(manifest.complete, false);
    assert.deepEqual(manifest.missingChildNodes, [childFail]);
    assert.equal(manifest.incompleteReasons.some((reason) => reason.includes(childFail)), true);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('non-sparse payload does not trigger child design-context fetches', async () => {
  const cacheRoot = makeCacheRoot();
  try {
    const moduleName = 'header-rich';
    const fileKey = 'abc123';
    const sourceNodeId = '7125:12001';
    const payload = {
      id: sourceNodeId,
      children: [
        {
          id: '7125:12002',
          type: 'FRAME',
          fills: [{ type: 'SOLID' }],
          children: [{ id: '7125:12003', type: 'TEXT', characters: 'Hello' }],
        },
      ],
    };
    const analysis = analyzeSparseDesignContext(payload, sourceNodeId);
    assert.equal(analysis.isSparse, false);
    const warm = await warmSparseChildDesignContexts({
      analysis,
      cacheRoot,
      moduleName,
      fileKey,
      fetchDesignContext: async () => {
        throw new Error('should not fetch for non-sparse payload');
      },
    });
    assert.deepEqual(warm.autoFetchedChildNodeIds, []);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('manifest exposes sparse child warm details for inspect json contract', () => {
  const cacheRoot = makeCacheRoot();
  try {
    const moduleName = 'header-contract';
    const fileKey = 'abc123';
    const sourceNodeId = '7125:13001';
    const childNodeId = '7125:13002';
    writeDesignContextArtifact(cacheRoot, moduleName, fileKey, childNodeId);
    const manifest = createModuleManifest({
      cacheRoot,
      moduleName,
      fileKey,
      sourceUrl: `https://www.figma.com/design/${fileKey}/test?node-id=7125-13001`,
      sourceNodeId,
      designContext: {
        id: sourceNodeId,
        children: [{ id: childNodeId, type: 'INSTANCE' }],
        note: 'MUST call get_design_context individually.',
      },
      sparseChildNodeHints: [childNodeId],
      autoFetchedChildNodes: [childNodeId],
      missingChildNodes: [],
      sparseDetectionReasons: ['instruction-text-hint'],
    });

    assert.equal(manifest.sparseDetection.detected, true);
    assert.deepEqual(manifest.autoFetchedChildNodes, [childNodeId]);
    assert.deepEqual(manifest.missingChildNodes, []);
    assert.equal(manifest.artifacts[childNodeId]?.get_design_context?.ready, true);
    assert.equal(manifest.childNodes.some((node) => node.nodeId === childNodeId), true);
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
});
