import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { z } from 'zod';

const FigmaLinksSchema = z.object({
  bridge: z
    .object({
      fileKey: z.string().optional().default(''),
    })
    .optional()
    .default({}),
  styleguide: z
    .object({
      colors: z.string().optional().default(''),
      typography: z.string().optional().default(''),
      grid: z.string().optional().default(''),
    })
    .optional()
    .default({}),
  modules: z.record(z.string()).optional().default({}),
});

export type FigmaLinksConfig = z.infer<typeof FigmaLinksSchema>;

export function loadFigmaLinksConfig(configPath: string): FigmaLinksConfig {
  const content = readFileSync(configPath, 'utf-8');
  let raw: unknown;
  try {
    raw = load(content);
  } catch (err) {
    throw new Error(`Failed to parse YAML at ${configPath}: ${String(err)}`);
  }
  const result = FigmaLinksSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid figma-links.yaml at ${configPath}:\n${result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`
    );
  }
  return result.data;
}

export function stripAtPrefix(url: string): string {
  return url.startsWith('@') ? url.slice(1) : url;
}

export function resolveConfigPath(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const idx = argv.indexOf('--config');
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) {
    return argv[idx + 1];
  }
  if (env.FIGMA_MCP_CONFIG?.trim()) return env.FIGMA_MCP_CONFIG;
  return join(process.cwd(), '.cursor/mcp/figma-links.yaml');
}
