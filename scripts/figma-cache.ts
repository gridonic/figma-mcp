#!/usr/bin/env npx tsx

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildCacheKey, extractFileKey, normalizeNodeId, parseFigmaNodeIds, resolveCacheRoot } from './cache-lookup.js';
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
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

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

  const allEntries: Array<[string, string]> = [
    ...Object.entries(config.styleguide ?? {}),
    ...Object.entries(config.modules ?? {}),
  ];

  for (const [name, rawUrl] of allEntries) {
    if (!rawUrl || !rawUrl.includes('figma.com/design/')) continue;
    const url = stripAtPrefix(rawUrl);
    try {
      const parsed = parseFigmaUrl(url);
      targets.push({ name, url, fileKey: parsed.fileKey, nodeId: parsed.nodeId });
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
  const argsHash = key.split('__').at(-1) ?? '';

  const index = loadIndex();
  const existing = index.entries[key];
  if (existing && !options.refresh) {
    return { data: readArtifact(existing), fromCache: true, cacheKey: key };
  }
  if (!existing && !options.refresh && !options.allowFetchOnMiss) {
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
    createdAt: existing?.createdAt ?? now,
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
    return;
  }
  console.log(c.cyan(`Cached entries: ${entries.length}`));
  for (const e of entries) {
    const hasImage = e.imagePath ? 'image' : 'no-image';
    console.log(`- ${e.toolName} ${c.dim(e.nodeId)} ${c.dim(e.updatedAt)} ${c.dim(hasImage)} ${c.dim(e.key)}`);
  }
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
  const tools: ToolName[] = toolFilter
    ? [toolFilter]
    : ['get_screenshot', 'get_variable_defs', 'get_design_context', 'get_metadata'];

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
          const state = res.fromCache ? 'cache' : 'fresh';
          console.log(`- ${target.name} ${c.dim(target.nodeId)} ${toolName} ${c.dim(state)}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(c.yellow(`- ${target.name} ${toolName} failed: ${msg}`));
        }
      }
    }
  };

  // Single MCP connection for the entire warm run — cache hits short-circuit before using the client.
  await withMcpClient((client) => runWarm(client));
}

async function main(): Promise<void> {
  const [command = 'list', ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);

  if (command === 'list') return cmdList();
  if (command === 'clear') return cmdClear();
  if (command === 'get') return cmdGet(parsed);
  if (command === 'warm' || command === 'refresh') {
    if (command === 'refresh') parsed.refresh = true;
    return cmdWarm(parsed, rest);
  }

  console.log('Usage:');
  console.log('  npx figma-mcp cache list');
  console.log('  npx figma-mcp cache clear');
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
