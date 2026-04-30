import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type CacheToolName =
  | 'get_screenshot'
  | 'get_variable_defs'
  | 'get_design_context'
  | 'get_metadata'
  | 'get_figjam';

interface CacheIndexEntry {
  key: string;
  toolName: CacheToolName;
  fileKey: string;
  nodeId: string;
  sourceUrl: string;
  argsHash: string;
  artifactDir: string;
  payloadPath?: string;
  imagePath?: string;
  createdAt: string;
  updatedAt: string;
  manualRefreshOnly: true;
}

interface CacheIndex {
  version: number;
  entries: Record<string, CacheIndexEntry>;
}

export interface CacheLookupOptions {
  cacheRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ArtifactLookupResult {
  key: string;
  hit: boolean;
  source: 'index' | 'canonical-fallback' | 'missing';
}

export interface ModuleArtifactFailure {
  scope: 'top-level' | 'nested';
  nodeId: string;
  toolName: CacheToolName;
  message: string;
}

export interface ModuleCacheValidationResult {
  cacheRoot: string;
  topLevelNodeId: string;
  nestedNodeIds: string[];
  failures: ModuleArtifactFailure[];
  debug: string[];
}

const DEFAULT_CACHE_SUBPATH = '.cursor/tmp/figma-mcp-cache';
const CACHE_ROOT_ENV_KEYS = ['FIGMA_MCP_CACHE_ROOT', 'FIGMA_CACHE_ROOT'] as const;

export function normalizeNodeId(nodeId: string): string {
  return nodeId.trim().replace('-', ':');
}

export function resolveCacheRoot(options: CacheLookupOptions = {}): string {
  if (options.cacheRoot) return options.cacheRoot;
  const env = options.env ?? process.env;
  for (const key of CACHE_ROOT_ENV_KEYS) {
    const value = env[key];
    if (value && value.trim()) return value;
  }
  const cwd = options.cwd ?? process.cwd();
  return join(cwd, DEFAULT_CACHE_SUBPATH);
}

export function extractFileKey(url: string): string {
  const clean = url.replace(/^@/, '');
  const match = clean.match(/\/design\/([^/?#]+)/);
  if (!match) throw new Error(`Could not extract fileKey from URL: ${url}`);
  return match[1];
}

export function parseFigmaNodeIds(url: string): { topLevelNodeId: string; nestedNodeIds: string[] } {
  const matches = Array.from(url.matchAll(/[?&][a-z-]*node-id=(\d+)-(\d+)/gi));
  if (matches.length === 0) {
    throw new Error(`Could not parse node-id from URL: ${url}`);
  }
  const ids = matches.map((m) => `${m[1]}:${m[2]}`);
  const [topLevelNodeId, ...rest] = ids;
  const nestedNodeIds = [...new Set(rest.filter((id) => id !== topLevelNodeId))];
  return { topLevelNodeId, nestedNodeIds };
}

export function buildCacheKey(
  toolName: CacheToolName,
  fileKey: string,
  nodeId: string,
  extraArgs: Record<string, unknown> = {}
): string {
  const canonicalNodeId = normalizeNodeId(nodeId);
  const argsHash = createHash('sha1').update(JSON.stringify(extraArgs)).digest('hex').slice(0, 12);
  return `${fileKey}__${canonicalNodeId.replace(':', '-')}__${toolName}__${argsHash}`;
}

export function loadCacheIndex(cacheRoot: string): CacheIndex {
  const indexPath = join(cacheRoot, 'index.json');
  if (!existsSync(indexPath)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as CacheIndex;
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch {
    // no-op
  }
  return { version: 1, entries: {} };
}

export function lookupArtifact(
  index: CacheIndex,
  cacheRoot: string,
  toolName: CacheToolName,
  fileKey: string,
  nodeId: string,
  extraArgs: Record<string, unknown> = {}
): ArtifactLookupResult {
  const key = buildCacheKey(toolName, fileKey, nodeId, extraArgs);
  const entry = index.entries[key];
  if (entry) {
    const payloadExists = entry.payloadPath ? existsSync(entry.payloadPath) : false;
    const imageExists = entry.imagePath ? existsSync(entry.imagePath) : false;
    if (payloadExists || imageExists) {
      return { key, hit: true, source: 'index' };
    }
  }

  const artifactDir = join(cacheRoot, 'artifacts', key);
  const hasCanonicalPayload = existsSync(join(artifactDir, 'payload.json'));
  const hasCanonicalImage = existsSync(join(artifactDir, 'image.png'));
  if (hasCanonicalPayload || hasCanonicalImage) {
    return { key, hit: true, source: 'canonical-fallback' };
  }

  return { key, hit: false, source: 'missing' };
}

export function validateModuleCache(params: {
  cacheRoot: string;
  figmaUrl: string;
  fileKey: string;
  topLevelNodeId: string;
  requiredTools: CacheToolName[];
  debug?: boolean;
}): ModuleCacheValidationResult {
  const topLevelNodeId = normalizeNodeId(params.topLevelNodeId);
  const parsed = parseFigmaNodeIds(params.figmaUrl);
  const nestedNodeIds = parsed.nestedNodeIds.map(normalizeNodeId).filter((id) => id !== topLevelNodeId);
  const index = loadCacheIndex(params.cacheRoot);
  const failures: ModuleArtifactFailure[] = [];
  const debug: string[] = [];

  const record = (line: string): void => {
    if (params.debug) debug.push(line);
  };

  record(`cacheRoot=${params.cacheRoot}`);
  record(`topLevelNodeId=${topLevelNodeId}`);
  record(`nestedNodeIds=${nestedNodeIds.join(',') || '(none)'}`);

  for (const toolName of params.requiredTools) {
    const top = lookupArtifact(index, params.cacheRoot, toolName, params.fileKey, topLevelNodeId);
    record(`lookup top-level ${toolName} node=${topLevelNodeId} key=${top.key} hit=${top.hit} source=${top.source}`);
    if (!top.hit) {
      failures.push({
        scope: 'top-level',
        nodeId: topLevelNodeId,
        toolName,
        message: `missing required artifact: ${toolName} for node ${topLevelNodeId} (cacheRoot=${params.cacheRoot})`,
      });
    }
  }

  for (const nestedNodeId of nestedNodeIds) {
    for (const toolName of params.requiredTools) {
      const nested = lookupArtifact(index, params.cacheRoot, toolName, params.fileKey, nestedNodeId);
      record(`lookup nested ${toolName} node=${nestedNodeId} key=${nested.key} hit=${nested.hit} source=${nested.source}`);
      if (!nested.hit) {
        failures.push({
          scope: 'nested',
          nodeId: nestedNodeId,
          toolName,
          message: `missing required artifact: ${toolName} for node ${nestedNodeId} (cacheRoot=${params.cacheRoot})`,
        });
      }
    }
  }

  return {
    cacheRoot: params.cacheRoot,
    topLevelNodeId,
    nestedNodeIds,
    failures,
    debug,
  };
}
