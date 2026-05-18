#!/usr/bin/env npx tsx

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, join, relative } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildCacheKey,
  buildLegacyVariableDefsCacheKey,
  buildManifestPath,
  createModuleManifest,
  extractFileKey,
  getArtifactStatus,
  loadModuleManifest,
  ModuleManifest,
  normalizeNodeId,
  parseFigmaNodeIds,
  resolveCacheRoot,
  saveModuleManifest,
} from './cache-lookup.js';
import { loadFigmaLinksConfig, resolveConfigPath, stripAtPrefix } from './config-loader.js';

// Project root = wherever the CLI is invoked from (the consuming project)
const ROOT = process.cwd();

const CACHE_ROOT = resolveCacheRoot({ cwd: ROOT });
const INDEX_PATH = join(CACHE_ROOT, 'index.json');
const ARTIFACTS_DIR = join(CACHE_ROOT, 'artifacts');

// ---------------------------------------------------------------------------
// MCP source configuration
// ---------------------------------------------------------------------------

type McpSource = 'desktop' | 'bridge' | 'cloud';

function resolveMcpSource(): McpSource {
  const src = process.env.FIGMA_MCP_SOURCE?.toLowerCase();
  if (src === 'bridge' || src === 'cloud') return src;
  return 'desktop';
}

// Preferred bridge binary path in the consumer project's node_modules.
const BRIDGE_BIN = join(ROOT, 'node_modules', '.bin', 'figma-mcp-bridge');
const DEFAULT_BRIDGE_NPX = 'npx -y @gethopp/figma-mcp-bridge';

const DESKTOP_MCP_URL = process.env.FIGMA_MCP_DESKTOP_URL ?? 'http://127.0.0.1:3845/mcp';
const CLOUD_MCP_URL = process.env.FIGMA_MCP_CLOUD_URL ?? '';

// ---------------------------------------------------------------------------
// Tool types and bridge call translation
// ---------------------------------------------------------------------------

type ToolName =
  | 'get_screenshot'
  | 'get_variable_defs'
  | 'get_design_context'
  | 'get_metadata'
  | 'get_figjam';

interface BridgeToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// Translates a canonical MCP tool call into the equivalent figma-mcp-bridge call.
// The bridge uses the same names for most tools but has different argument shapes
// and operates on the whole document (not per-node) for some tools.
function toBridgeToolCall(canonicalName: ToolName, nodeId: string, bridgeFileKey?: string): BridgeToolCall {
  const canonical = toCanonicalNodeId(nodeId);
  const fk = bridgeFileKey ? { fileKey: bridgeFileKey } : {};
  switch (canonicalName) {
    case 'get_screenshot':
      return { name: 'get_screenshot', arguments: { nodeIds: [canonical], ...fk } };
    case 'get_variable_defs':
      return { name: 'get_variable_defs', arguments: { ...fk } };
    case 'get_design_context':
      return { name: 'get_node', arguments: { nodeId: canonical, ...fk } };
    case 'get_metadata':
      return { name: 'get_metadata', arguments: { ...fk } };
    case 'get_figjam':
      return { name: 'get_document', arguments: { ...fk } };
  }
}

// ---------------------------------------------------------------------------
// Cache index types
// ---------------------------------------------------------------------------

interface CacheIndexEntry {
  key: string;
  toolName: ToolName;
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
  version: 1;
  entries: Record<string, CacheIndexEntry>;
}

interface FigmaTarget {
  name: string;
  url: string;
  fileKey: string;
  nodeId: string;
  kind: 'module' | 'styleguide';
  managed: boolean;
}

export interface GetCachedOrFetchOptions {
  toolName: ToolName;
  sourceUrl: string;
  nodeId: string;
  extraArgs?: Record<string, unknown>;
  refresh?: boolean;
  allowFetchOnMiss?: boolean;
  configPath?: string;
  client?: Client;
  name?: string;
}

// ---------------------------------------------------------------------------
// Colour helpers for terminal output
// ---------------------------------------------------------------------------

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

const TOOL_LABELS: Record<ToolName, string> = {
  get_screenshot: 'screenshot',
  get_variable_defs: 'variables',
  get_design_context: 'design context',
  get_metadata: 'metadata',
  get_figjam: 'figjam',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return iso.slice(0, 10);
}

function artifactSize(path: string | undefined): number {
  if (!path || !existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function artifactDirLabel(artifactDir: string, key: string): string | null {
  const base = basename(artifactDir);
  if (base === key) return null;
  const prefix = base.split('__')[0];
  const fileKey = key.split('__')[0];
  return prefix && prefix !== fileKey ? prefix : null;
}

function formatCacheRootPath(): string {
  const rel = relative(ROOT, CACHE_ROOT);
  return rel && !rel.startsWith('..') ? rel : CACHE_ROOT;
}

function renderArtifactStatus(entry: CacheIndexEntry): { payload: string; image: string; bytes: number } {
  const payloadOk = Boolean(entry.payloadPath && existsSync(entry.payloadPath));
  const imageOk = Boolean(entry.imagePath && existsSync(entry.imagePath));
  const payload = payloadOk ? c.green('json ✓') : c.dim('json ·');
  const image = imageOk ? c.green('img ✓') : c.dim('img ·');
  const bytes = artifactSize(entry.payloadPath) + artifactSize(entry.imagePath);
  return { payload, image, bytes };
}

function renderCacheList(entries: CacheIndexEntry[]): void {
  const byFile = new Map<string, Map<string, CacheIndexEntry[]>>();
  const toolCounts = new Map<ToolName, number>();
  let totalBytes = 0;

  for (const entry of entries) {
    const nodeMap = byFile.get(entry.fileKey) ?? new Map<string, CacheIndexEntry[]>();
    const nodeEntries = nodeMap.get(entry.nodeId) ?? [];
    nodeEntries.push(entry);
    nodeMap.set(entry.nodeId, nodeEntries);
    byFile.set(entry.fileKey, nodeMap);
    toolCounts.set(entry.toolName, (toolCounts.get(entry.toolName) ?? 0) + 1);
    totalBytes += artifactSize(entry.payloadPath) + artifactSize(entry.imagePath);
  }

  const fileKeys = [...byFile.keys()].sort();
  const nodeCount = [...byFile.values()].reduce((sum, nodeMap) => sum + nodeMap.size, 0);
  const toolSummary = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tool, count]) => `${TOOL_LABELS[tool]} ${count}`)
    .join(c.dim(' · '));

  console.log(c.bold('Figma MCP cache'));
  console.log(`${c.dim('Root')} ${formatCacheRootPath()}`);
  console.log(
    `${c.cyan(String(entries.length))} ${entries.length === 1 ? 'entry' : 'entries'}` +
    c.dim(' · ') +
    `${formatBytes(totalBytes)}` +
    c.dim(' · ') +
    `${fileKeys.length} ${fileKeys.length === 1 ? 'file' : 'files'}` +
    c.dim(' · ') +
    `${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'}`
  );
  if (toolSummary) {
    console.log(`${c.dim('Tools')} ${toolSummary}`);
  }
  console.log('');

  for (const [fileIndex, fileKey] of fileKeys.entries()) {
    const nodeMap = byFile.get(fileKey)!;
    const nodeIds = [...nodeMap.keys()].sort();
    const fileEntryCount = nodeIds.reduce((sum, nodeId) => sum + (nodeMap.get(nodeId)?.length ?? 0), 0);
    const filePrefix = fileIndex === fileKeys.length - 1 ? '└' : '├';
    console.log(`${filePrefix}─ ${c.bold('file')} ${fileKey} ${c.dim(`(${fileEntryCount})`)}`);

    for (const [nodeIndex, nodeId] of nodeIds.entries()) {
      const nodeEntries = [...(nodeMap.get(nodeId) ?? [])].sort((a, b) => a.toolName.localeCompare(b.toolName));
      const latest = nodeEntries.reduce(
        (max, entry) => (entry.updatedAt > max ? entry.updatedAt : max),
        nodeEntries[0]?.updatedAt ?? ''
      );
      const label = nodeEntries.map((entry) => artifactDirLabel(entry.artifactDir, entry.key)).find(Boolean);
      const nodePrefix = fileIndex === fileKeys.length - 1 ? ' ' : '│';
      const nodeBranch = nodeIndex === nodeIds.length - 1 ? '└' : '├';
      const nodeMeta = [
        c.bold(nodeId),
        label ? c.cyan(label) : null,
        latest ? c.dim(`updated ${formatAge(latest)}`) : null,
      ]
        .filter(Boolean)
        .join(c.dim(' · '));
      console.log(`${nodePrefix} ${nodeBranch}─ ${nodeMeta}`);

      for (const [toolIndex, entry] of nodeEntries.entries()) {
        const status = renderArtifactStatus(entry);
        const toolPrefix = nodeIndex === nodeIds.length - 1 ? ' ' : '│';
        const toolBranch = toolIndex === nodeEntries.length - 1 ? '└' : '├';
        const toolLine =
          `${TOOL_LABELS[entry.toolName].padEnd(15)} ` +
          `${status.image}  ${status.payload}  ` +
          `${c.dim(formatAge(entry.updatedAt))}  ` +
          `${c.dim(formatBytes(status.bytes))}`;
        console.log(`${toolPrefix}   ${toolBranch}─ ${toolLine}`);
      }
    }

    if (fileIndex < fileKeys.length - 1) {
      console.log('');
    }
  }
}

// ---------------------------------------------------------------------------
// Cache index helpers
// ---------------------------------------------------------------------------

function ensureCacheDirs(): void {
  mkdirSync(CACHE_ROOT, { recursive: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function loadIndex(): CacheIndex {
  ensureCacheDirs();
  try {
    const raw = readFileSync(INDEX_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as CacheIndex;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch {
    // no-op
  }
  return { version: 1, entries: {} };
}

function saveIndex(index: CacheIndex): void {
  ensureCacheDirs();
  writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function toCanonicalNodeId(nodeId: string): string {
  return normalizeNodeId(nodeId);
}

function parseFigmaUrl(url: string): { fileKey: string; nodeId: string } {
  const clean = stripAtPrefix(url);
  const fileKey = extractFileKey(clean);
  const { topLevelNodeId } = parseFigmaNodeIds(clean);
  return { fileKey, nodeId: topLevelNodeId };
}

function loadTargetsFromConfig(configPath: string): FigmaTarget[] {
  const config = loadFigmaLinksConfig(configPath);
  const targets: FigmaTarget[] = [];

  for (const [name, rawUrl] of Object.entries(config.styleguide ?? {})) {
    if (!rawUrl || !rawUrl.includes('figma.com/design/')) continue;
    const managed = rawUrl.startsWith('@');
    const url = stripAtPrefix(rawUrl);
    try {
      const parsed = parseFigmaUrl(url);
      targets.push({ name, url, fileKey: parsed.fileKey, nodeId: parsed.nodeId, kind: 'styleguide', managed });
    } catch {
      // skip entries with unparseable URLs
    }
  }

  for (const [name, rawUrl] of Object.entries(config.modules ?? {})) {
    if (!rawUrl || !rawUrl.startsWith('@') || !rawUrl.includes('figma.com/design/')) continue;
    const url = stripAtPrefix(rawUrl);
    try {
      const parsed = parseFigmaUrl(url);
      targets.push({ name, url, fileKey: parsed.fileKey, nodeId: parsed.nodeId, kind: 'module', managed: true });
    } catch {
      // skip entries with unparseable URLs
    }
  }

  return targets;
}

function readArtifact(entry: CacheIndexEntry): unknown {
  if (entry.payloadPath) {
    return JSON.parse(readFileSync(entry.payloadPath, 'utf-8'));
  }
  if (entry.imagePath) {
    return { imagePath: entry.imagePath };
  }
  return null;
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

function readNodeId(value: unknown): string | null {
  const record = toRecord(value);
  if (!record) return null;
  const candidate = [record.id, record.nodeId, record.node_id].find((entry) => typeof entry === 'string');
  if (typeof candidate !== 'string') return null;
  const normalized = normalizeNodeId(candidate.trim());
  return /^\d+:\d+$/.test(normalized) ? normalized : null;
}

function collectTextFragments(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextFragments(item, out);
    return;
  }
  const record = toRecord(value);
  if (!record) return;
  for (const child of Object.values(record)) {
    collectTextFragments(child, out);
  }
}

function extractNodeIdsFromText(text: string): string[] {
  const ids = new Set<string>();
  const matches = text.matchAll(/\b(\d+[-:]\d+)\b/g);
  for (const match of matches) {
    const normalized = normalizeNodeId(match[1]);
    if (/^\d+:\d+$/.test(normalized)) ids.add(normalized);
  }
  return [...ids];
}

export interface SparseDesignContextAnalysis {
  isSparse: boolean;
  reasons: string[];
  directChildNodeIds: string[];
}

export function analyzeSparseDesignContext(payload: unknown, sourceNodeId: string): SparseDesignContextAnalysis {
  const root = readTextPayload(payload);
  const source = normalizeNodeId(sourceNodeId);
  const reasons = new Set<string>();
  const directChildren = new Map<string, Record<string, unknown>>();
  const textFragments: string[] = [];
  collectTextFragments(payload, textFragments);

  const visit = (value: unknown): void => {
    const record = toRecord(value);
    if (!record) {
      if (Array.isArray(value)) value.forEach(visit);
      return;
    }

    const recordNodeId = readNodeId(record);
    const children = Array.isArray(record.children) ? record.children : [];
    if (recordNodeId === source && children.length > 0) {
      for (const child of children) {
        const childRecord = toRecord(child);
        const childId = readNodeId(childRecord);
        if (childId && childId !== source) {
          directChildren.set(childId, childRecord ?? { id: childId });
        }
      }
    }

    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(root);

  const hintRegexes = [
    /get_design_context/i,
    /(must|should|need|required|call).{0,40}(individual|individually|sublayer|sub-layer|child|children|node)/i,
  ];
  const combinedText = textFragments.join('\n');
  if (hintRegexes.every((rx) => rx.test(combinedText))) {
    reasons.add('instruction-text-hint');
  }

  const childEntries = [...directChildren.entries()];
  if (childEntries.length > 0) {
    const richKeys = new Set([
      'fills',
      'strokes',
      'characters',
      'layoutMode',
      'absoluteBoundingBox',
      'style',
      'componentProperties',
      'constraints',
      'effects',
    ]);
    const structurallySparse = childEntries.every(([, child]) => {
      const keys = Object.keys(child);
      const hasRichKey = keys.some((key) => richKeys.has(key));
      const hasNestedChildren = Array.isArray(child.children) && child.children.length > 0;
      return !hasRichKey && !hasNestedChildren && keys.length <= 6;
    });
    if (structurallySparse) reasons.add('structural-minimal-children');
  }

  const fallbackIds = reasons.has('instruction-text-hint') ? extractNodeIdsFromText(combinedText) : [];
  const directChildNodeIds = new Set<string>([...directChildren.keys(), ...fallbackIds]);
  directChildNodeIds.delete(source);

  return {
    isSparse: reasons.size > 0,
    reasons: [...reasons],
    directChildNodeIds: [...directChildNodeIds].sort((a, b) => a.localeCompare(b)),
  };
}

export interface SparseChildWarmResult {
  sparseDetected: boolean;
  sparseReasons: string[];
  childNodeIds: string[];
  autoFetchedChildNodeIds: string[];
  missingChildNodeIds: string[];
  warnings: string[];
}

export async function warmSparseChildDesignContexts(params: {
  analysis: SparseDesignContextAnalysis;
  cacheRoot: string;
  moduleName: string;
  fileKey: string;
  fetchDesignContext: (nodeId: string) => Promise<{ fromCache: boolean }>;
}): Promise<SparseChildWarmResult> {
  const result: SparseChildWarmResult = {
    sparseDetected: params.analysis.isSparse,
    sparseReasons: params.analysis.reasons,
    childNodeIds: [...params.analysis.directChildNodeIds],
    autoFetchedChildNodeIds: [],
    missingChildNodeIds: [],
    warnings: [],
  };
  if (!params.analysis.isSparse || params.analysis.directChildNodeIds.length === 0) return result;

  for (const childNodeId of params.analysis.directChildNodeIds) {
    const status = getArtifactStatus(params.cacheRoot, params.moduleName, params.fileKey, childNodeId, 'get_design_context');
    if (status.ready) continue;
    try {
      await params.fetchDesignContext(childNodeId);
      result.autoFetchedChildNodeIds.push(childNodeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.missingChildNodeIds.push(childNodeId);
      result.warnings.push(`child ${childNodeId}: ${message}`);
    }
  }

  return result;
}

function renderManifestSummary(manifest: ModuleManifest): void {
  const status = manifest.complete ? c.green('complete') : c.yellow('partial');
  console.log(`${c.bold(manifest.moduleName)} ${status}`);
  console.log(`${c.dim('Source')} ${manifest.sourceNodeId} ${c.dim(manifest.fileKey)}`);
  console.log(`${c.dim('Children')} ${manifest.childNodes.length}`);
  if (manifest.sparseDetection?.detected) {
    console.log(`${c.dim('Sparse')} ${manifest.sparseDetection.reasons.join(', ') || 'detected'}`);
  }
  if ((manifest.autoFetchedChildNodes?.length ?? 0) > 0) {
    console.log(`${c.dim('Auto-fetched children')} ${manifest.autoFetchedChildNodes.join(', ')}`);
  }
  if ((manifest.missingChildNodes?.length ?? 0) > 0) {
    console.log(`${c.yellow('Missing children')} ${manifest.missingChildNodes.join(', ')}`);
  }
  if ((manifest.incompleteReasons?.length ?? 0) > 0) {
    for (const reason of manifest.incompleteReasons) {
      console.log(`${c.yellow('incomplete')} ${reason}`);
    }
  }
  if (manifest.sharedVariableArtifact) {
    console.log(`${c.dim('Variables')} ${manifest.sharedVariableArtifact.paths.join(', ')}`);
  }
  for (const warning of manifest.warnings) {
    console.log(`${c.yellow('warning')} ${warning}`);
  }
}

function extractBase64Image(content: unknown[]): string | null {
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;

    // Official Figma MCP: { type: "image", data: "<base64>", mimeType: "image/png" }
    if (typeof record.data === 'string' && typeof record.mimeType === 'string' && record.mimeType.startsWith('image/')) {
      return record.data;
    }

    // figma-mcp-bridge: { type: "text", text: '{"exports":[{"base64":"..."}]}' }
    if (record.type === 'text' && typeof record.text === 'string') {
      try {
        const parsed = JSON.parse(record.text) as Record<string, unknown>;
        const exports = Array.isArray(parsed.exports) ? parsed.exports : null;
        const first = exports?.[0] as Record<string, unknown> | undefined;
        if (typeof first?.base64 === 'string') return first.base64;
      } catch {
        // not a bridge screenshot payload — continue
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

function createTransport(source: McpSource) {
  if (source === 'bridge') {
    const bridgeCmd = process.env.FIGMA_MCP_BRIDGE_CMD?.trim();
    if (bridgeCmd) {
      return new StdioClientTransport({
        command: 'sh',
        args: ['-lc', bridgeCmd],
        stderr: 'inherit',
      });
    }
    if (existsSync(BRIDGE_BIN)) {
      return new StdioClientTransport({
        command: BRIDGE_BIN,
        args: [],
        stderr: 'inherit',
      });
    }
    // The bridge uses stdio transport. It runs leader-election on port 1994:
    // if `npm run figma:bridge` is already running (and the Figma plugin is connected),
    // this subprocess becomes a follower and proxies requests through the leader.
    return new StdioClientTransport({
      command: 'sh',
      args: ['-lc', DEFAULT_BRIDGE_NPX],
      stderr: 'inherit',
    });
  }

  const url = source === 'cloud' ? CLOUD_MCP_URL : DESKTOP_MCP_URL;
  if (!url) {
    throw new Error(
      `No MCP URL configured for source "${source}". Set FIGMA_MCP_${source.toUpperCase()}_URL env var.`
    );
  }
  return new StreamableHTTPClientTransport(new URL(url));
}

export async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const source = resolveMcpSource();
  const transport = createTransport(source);
  const client = new Client({ name: 'figma-cache', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (error) {
    const maybeErr = error as NodeJS.ErrnoException;
    if (source === 'bridge' && maybeErr?.code === 'ENOENT') {
      throw new Error(
        'FIGMA_MCP_SOURCE=bridge could not start the bridge process. Set FIGMA_MCP_BRIDGE_CMD to a valid command (example: "npx -y @gethopp/figma-mcp-bridge"), or use FIGMA_MCP_SOURCE=desktop.'
      );
    }
    throw error;
  }
  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

async function callFigmaTool(
  client: Client,
  canonicalToolName: ToolName,
  nodeId: string,
  extraArgs: Record<string, unknown>,
  bridgeFileKey?: string
): Promise<unknown> {
  const source = resolveMcpSource();

  if (source === 'bridge') {
    const bridgeCall = toBridgeToolCall(canonicalToolName, nodeId, bridgeFileKey);
    return client.callTool({ name: bridgeCall.name, arguments: bridgeCall.arguments });
  }

  // Official Figma MCP (desktop / cloud)
  return client.callTool({
    name: canonicalToolName,
    arguments: {
      nodeId: toCanonicalNodeId(nodeId),
      clientLanguages: 'typescript,scss,css,astro',
      clientFrameworks: 'astro',
      ...extraArgs,
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getCachedOrFetch(options: GetCachedOrFetchOptions): Promise<{
  data: unknown;
  fromCache: boolean;
  cacheKey: string;
}> {
  ensureCacheDirs();
  const { fileKey } = parseFigmaUrl(options.sourceUrl);
  const nodeId = toCanonicalNodeId(options.nodeId);
  const extraArgs = options.extraArgs ?? {};
  const key = buildCacheKey(options.toolName, fileKey, nodeId, extraArgs);
  const legacyKey =
    options.toolName === 'get_variable_defs' ? buildLegacyVariableDefsCacheKey(fileKey, extraArgs) : undefined;
  const argsHash = key.split('__').at(-1) ?? '';

  const index = loadIndex();
  const existing = index.entries[key];
  const legacy = legacyKey ? index.entries[legacyKey] : undefined;
  if (existing && !options.refresh) {
    return { data: readArtifact(existing), fromCache: true, cacheKey: key };
  }
  if (legacy && !options.refresh) {
    return { data: readArtifact(legacy), fromCache: true, cacheKey: legacy.key };
  }
  if (!existing && !legacy && !options.refresh && !options.allowFetchOnMiss) {
    throw new Error(
      `Cache miss for ${options.toolName} ${nodeId}. Re-run with refresh mode or set allowFetchOnMiss to fetch from MCP.`
    );
  }

  const dirName = options.name ? `${options.name}__${key}` : key;
  const artifactDir = join(ARTIFACTS_DIR, dirName);
  mkdirSync(artifactDir, { recursive: true });

  const configPath = options.configPath ?? resolveConfigPath(process.argv.slice(2));
  const config = loadFigmaLinksConfig(configPath);
  const bridgeFileKey = config.bridge?.fileKey || undefined;

  const callWithClient = (client: Client) => callFigmaTool(client, options.toolName, nodeId, extraArgs, bridgeFileKey);
  const result = options.client
    ? await callWithClient(options.client)
    : await withMcpClient(callWithClient);
  const now = new Date().toISOString();

  let payloadPath: string | undefined;
  let imagePath: string | undefined;

  const resultRecord = result as Record<string, unknown>;

  if (resultRecord.isError === true) {
    const content = Array.isArray(resultRecord.content) ? (resultRecord.content as unknown[]) : [];
    const firstText = (content[0] as Record<string, unknown>)?.text;
    const msg = typeof firstText === 'string' ? firstText : 'MCP tool returned an error';
    throw new Error(
      `[${options.toolName}] ${msg}${msg.toLowerCase().includes('not found') ? ' — is Figma open on the correct page?' : ''}`
    );
  }

  const content = Array.isArray(resultRecord.content) ? (resultRecord.content as unknown[]) : [];
  const maybeBase64 = extractBase64Image(content);
  if (maybeBase64) {
    imagePath = join(artifactDir, 'image.png');
    writeFileSync(imagePath, Buffer.from(maybeBase64, 'base64'));
  }

  payloadPath = join(artifactDir, 'payload.json');
  writeFileSync(payloadPath, JSON.stringify(result, null, 2));

  const entry: CacheIndexEntry = {
    key,
    toolName: options.toolName,
    fileKey,
    nodeId,
    sourceUrl: stripAtPrefix(options.sourceUrl),
    argsHash,
    artifactDir,
    payloadPath,
    imagePath,
    createdAt: existing?.createdAt ?? legacy?.createdAt ?? now,
    updatedAt: now,
    manualRefreshOnly: true,
  };

  index.entries[key] = entry;
  saveIndex(index);

  return {
    data: imagePath ? { imagePath, result } : result,
    fromCache: false,
    cacheKey: key,
  };
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function readToolName(value: string | boolean | undefined): ToolName {
  const tool = value || 'get_screenshot';
  if (
    tool !== 'get_screenshot' &&
    tool !== 'get_variable_defs' &&
    tool !== 'get_design_context' &&
    tool !== 'get_metadata' &&
    tool !== 'get_figjam'
  ) {
    throw new Error(`Unsupported tool: ${String(value)}`);
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(): Promise<void> {
  const index = loadIndex();
  const entries = Object.values(index.entries);
  if (entries.length === 0) {
    console.log(c.yellow('Cache is empty.'));
    console.log(c.dim(`Root: ${formatCacheRootPath()}`));
    return;
  }
  renderCacheList(entries);
}

async function cmdClear(): Promise<void> {
  rmSync(CACHE_ROOT, { recursive: true, force: true });
  console.log(c.green('Cleared Figma cache.'));
}

async function cmdGet(parsed: Record<string, string | boolean>): Promise<void> {
  const url = parsed.url;
  const node = parsed.node;
  if (typeof url !== 'string' || typeof node !== 'string') {
    throw new Error('get requires --url and --node');
  }
  const refresh = parsed.refresh === true;
  const toolName = readToolName(parsed.tool);
  const result = await getCachedOrFetch({
    toolName,
    sourceUrl: url,
    nodeId: node,
    refresh,
    allowFetchOnMiss: true,
  });
  console.log(
    `${result.fromCache ? c.yellow('cache') : c.green('fresh')} ${c.dim(toolName)} ${c.dim(node)} ${c.dim(result.cacheKey)}`
  );
  const data = result.data as Record<string, unknown>;
  if (data && typeof data.imagePath === 'string') {
    console.log(c.cyan(`Image: ${data.imagePath}`));
  }
}

async function cmdWarm(parsed: Record<string, string | boolean>, argv: string[]): Promise<void> {
  const configPath = typeof parsed.config === 'string' ? parsed.config : resolveConfigPath(argv);
  const refresh = parsed.refresh === true;
  const nodeFilter = typeof parsed.node === 'string' ? toCanonicalNodeId(parsed.node) : null;
  const toolFilter = parsed.tool ? readToolName(parsed.tool) : null;
  const defaultModuleTools: ToolName[] = ['get_screenshot', 'get_variable_defs', 'get_design_context', 'get_metadata'];
  const defaultStyleguideTools: ToolName[] = ['get_variable_defs'];

  const source = resolveMcpSource();
  console.log(c.dim(`MCP source: ${source}`));

  const targets = loadTargetsFromConfig(configPath).filter((t) => (nodeFilter ? t.nodeId === nodeFilter : true));
  if (targets.length === 0) {
    console.log(c.yellow('No Figma links found to warm.'));
    return;
  }

  console.log(c.cyan(`Warming cache for ${targets.length} targets...`));

  const runWarm = async (client?: Client) => {
    for (const target of targets) {
      const tools = toolFilter ? [toolFilter] : target.kind === 'styleguide' ? defaultStyleguideTools : defaultModuleTools;
      let designContext: unknown | null = null;
      for (const toolName of tools) {
        try {
          const res = await getCachedOrFetch({
            toolName,
            sourceUrl: target.url,
            nodeId: target.nodeId,
            refresh,
            allowFetchOnMiss: true,
            configPath,
            client,
            name: target.name,
          });
          if (toolName === 'get_design_context') {
            designContext = res.data;
          }
          const state = res.fromCache ? 'cache' : 'fresh';
          const label = target.kind === 'module' ? 'source' : 'styleguide';
          console.log(`- ${target.name} ${c.dim(label)} ${c.dim(target.nodeId)} ${toolName} ${c.dim(state)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(c.yellow(`- ${target.name} ${toolName} failed: ${msg}`));
        }
      }
      if (target.kind === 'module' && designContext) {
        const sparse = analyzeSparseDesignContext(designContext, target.nodeId);
        if (sparse.isSparse && sparse.directChildNodeIds.length > 0) {
          console.log(`  ${c.dim('sparse source')} ${target.name} ${c.dim(sparse.reasons.join(', '))}`);
          console.log(`  ${c.dim('child warm')} ${sparse.directChildNodeIds.length} direct nodes ${c.dim('(get_design_context)')}`);
        }
        const sparseWarm = await warmSparseChildDesignContexts({
          analysis: sparse,
          cacheRoot: CACHE_ROOT,
          moduleName: target.name,
          fileKey: target.fileKey,
          fetchDesignContext: async (childNodeId) =>
            getCachedOrFetch({
              toolName: 'get_design_context',
              sourceUrl: target.url,
              nodeId: childNodeId,
              refresh: false,
              allowFetchOnMiss: true,
              configPath,
              client,
              name: target.name,
            }),
        });
        for (const childNodeId of sparseWarm.autoFetchedChildNodeIds) {
          console.log(`  - ${target.name} ${c.dim('child')} ${c.dim(childNodeId)} get_design_context ${c.dim('fresh')}`);
        }
        for (const missing of sparseWarm.missingChildNodeIds) {
          console.log(c.yellow(`  - ${target.name} child ${missing} get_design_context failed`));
        }
        for (const warning of sparseWarm.warnings) {
          console.log(`  ${c.yellow('warning')} ${warning}`);
        }

        const manifest = createModuleManifest({
          moduleName: target.name,
          fileKey: target.fileKey,
          sourceUrl: target.url,
          sourceNodeId: target.nodeId,
          designContext,
          cacheRoot: CACHE_ROOT,
          sparseChildNodeHints: sparseWarm.childNodeIds,
          autoFetchedChildNodes: sparseWarm.autoFetchedChildNodeIds,
          missingChildNodes: sparseWarm.missingChildNodeIds,
          sparseDetectionReasons: sparseWarm.sparseReasons,
        });

        const manifestPath = saveModuleManifest(CACHE_ROOT, manifest);
        console.log(
          `  ${c.green('manifest')} ${target.name} ${manifest.complete ? c.dim('complete') : c.yellow('partial')} ${c.dim(manifestPath)}`
        );
        for (const warning of manifest.warnings) {
          console.log(`  ${c.yellow('warning')} ${warning}`);
        }
      }
    }
  };

  // Single MCP connection for the entire warm run — cache hits short-circuit before using the client.
  await withMcpClient((client) => runWarm(client));
}

function inspectTarget(target: FigmaTarget): Record<string, unknown> {
  const sourceNodeId = normalizeNodeId(target.nodeId);
  const manifest =
    target.kind === 'module' ? loadModuleManifest(CACHE_ROOT, target.name, target.fileKey, sourceNodeId) : null;
  const sourceArtifacts = {
    get_screenshot: getArtifactStatus(CACHE_ROOT, target.name, target.fileKey, sourceNodeId, 'get_screenshot'),
    get_design_context: getArtifactStatus(CACHE_ROOT, target.name, target.fileKey, sourceNodeId, 'get_design_context'),
    get_variable_defs: getArtifactStatus(CACHE_ROOT, target.name, target.fileKey, sourceNodeId, 'get_variable_defs'),
  };
  return {
    name: target.name,
    kind: target.kind,
    fileKey: target.fileKey,
    sourceUrl: target.url,
    sourceNodeId,
    sourceArtifacts,
    manifest,
    manifestPath:
      manifest && target.kind === 'module' ? buildManifestPath(CACHE_ROOT, target.name, target.fileKey, sourceNodeId) : null,
    lazyFetch: {
      command: `npx figma-mcp cache get --url "${target.url}" --node <child-node-id> --tool get_design_context`,
      note: 'Fetch missing child-node detail through cache get; use --refresh only when the Figma source should be refreshed.',
    },
  };
}

async function cmdInspect(parsed: Record<string, string | boolean>, argv: string[]): Promise<void> {
  const configPath = typeof parsed.config === 'string' ? parsed.config : resolveConfigPath(argv);
  const skipValues = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      skipValues.add(argv[i + 1]);
    }
  }
  const moduleName = argv.find((arg) => !arg.startsWith('--') && !skipValues.has(arg));
  const asJson = parsed.json === true;
  const targets = loadTargetsFromConfig(configPath).filter((target) => target.kind === 'module');
  const selected = moduleName ? targets.filter((target) => target.name === moduleName) : targets;

  if (selected.length === 0) {
    throw new Error(
      moduleName
        ? `No managed module source node named "${moduleName}" found in ${configPath}.`
        : `No managed module source nodes found in ${configPath}.`
    );
  }

  const inspected = selected.map(inspectTarget);
  if (asJson) {
    console.log(JSON.stringify(moduleName ? inspected[0] : inspected, null, 2));
    return;
  }

  for (const item of inspected) {
    const manifest = item.manifest as ModuleManifest | null;
    if (!manifest) {
      console.log(`${c.bold(String(item.name))} ${c.yellow('missing manifest')}`);
      console.log(`${c.dim('Source')} ${String(item.sourceNodeId)} ${c.dim(String(item.fileKey))}`);
      console.log(c.dim(`Run: npx figma-mcp cache warm --node ${String(item.sourceNodeId)}`));
      console.log('');
      continue;
    }
    renderManifestSummary(manifest);
    console.log(c.dim((item.lazyFetch as Record<string, string>).command));
    console.log('');
  }
}

async function main(): Promise<void> {
  const [command = 'list', ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);

  if (command === 'list') return cmdList();
  if (command === 'clear') return cmdClear();
  if (command === 'get') return cmdGet(parsed);
  if (command === 'inspect') return cmdInspect(parsed, rest);
  if (command === 'warm' || command === 'refresh') {
    if (command === 'refresh') parsed.refresh = true;
    return cmdWarm(parsed, rest);
  }

  console.log('Usage:');
  console.log('  npx figma-mcp cache list');
  console.log('  npx figma-mcp cache clear');
  console.log('  npx figma-mcp cache inspect [module] [--json]');
  console.log('  npx figma-mcp cache get --url <figma-url> --node <nodeId> [--tool get_screenshot] [--refresh]');
  console.log('  npx figma-mcp cache warm [--config <path>] [--tool <tool>] [--node <nodeId>] [--refresh]');
  console.log('');
  console.log('  Set FIGMA_MCP_SOURCE=bridge|desktop|cloud to choose the MCP source.');
  console.log('  Optional: set FIGMA_MCP_BRIDGE_CMD (default: npx -y @gethopp/figma-mcp-bridge).');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
