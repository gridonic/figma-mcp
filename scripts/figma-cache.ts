#!/usr/bin/env npx tsx

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Project root = wherever the CLI is invoked from (the consuming project)
const ROOT = process.cwd();

const MCP_URL = 'http://127.0.0.1:3845/mcp';
const DEFAULT_CONFIG_PATH = join(ROOT, '.cursor/mcp/figma-links.yaml');
const CACHE_ROOT = join(ROOT, '.cursor/tmp/figma-mcp-cache');
const INDEX_PATH = join(CACHE_ROOT, 'index.json');
const ARTIFACTS_DIR = join(CACHE_ROOT, 'artifacts');

type ToolName =
  | 'get_screenshot'
  | 'get_variable_defs'
  | 'get_design_context'
  | 'get_metadata'
  | 'get_figjam';

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

interface GetCachedOrFetchOptions {
  toolName: ToolName;
  sourceUrl: string;
  nodeId: string;
  extraArgs?: Record<string, unknown>;
  refresh?: boolean;
  allowFetchOnMiss?: boolean;
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

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
  return nodeId.replace('-', ':');
}

function parseFigmaUrl(url: string): { fileKey: string; nodeId: string } {
  const clean = url.replace(/^@/, '');
  const fileKeyMatch = clean.match(/\/design\/([^/]+)/);
  const nodeMatch = clean.match(/[?&]node-id=(\d+)-(\d+)/);
  if (!fileKeyMatch || !nodeMatch) {
    throw new Error(`Could not parse fileKey/nodeId from URL: ${url}`);
  }
  return {
    fileKey: fileKeyMatch[1],
    nodeId: `${nodeMatch[1]}:${nodeMatch[2]}`,
  };
}

function loadTargetsFromConfig(configPath: string): FigmaTarget[] {
  const content = readFileSync(configPath, 'utf-8');
  const lines = content.split('\n');
  const targets: FigmaTarget[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*([a-z0-9-]+):\s*"(@?https?:\/\/[^"]+)"/i);
    if (!m) continue;
    const name = m[1];
    const url = m[2];
    if (!url.includes('figma.com/design/')) continue;
    const parsed = parseFigmaUrl(url);
    targets.push({ name, url: url.replace(/^@/, ''), fileKey: parsed.fileKey, nodeId: parsed.nodeId });
  }
  return targets;
}

function buildCacheKey(toolName: ToolName, fileKey: string, nodeId: string, extraArgs: Record<string, unknown>): string {
  const argsHash = createHash('sha1').update(JSON.stringify(extraArgs)).digest('hex').slice(0, 12);
  return `${fileKey}__${nodeId.replace(':', '-')}__${toolName}__${argsHash}`;
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
    const maybeData = record.data;
    const maybeMime = record.mimeType;
    if (typeof maybeData === 'string' && typeof maybeMime === 'string' && maybeMime.startsWith('image/')) {
      return maybeData;
    }
  }
  return null;
}

async function withMcpClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: 'figma-cache', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

async function callFigmaTool(
  client: Client,
  toolName: ToolName,
  nodeId: string,
  extraArgs: Record<string, unknown>
): Promise<unknown> {
  const result = await client.callTool({
    name: toolName,
    arguments: {
      nodeId: toCanonicalNodeId(nodeId),
      clientLanguages: 'typescript,scss,css,astro',
      clientFrameworks: 'astro',
      ...extraArgs,
    },
  });
  return result;
}

export async function getCachedOrFetch(options: GetCachedOrFetchOptions): Promise<{
  data: unknown;
  fromCache: boolean;
  cacheKey: string;
}> {
  ensureCacheDirs();
  const { fileKey } = parseFigmaUrl(options.sourceUrl);
  const nodeId = toCanonicalNodeId(options.nodeId);
  const extraArgs = options.extraArgs ?? {};
  const argsHash = createHash('sha1').update(JSON.stringify(extraArgs)).digest('hex').slice(0, 12);
  const key = buildCacheKey(options.toolName, fileKey, nodeId, extraArgs);

  const index = loadIndex();
  const existing = index.entries[key];
  if (existing && !options.refresh) {
    return { data: readArtifact(existing), fromCache: true, cacheKey: key };
  }
  if (!existing && !options.refresh && options.allowFetchOnMiss === false) {
    throw new Error(
      `Cache miss for ${options.toolName} ${nodeId}. Re-run with refresh mode to fetch from Figma MCP.`
    );
  }

  const artifactDir = join(ARTIFACTS_DIR, key);
  mkdirSync(artifactDir, { recursive: true });

  const result = await withMcpClient((client) => callFigmaTool(client, options.toolName, nodeId, extraArgs));
  const now = new Date().toISOString();

  let payloadPath: string | undefined;
  let imagePath: string | undefined;

  const resultRecord = result as Record<string, unknown>;
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
    sourceUrl: options.sourceUrl.replace(/^@/, ''),
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

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
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
  });
  console.log(
    `${result.fromCache ? c.yellow('cache') : c.green('fresh')} ${c.dim(toolName)} ${c.dim(node)} ${c.dim(result.cacheKey)}`
  );
  const data = result.data as Record<string, unknown>;
  if (data && typeof data.imagePath === 'string') {
    console.log(c.cyan(`Image: ${data.imagePath}`));
  }
}

async function cmdWarm(parsed: Record<string, string | boolean>): Promise<void> {
  const configPath = typeof parsed.config === 'string' ? parsed.config : DEFAULT_CONFIG_PATH;
  const refresh = parsed.refresh === true;
  const nodeFilter = typeof parsed.node === 'string' ? toCanonicalNodeId(parsed.node) : null;
  const toolFilter = parsed.tool ? readToolName(parsed.tool) : null;
  const tools: ToolName[] = toolFilter
    ? [toolFilter]
    : ['get_screenshot', 'get_variable_defs', 'get_design_context', 'get_metadata'];

  const targets = loadTargetsFromConfig(configPath).filter((t) => (nodeFilter ? t.nodeId === nodeFilter : true));
  if (targets.length === 0) {
    console.log(c.yellow('No Figma links found to warm.'));
    return;
  }

  console.log(c.cyan(`Warming cache for ${targets.length} targets...`));
  for (const target of targets) {
    for (const toolName of tools) {
      try {
        const res = await getCachedOrFetch({
          toolName,
          sourceUrl: target.url,
          nodeId: target.nodeId,
          refresh,
        });
        const state = res.fromCache ? 'cache' : 'fresh';
        console.log(`- ${target.name} ${c.dim(target.nodeId)} ${toolName} ${c.dim(state)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(c.yellow(`- ${target.name} ${toolName} failed: ${msg}`));
      }
    }
  }
}

async function main(): Promise<void> {
  const [command = 'list', ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);

  if (command === 'list') return cmdList();
  if (command === 'clear') return cmdClear();
  if (command === 'get') return cmdGet(parsed);
  if (command === 'warm' || command === 'refresh') {
    if (command === 'refresh') parsed.refresh = true;
    return cmdWarm(parsed);
  }

  console.log('Usage:');
  console.log('  npx figma-mcp cache list');
  console.log('  npx figma-mcp cache clear');
  console.log('  npx figma-mcp cache get --url <figma-url> --node <nodeId> [--tool get_screenshot] [--refresh]');
  console.log('  npx figma-mcp cache warm [--config <path>] [--tool <tool>] [--node <nodeId>] [--refresh]');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
