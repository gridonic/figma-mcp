import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
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
  checkedPaths: string[];
  missingFiles: string[];
  message: string;
}

export interface ModuleCacheValidationResult {
  cacheRoot: string;
  topLevelNodeId: string;
  nestedNodeIds: string[];
  failures: ModuleArtifactFailure[];
  debug: string[];
}

export interface ResolvedCacheArtifacts {
  ready: boolean;
  found: string[];
  missing: string[];
  candidates: string[];
  lookupMode: 'direct-fs';
}

const DEFAULT_CACHE_SUBPATH = '.cursor/tmp/figma-mcp-cache';
const CACHE_ROOT_ENV_KEYS = ['FIGMA_MCP_CACHE_ROOT', 'FIGMA_CACHE_ROOT'] as const;

export function normalizeNodeId(nodeId: string): string {
  return nodeId.trim().replace('-', ':');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function nodeIdVariants(nodeId: string): string[] {
  const canonical = normalizeNodeId(nodeId);
  return unique([canonical, canonical.replace(':', '-')]);
}

function requiredArtifactFile(toolName: CacheToolName): string | null {
  if (toolName === 'get_screenshot') return 'image.png';
  if (toolName === 'get_design_context' || toolName === 'get_variable_defs') return 'payload.json';
  return null;
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
  const matches = Array.from(url.matchAll(/[?&][a-z-]*node-id=(\d+)[-:](\d+)/gi));
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

export function resolveCacheArtifacts(
  cacheRoot: string,
  moduleName: string,
  fileKey: string,
  nodeId: string,
  toolName: CacheToolName
): ResolvedCacheArtifacts {
  const requiredFile = requiredArtifactFile(toolName);
  if (!requiredFile) {
    return { ready: true, found: [], missing: [], candidates: [], lookupMode: 'direct-fs' };
  }

  const artifactsRoot = join(cacheRoot, 'artifacts');
  const nodeVariants = nodeIdVariants(nodeId);
  const canonicalNode = normalizeNodeId(nodeId).replace(':', '-');
  const prefixes = unique([
    ...nodeVariants.map((variant) => `${fileKey}__${variant.replace(':', '-')}__${toolName}__`),
    `${fileKey}__${canonicalNode}__${toolName}__`,
    ...nodeVariants.map((variant) => `${moduleName}__${fileKey}__${variant.replace(':', '-')}__${toolName}__`),
    `${moduleName}__${fileKey}__${canonicalNode}__${toolName}__`,
  ]);

  const candidateDirs: string[] = [];
  if (existsSync(artifactsRoot)) {
    const dirEntries = readdirSync(artifactsRoot, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      if (prefixes.some((prefix) => entry.name.startsWith(prefix))) {
        candidateDirs.push(join(artifactsRoot, entry.name));
      }
    }
  }

  // Direct deterministic fallback for canonical key if directory listing misses.
  const canonicalKey = buildCacheKey(toolName, fileKey, nodeId, {});
  candidateDirs.push(join(artifactsRoot, canonicalKey));

  const candidates = unique(candidateDirs);
  const found: string[] = [];
  const missing: string[] = [];
  for (const dir of candidates) {
    const requiredPath = join(dir, requiredFile);
    if (existsSync(requiredPath)) {
      found.push(requiredPath);
    } else {
      missing.push(requiredPath);
    }
  }

  return {
    ready: found.length > 0,
    found,
    missing,
    candidates,
    lookupMode: 'direct-fs',
  };
}

export function validateModuleCache(params: {
  cacheRoot: string;
  moduleName: string;
  figmaUrl: string;
  fileKey: string;
  topLevelNodeId: string;
  requiredTools: CacheToolName[];
  debug?: boolean;
}): ModuleCacheValidationResult {
  const topLevelNodeId = normalizeNodeId(params.topLevelNodeId);
  const parsed = parseFigmaNodeIds(params.figmaUrl);
  const nestedNodeIds = parsed.nestedNodeIds.map(normalizeNodeId).filter((id) => id !== topLevelNodeId);
  const failures: ModuleArtifactFailure[] = [];
  const debug: string[] = [];

  const record = (line: string): void => {
    if (params.debug) debug.push(line);
  };

  record(`cacheRoot=${params.cacheRoot}`);
  record(`moduleName=${params.moduleName}`);
  record(`lookupMode=direct-fs`);
  record(`requested fileKey=${params.fileKey}`);
  record(`topLevelNodeId=${topLevelNodeId}`);
  record(`nestedNodeIds=${nestedNodeIds.join(',') || '(none)'}`);

  for (const toolName of params.requiredTools) {
    const top = resolveCacheArtifacts(params.cacheRoot, params.moduleName, params.fileKey, topLevelNodeId, toolName);
    record(
      `lookup top-level ${toolName} module=${params.moduleName} fileKey=${params.fileKey} node=${topLevelNodeId} ready=${top.ready}`
    );
    for (const candidatePath of top.candidates) record(`candidate top-level ${toolName}: ${candidatePath}`);
    for (const foundPath of top.found) record(`found top-level ${toolName}: ${foundPath}`);
    for (const missingPath of top.missing) record(`missing top-level ${toolName}: ${missingPath}`);
    if (!top.ready) {
      failures.push({
        scope: 'top-level',
        nodeId: topLevelNodeId,
        toolName,
        checkedPaths: top.candidates,
        missingFiles: top.missing,
        message:
          `missing required artifact: ${toolName} for node ${topLevelNodeId} ` +
          `(module=${params.moduleName}, fileKey=${params.fileKey}, cacheRoot=${params.cacheRoot}, lookupMode=${top.lookupMode})`,
      });
    }
  }

  for (const nestedNodeId of nestedNodeIds) {
    for (const toolName of params.requiredTools) {
      const nested = resolveCacheArtifacts(params.cacheRoot, params.moduleName, params.fileKey, nestedNodeId, toolName);
      record(
        `lookup nested ${toolName} module=${params.moduleName} fileKey=${params.fileKey} node=${nestedNodeId} ready=${nested.ready}`
      );
      for (const candidatePath of nested.candidates) record(`candidate nested ${toolName}: ${candidatePath}`);
      for (const foundPath of nested.found) record(`found nested ${toolName}: ${foundPath}`);
      for (const missingPath of nested.missing) record(`missing nested ${toolName}: ${missingPath}`);
      if (!nested.ready) {
        failures.push({
          scope: 'nested',
          nodeId: nestedNodeId,
          toolName,
          checkedPaths: nested.candidates,
          missingFiles: nested.missing,
          message:
            `missing required artifact: ${toolName} for node ${nestedNodeId} ` +
            `(module=${params.moduleName}, fileKey=${params.fileKey}, cacheRoot=${params.cacheRoot}, lookupMode=${nested.lookupMode})`,
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
