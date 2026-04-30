#!/usr/bin/env npx tsx

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_MCP_URL = 'http://127.0.0.1:3845/mcp';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

function readArgValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const endpoint = readArgValue(argv, '--url') ?? DEFAULT_MCP_URL;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client({ name: 'figma-mcp-bridge-check', version: '1.0.0' }, { capabilities: {} });

  const start = Date.now();
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolCount = Array.isArray(tools?.tools) ? tools.tools.length : 0;
    const elapsed = Date.now() - start;

    console.log(c.green('✓ Connected to Figma MCP bridge.'));
    console.log(`  Endpoint: ${c.dim(endpoint)}`);
    console.log(`  Tools: ${c.dim(String(toolCount))}`);
    console.log(`  Roundtrip: ${c.dim(`${elapsed}ms`)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(c.red('✗ Could not connect to Figma MCP bridge.'));
    console.log(`  Endpoint: ${c.dim(endpoint)}`);
    console.log(`  Reason: ${c.yellow(message)}`);
    process.exitCode = 1;
  } finally {
    await transport.close().catch(() => undefined);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(c.red(`✗ ${message}`));
  process.exit(1);
});
