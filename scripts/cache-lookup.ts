import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
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

export interface ArtifactStatus {
  toolName: CacheToolName;
  ready: boolean;
  found: string[];
  missing: string[];
  candidates: string[];
}

export interface ModuleManifestNode {
  nodeId: string;
  name?: string;
  type?: string;
  path?: string[];
  source: 'source' | 'discovered' | 'hint';
}

export interface ModuleManifest {
  version: 1;
  moduleName: string;
  fileKey: string;
  sourceUrl: string;
  sourceNodeId: string;
  sourceNode: ModuleManifestNode;
  childNodes: ModuleManifestNode[];
  explicitChildNodeHints: string[];
  complete: boolean;
  warnings: string[];
  rawPayloadPaths: string[];
  sharedVariableArtifact?: {
    key: string;
    paths: string[];
  };
  artifacts: Record<string, Partial<Record<CacheToolName, ArtifactStatus>>>;
  updatedAt: string;
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

export function requiredArtifactFile(toolName: CacheToolName): string | null {
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
  const nodeKey = canonicalNodeId.replace(':', '-');
  return `${fileKey}__${nodeKey}__${toolName}__${argsHash}`;
}

export function buildLegacyVariableDefsCacheKey(fileKey: string, extraArgs: Record<string, unknown> = {}): string {
  const argsHash = createHash('sha1').update(JSON.stringify(extraArgs)).digest('hex').slice(0, 12);
  return `${fileKey}__variables__get_variable_defs__${argsHash}`;
}

export function buildManifestPath(cacheRoot: string, moduleName: string, fileKey: string, sourceNodeId: string): string {
  const canonicalNode = normalizeNodeId(sourceNodeId).replace(':', '-');
  return join(cacheRoot, 'manifests', `${moduleName}__${fileKey}__${canonicalNode}.json`);
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
  const legacyKey = toolName === 'get_variable_defs' ? buildLegacyVariableDefsCacheKey(fileKey, extraArgs) : null;
  const candidateKeys = unique([key, ...(legacyKey ? [legacyKey] : [])]);

  for (const candidateKey of candidateKeys) {
    const entry = index.entries[candidateKey];
    if (!entry) continue;
    const payloadExists = entry.payloadPath ? existsSync(entry.payloadPath) : false;
    const imageExists = entry.imagePath ? existsSync(entry.imagePath) : false;
    if (payloadExists || imageExists) {
      return { key: candidateKey, hit: true, source: 'index' };
    }
  }

  for (const candidateKey of candidateKeys) {
    const artifactDir = join(cacheRoot, 'artifacts', candidateKey);
    const hasCanonicalPayload = existsSync(join(artifactDir, 'payload.json'));
    const hasCanonicalImage = existsSync(join(artifactDir, 'image.png'));
    if (hasCanonicalPayload || hasCanonicalImage) {
      return { key: candidateKey, hit: true, source: 'canonical-fallback' };
    }
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
  const variablePrefixes =
    toolName === 'get_variable_defs'
      ? [`${fileKey}__variables__${toolName}__`, `${moduleName}__${fileKey}__variables__${toolName}__`]
      : [];
  const prefixes = unique([
    ...variablePrefixes,
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
  if (toolName === 'get_variable_defs') {
    const legacyKey = buildLegacyVariableDefsCacheKey(fileKey, {});
    candidateDirs.push(join(artifactsRoot, legacyKey));
  }

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

export function getArtifactStatus(
  cacheRoot: string,
  moduleName: string,
  fileKey: string,
  nodeId: string,
  toolName: CacheToolName
): ArtifactStatus {
  const resolved = resolveCacheArtifacts(cacheRoot, moduleName, fileKey, nodeId, toolName);
  return {
    toolName,
    ready: resolved.ready,
    found: resolved.found,
    missing: resolved.missing,
    candidates: resolved.candidates,
  };
}

export function validateSourceNodeCache(params: {
  cacheRoot: string;
  moduleName: string;
  fileKey: string;
  sourceNodeId: string;
  requiredTools: CacheToolName[];
  debug?: boolean;
}): ModuleCacheValidationResult {
  const sourceNodeId = normalizeNodeId(params.sourceNodeId);
  const failures: ModuleArtifactFailure[] = [];
  const debug: string[] = [];

  const record = (line: string): void => {
    if (params.debug) debug.push(line);
  };

  record(`cacheRoot=${params.cacheRoot}`);
  record(`moduleName=${params.moduleName}`);
  record(`lookupMode=direct-fs`);
  record(`requested fileKey=${params.fileKey}`);
  record(`sourceNodeId=${sourceNodeId}`);

  for (const toolName of params.requiredTools) {
    const status = getArtifactStatus(params.cacheRoot, params.moduleName, params.fileKey, sourceNodeId, toolName);
    record(
      `lookup source ${toolName} module=${params.moduleName} fileKey=${params.fileKey} node=${sourceNodeId} ready=${status.ready}`
    );
    for (const candidatePath of status.candidates) record(`candidate source ${toolName}: ${candidatePath}`);
    for (const foundPath of status.found) record(`found source ${toolName}: ${foundPath}`);
    for (const missingPath of status.missing) record(`missing source ${toolName}: ${missingPath}`);
    if (!status.ready) {
      failures.push({
        scope: 'top-level',
        nodeId: sourceNodeId,
        toolName,
        checkedPaths: status.candidates,
        missingFiles: status.missing,
        message:
          `missing required source-node artifact: ${toolName} for node ${sourceNodeId} ` +
          `(module=${params.moduleName}, fileKey=${params.fileKey}, cacheRoot=${params.cacheRoot}, lookupMode=direct-fs)`,
      });
    }
  }

  return {
    cacheRoot: params.cacheRoot,
    topLevelNodeId: sourceNodeId,
    nestedNodeIds: [],
    failures,
    debug,
  };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readTextPayload(value: unknown): unknown {
  const record = toRecord(value);
  const content = Array.isArray(record?.content) ? record.content : [];
  const textParts = content
    .map((item) => {
      const itemRecord = toRecord(item);
      return typeof itemRecord?.text === 'string' ? itemRecord.text : null;
    })
    .filter((text): text is string => Boolean(text));

  for (const text of textParts) {
    try {
      return JSON.parse(text);
    } catch {
      // Keep looking; some MCP text content is plain prose/markdown.
    }
  }

  return value;
}

function readNodeId(record: Record<string, unknown>): string | null {
  const candidates = [record.id, record.nodeId, record.node_id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^\d+[-:]\d+$/.test(candidate.trim())) {
      return normalizeNodeId(candidate);
    }
  }
  return null;
}

function readNodeName(record: Record<string, unknown>): string | undefined {
  return typeof record.name === 'string' ? record.name : undefined;
}

function readNodeType(record: Record<string, unknown>): string | undefined {
  if (typeof record.type === 'string') return record.type;
  if (typeof record.nodeType === 'string') return record.nodeType;
  return undefined;
}

export function discoverChildNodesFromPayload(payload: unknown, sourceNodeId: string): {
  childNodes: ModuleManifestNode[];
  complete: boolean;
  warnings: string[];
} {
  const root = readTextPayload(payload);
  const source = normalizeNodeId(sourceNodeId);
  const discovered = new Map<string, ModuleManifestNode>();
  let visitedObjects = 0;
  let sawStructuredNode = false;

  const visit = (value: unknown, path: string[] = []): void => {
    const record = toRecord(value);
    if (record) {
      visitedObjects += 1;
      const nodeId = readNodeId(record);
      if (nodeId) {
        sawStructuredNode = true;
        if (nodeId !== source && !discovered.has(nodeId)) {
          const name = readNodeName(record);
          const type = readNodeType(record);
          discovered.set(nodeId, {
            nodeId,
            ...(name ? { name } : {}),
            ...(type ? { type } : {}),
            ...(path.length > 0 ? { path } : {}),
            source: 'discovered',
          });
        }
      }

      for (const [key, child] of Object.entries(record)) {
        if (key === 'parent' || key === 'absoluteBoundingBox' || key === 'relativeTransform') continue;
        if (Array.isArray(child)) {
          child.forEach((item, index) => visit(item, [...path, `${key}[${index}]`]));
        } else if (child && typeof child === 'object') {
          visit(child, [...path, key]);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, `[${index}]`]));
    }
  };

  visit(root);

  const warnings: string[] = [];
  if (!sawStructuredNode) {
    warnings.push('Could not discover child nodes from MCP payload; inspect raw payloads before assuming no child nodes exist.');
  }
  if (visitedObjects > 10_000) {
    warnings.push('Stopped short of proving manifest completeness for a large payload; child-node discovery is best effort.');
  }

  return {
    childNodes: [...discovered.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    complete: warnings.length === 0,
    warnings,
  };
}

export function loadModuleManifest(
  cacheRoot: string,
  moduleName: string,
  fileKey: string,
  sourceNodeId: string
): ModuleManifest | null {
  const path = buildManifestPath(cacheRoot, moduleName, fileKey, sourceNodeId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ModuleManifest;
    if (parsed?.version === 1 && parsed.moduleName === moduleName) return parsed;
  } catch {
    // no-op
  }
  return null;
}

export function saveModuleManifest(cacheRoot: string, manifest: ModuleManifest): string {
  const path = buildManifestPath(cacheRoot, manifest.moduleName, manifest.fileKey, manifest.sourceNodeId);
  mkdirSync(join(cacheRoot, 'manifests'), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

export function createModuleManifest(params: {
  cacheRoot: string;
  moduleName: string;
  fileKey: string;
  sourceUrl: string;
  sourceNodeId: string;
  designContext: unknown;
  updatedAt?: string;
}): ModuleManifest {
  const sourceNodeId = normalizeNodeId(params.sourceNodeId);
  const parsed = parseFigmaNodeIds(params.sourceUrl);
  const explicitChildNodeHints = parsed.nestedNodeIds.map(normalizeNodeId).filter((id) => id !== sourceNodeId);
  const discovery = discoverChildNodesFromPayload(params.designContext, sourceNodeId);
  const byId = new Map(discovery.childNodes.map((node) => [node.nodeId, node]));
  for (const hint of explicitChildNodeHints) {
    if (!byId.has(hint)) byId.set(hint, { nodeId: hint, source: 'hint' });
  }

  const sourceNode: ModuleManifestNode = {
    nodeId: sourceNodeId,
    name: params.moduleName,
    source: 'source',
  };
  const childNodes = [...byId.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const nodes = [sourceNode, ...childNodes];
  const tools: CacheToolName[] = ['get_screenshot', 'get_design_context', 'get_variable_defs'];
  const artifacts: ModuleManifest['artifacts'] = {};
  for (const node of nodes) {
    artifacts[node.nodeId] = {};
    for (const toolName of tools) {
      artifacts[node.nodeId]![toolName] = getArtifactStatus(
        params.cacheRoot,
        params.moduleName,
        params.fileKey,
        node.nodeId,
        toolName
      );
    }
  }

  const sourceContext = getArtifactStatus(
    params.cacheRoot,
    params.moduleName,
    params.fileKey,
    sourceNodeId,
    'get_design_context'
  );
  const sharedVariables = getArtifactStatus(
    params.cacheRoot,
    params.moduleName,
    params.fileKey,
    sourceNodeId,
    'get_variable_defs'
  );
  const warnings = [...discovery.warnings];
  if (explicitChildNodeHints.length > 0) {
    warnings.push('Explicit nested node ids were treated as discovery hints, not readiness requirements.');
  }

  return {
    version: 1,
    moduleName: params.moduleName,
    fileKey: params.fileKey,
    sourceUrl: params.sourceUrl,
    sourceNodeId,
    sourceNode,
    childNodes,
    explicitChildNodeHints,
    complete: discovery.complete,
    warnings,
    rawPayloadPaths: sourceContext.found,
    sharedVariableArtifact: sharedVariables.found.length
      ? {
          key: buildCacheKey('get_variable_defs', params.fileKey, sourceNodeId, {}),
          paths: sharedVariables.found,
        }
      : undefined,
    artifacts,
    updatedAt: params.updatedAt ?? new Date().toISOString(),
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
