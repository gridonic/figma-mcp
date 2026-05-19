#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Package root (inside node_modules/figma-mcp when installed)
const PACKAGE_ROOT = join(__dirname, '..');
// Consuming project root
const PROJECT_ROOT = process.cwd();

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const command = process.argv[2];
const args = process.argv.slice(3);

async function runCommand() {
  switch (command) {
    case 'init':
      await cmdInit();
      break;
    case 'upgrade':
      await cmdUpgrade(args);
      break;
    case 'cache':
      cmdDelegateToScript('figma-cache.ts', args);
      break;
    case 'bridge':
      await cmdBridge(args);
      break;
    case 'tokens':
      if (args[0] === 'sync') {
        cmdDelegateToScript('sync-design-tokens.ts', args.slice(1));
      } else {
        console.log(c.yellow(`⚠️  Unknown tokens subcommand: ${args[0] || '(none)'}\n`));
        console.log('Usage: npx figma-mcp tokens sync [-y] [--refresh]');
      }
      break;
    case 'tokens:sync':
      cmdDelegateToScript('sync-design-tokens.ts', args);
      break;
    case 'modules':
      if (args[0] === 'setup') {
        cmdDelegateToScript('modules-setup.ts', args.slice(1));
      } else {
        console.log(c.yellow(`⚠️  Unknown modules subcommand: ${args[0] || '(none)'}\n`));
        console.log('Usage: npx figma-mcp modules setup');
      }
      break;
    case 'modules:setup':
      cmdDelegateToScript('modules-setup.ts', args);
      break;
    case 'info':
      cmdInfo();
      break;
    default:
      if (command && command !== 'help') {
        console.log(c.yellow(`⚠️  Command not found: ${command}\n`));
      }
      cmdHelp();
      break;
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function cmdInit() {
  console.log(c.bold('\n⭐️ figma-mcp init\n'));

  const rulesCopied = copyCursorRules();
  const skillsCopied = copyClaudeSkills();
  const configCreated = createConfigTemplate();
  const scriptsAdded = addNpmScripts();

  console.log('');
  if (rulesCopied + skillsCopied + scriptsAdded + (configCreated ? 1 : 0) === 0) {
    console.log(c.green('✓ Already up to date — nothing to do.'));
  } else {
    console.log(c.green('✓ Done.'));
    if (configCreated) {
      console.log(
        `\n${c.cyan('Next:')} Fill in your Figma node URLs in ${c.dim('.cursor/mcp/figma.config.yaml')}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// upgrade
// ---------------------------------------------------------------------------

async function cmdUpgrade(args) {
  const rulesOnly = args.includes('--rules-only');
  const installedVersion = getPackageVersion();
  const latestTag = getLatestRemoteVersionTag();
  const latestVersion = latestTag?.replace(/^v/, '') ?? null;

  console.log(c.bold('\n⭐️ figma-mcp upgrade\n'));
  console.log(`  current: v${installedVersion}`);
  if (latestTag) {
    console.log(`  latest:  ${latestTag}\n`);
  } else {
    console.log(`  latest:  ${c.dim('(no version tags found; using main branch)')}\n`);
  }

  if (!rulesOnly) {
    if (latestVersion && installedVersion === latestVersion) {
      console.log(c.green('✓ figma-mcp is already on the latest published version.'));
    } else {
      const installTarget = latestTag
        ? `figma-mcp@github:gridonic/figma-mcp#${latestTag}`
        : 'figma-mcp@github:gridonic/figma-mcp';
      console.log(`🔄 Installing ${installTarget} ...`);
      execSync(`npm install "${installTarget}"`, {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      });
      console.log(c.green(`\n✓ Updated figma-mcp${latestTag ? ` to ${latestTag}` : ''}`));
    }
  } else {
    console.log(c.dim('Skipping package install (--rules-only).'));
  }

  const ruleCount = copyCursorRules();
  const skillCount = rulesOnly ? 0 : copyClaudeSkills();
  console.log('');
  if (ruleCount === 0 && skillCount === 0) {
    console.log(
      c.green(
        rulesOnly
          ? '✓ Cursor rules already up to date.'
          : '✓ Cursor rules and Claude skills already up to date.'
      )
    );
    return;
  }
  const parts = [];
  if (ruleCount > 0) parts.push(`${ruleCount} cursor rule(s)`);
  if (skillCount > 0) parts.push(`${skillCount} Claude skill folder(s)`);
  console.log(c.green(`✓ Upgraded ${parts.join(' and ')}.`));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function copyCursorRules() {
  const sourceRulesPath = join(PACKAGE_ROOT, '.cursor/rules');
  const targetRulesPath = join(PROJECT_ROOT, '.cursor/rules');

  if (!existsSync(sourceRulesPath)) {
    console.log(c.yellow('⚠️  No cursor rules found in package, skipping.'));
    return 0;
  }

  mkdirSync(targetRulesPath, { recursive: true });

  const ruleFiles = readdirSync(sourceRulesPath).filter(
    (f) => (f.startsWith('figma-mcp-') || f === 'figma-design-module.mdc') && f.endsWith('.mdc')
  );

  if (ruleFiles.length === 0) {
    console.log(c.yellow('⚠️  No figma-mcp cursor rules found, skipping.'));
    return 0;
  }

  let copied = 0;
  for (const file of ruleFiles) {
    copyFileSync(join(sourceRulesPath, file), join(targetRulesPath, file));
    console.log(`  📄 ${file}`);
    copied++;
  }

  return copied;
}

/** Copy bundled Claude Code skills from the package into the project (.claude/skills/<name>/). */
function copyClaudeSkills() {
  const sourceSkillsPath = join(PACKAGE_ROOT, '.claude/skills');
  const targetSkillsPath = join(PROJECT_ROOT, '.claude/skills');

  if (!existsSync(sourceSkillsPath)) {
    console.log(c.yellow('⚠️  No Claude skills found in package, skipping.'));
    return 0;
  }

  const entries = readdirSync(sourceSkillsPath, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());
  if (skillDirs.length === 0) {
    console.log(c.yellow('⚠️  No skill folders under .claude/skills, skipping.'));
    return 0;
  }

  mkdirSync(targetSkillsPath, { recursive: true });

  let copied = 0;
  for (const dir of skillDirs) {
    const name = dir.name;
    const from = resolve(join(sourceSkillsPath, name));
    const to = resolve(join(targetSkillsPath, name));
    if (from === to) {
      console.log(`  ${c.dim('skip')} .claude/skills/${name}/ ${c.dim('(package is project cwd)')}`);
      continue;
    }
    cpSync(from, to, { recursive: true, force: true });
    console.log(`  📄 .claude/skills/${name}/`);
    copied++;
  }

  return copied;
}

function createConfigTemplate() {
  const templatePath = join(PACKAGE_ROOT, 'templates/figma.config.yaml');
  const targetDir = join(PROJECT_ROOT, '.cursor/mcp');
  const targetPath = join(targetDir, 'figma.config.yaml');
  const legacyPath = join(targetDir, 'figma-links.yaml');

  if (existsSync(targetPath)) {
    console.log(`  ${c.dim('skip')} .cursor/mcp/figma.config.yaml ${c.dim('(already exists)')}`);
    return false;
  }

  if (existsSync(legacyPath)) {
    console.log(`  ${c.dim('skip')} .cursor/mcp/figma.config.yaml ${c.dim('(figma-links.yaml found — rename to figma.config.yaml and add source: desktop|bridge|cloud at the top)')}`);
    return false;
  }

  if (!existsSync(templatePath)) {
    console.log(c.yellow('⚠️  Config template not found in package, skipping.'));
    return false;
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(templatePath, targetPath);
  console.log(`  📄 .cursor/mcp/figma.config.yaml ${c.dim('(created from template)')}`);
  return true;
}

function addNpmScripts() {
  const pkgPath = join(PROJECT_ROOT, 'package.json');
  if (!existsSync(pkgPath)) {
    console.log(c.yellow('⚠️  No package.json found, skipping npm scripts injection.'));
    return 0;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.scripts = pkg.scripts ?? {};

  const toAdd = {
    'figma-mcp': 'npx figma-mcp',
  };

  let added = 0;
  for (const [k, v] of Object.entries(toAdd)) {
    if (!pkg.scripts[k]) {
      pkg.scripts[k] = v;
      console.log(`  📝 npm script: ${c.dim(k)}`);
      added++;
    }
  }

  if (added > 0) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }

  return added;
}

// ---------------------------------------------------------------------------
// bridge
// ---------------------------------------------------------------------------

async function cmdBridge(args) {
  const sub = args[0];
  if (sub === 'setup') {
    await cmdBridgeSetup(args.slice(1));
  } else if (sub === 'status') {
    await cmdBridgeStatus();
  } else {
    if (sub && sub !== 'help') {
      console.log(c.yellow(`⚠️  Unknown bridge subcommand: ${sub}\n`));
    }
    console.log('Usage:');
    console.log('  npx figma-mcp bridge setup [--refresh]   Download and prepare the Figma plugin');
    console.log('  npx figma-mcp bridge status              Check if bridge is running and plugin is connected');
  }
}

async function cmdBridgeSetup(args) {
  const refresh = args.includes('--refresh');
  const pluginDir = join(PROJECT_ROOT, '.cursor/mcp/figma-bridge-plugin');
  const manifestPath = join(pluginDir, 'manifest.json');

  if (!refresh && existsSync(manifestPath)) {
    console.log(c.green('✓ Figma plugin already installed.\n'));
    console.log(`  ${c.dim('Manifest:')} ${manifestPath}`);
    console.log(c.dim('\n  Run with --refresh to re-download the latest version.'));
    return;
  }

  console.log(c.bold('\n⭐️ figma-mcp bridge setup\n'));
  console.log(c.dim('Fetching latest figma-mcp-bridge release...'));

  let tag;
  try {
    const res = await fetch('https://api.github.com/repos/gethopp/figma-mcp-bridge/releases/latest', {
      headers: { 'User-Agent': 'figma-mcp' },
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const release = await res.json();
    tag = release.tag_name;
  } catch (err) {
    console.log(c.red(`✗ Could not fetch release info: ${err.message}`));
    console.log(c.dim('  Check your internet connection or visit:'));
    console.log(c.dim('  https://github.com/gethopp/figma-mcp-bridge/releases'));
    return;
  }

  console.log(`  latest: ${c.cyan(tag)}\n`);

  const distDir = join(pluginDir, 'dist');
  mkdirSync(distDir, { recursive: true });

  const base = `https://raw.githubusercontent.com/gethopp/figma-mcp-bridge/${tag}/plugin`;
  const files = [
    { url: `${base}/manifest.json`, dest: manifestPath },
    { url: `${base}/dist/code.js`, dest: join(distDir, 'code.js') },
    { url: `${base}/dist/index.html`, dest: join(distDir, 'index.html') },
  ];

  for (const { url, dest } of files) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'figma-mcp' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(dest, await res.text(), 'utf-8');
      console.log(`  ${c.green('✓')} ${relative(PROJECT_ROOT, dest)}`);
    } catch (err) {
      console.log(c.red(`  ✗ ${relative(PROJECT_ROOT, dest)}: ${err.message}`));
      console.log(c.dim(`    URL: ${url}`));
      return;
    }
  }

  console.log(c.green('\n✓ Plugin ready.\n'));
  console.log(c.bold('To install in Figma Desktop:'));
  console.log(`  1. Open Figma Desktop`);
  console.log(`  2. Main menu ${c.dim('→')} Plugins ${c.dim('→')} Development ${c.dim('→')} Import plugin from manifest`);
  console.log(`  3. Select: ${c.cyan(manifestPath)}`);
  console.log('');
  console.log(c.dim('The plugin only needs to be imported once. Afterwards run it from'));
  console.log(c.dim('Plugins → Development → Figma MCP Bridge each time you warm cache.'));
}

async function cmdBridgeStatus() {
  const BRIDGE_URL = 'http://localhost:1994';

  const ping = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${BRIDGE_URL}/ping`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'figma-mcp' },
      });
      clearTimeout(t);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      clearTimeout(t);
      return null;
    }
  };

  const listFiles = async () => {
    try {
      const res = await fetch(`${BRIDGE_URL}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'figma-mcp' },
        body: JSON.stringify({ tool: 'list_files' }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      return Array.isArray(body.data) ? body.data : null;
    } catch {
      return null;
    }
  };

  const health = await ping();

  if (!health) {
    console.log(`  bridge   ${c.yellow('not running')}`);
    console.log(`  plugin   ${c.dim('unknown')}\n`);
    console.log(c.dim('  The bridge starts automatically when Cursor opens (via global MCP config).'));
    console.log(c.dim('  If Cursor is open, check that figma-mcp-bridge is in your MCP settings.'));
    return;
  }

  const versionNote = health.version ? c.dim(` v${health.version}`) : '';
  console.log(`  bridge   ${c.green('running')}${versionNote}`);

  const files = await listFiles();
  if (!files || files.length === 0) {
    console.log(`  plugin   ${c.yellow('not connected')}`);
    console.log('');
    console.log(c.dim('  Open Figma Desktop, then run Plugins → Development → Figma MCP Bridge.'));
  } else {
    console.log(`  plugin   ${c.green(`${files.length} file(s) connected`)}`);
    for (const f of files) {
      console.log(`           ${c.dim('·')} ${f.fileName || f.fileKey} ${c.dim(`(${f.fileKey})`)}`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// delegate to ts scripts
// ---------------------------------------------------------------------------

function cmdDelegateToScript(scriptFile, scriptArgs) {
  const scriptPath = join(PACKAGE_ROOT, 'scripts', scriptFile);
  const tsxBin = join(PROJECT_ROOT, 'node_modules/.bin/tsx');
  const tsx = existsSync(tsxBin) ? tsxBin : 'npx tsx';

  try {
    execSync(`${tsx} ${scriptPath} ${scriptArgs.join(' ')}`, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    });
  } catch {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// info / help
// ---------------------------------------------------------------------------

function getPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
    return pkg.version ?? '?';
  } catch {
    return '?';
  }
}

function cmdInfo() {
  const currentVersion = getPackageVersion();
  console.log(`ℹ️  Installed version: v${currentVersion}`);
  const latestTag = getLatestRemoteVersionTag();
  if (latestTag) {
    console.log(`ℹ️  Latest version: ${latestTag}`);
  } else {
    console.log(c.yellow('⚠️  Latest version tag: none found yet'));
  }
  console.log('ℹ️  Changelog: https://github.com/gridonic/figma-mcp/blob/main/CHANGELOG.md');
  console.log(`ℹ️  Package root: ${c.dim(PACKAGE_ROOT)}`);
  console.log(`ℹ️  Project root: ${c.dim(PROJECT_ROOT)}`);
}

function cmdHelp() {
  console.log(c.bold(`⭐️ figma-mcp v${getPackageVersion()}\n`));
  console.log('Usage: npx figma-mcp <command> [options]\n');
  console.log('npm script wrapper: npm run figma-mcp -- <command> [options]\n');
  console.log('Commands:');
  console.log('  init                       Copy cursor rules + Claude skills, config template, npm script');
  console.log('  upgrade [--rules-only]     Install latest published version and refresh rules + skills');
  console.log('  bridge setup               Download and prepare the Figma plugin for figma-mcp-bridge');
  console.log('  bridge status              Check if bridge is running and plugin is connected');
  console.log('  cache list                 List all cached Figma MCP artifacts');
  console.log('  cache clear                Delete entire local cache');
  console.log('  cache warm                 Pre-populate cache from figma.config.yaml');
  console.log('  cache refresh              Force-refresh cache from Figma MCP');
  console.log('  cache inspect [module]     Inspect module manifests and artifact readiness');
  console.log('  cache get --url --node     Fetch and cache a single artifact');
  console.log('  tokens sync                Sync color + typography tokens to SCSS files');
  console.log('  modules setup              Run full setup pipeline (supports --debug-cache, --cache-root)');
  console.log('  info                       Show version and paths');
  console.log('  help                       Show this help');
}

function getLatestRemoteVersionTag() {
  const remoteTags = execSync(
    'git ls-remote --tags https://github.com/gridonic/figma-mcp.git',
    { encoding: 'utf8' }
  );

  const versionTags = remoteTags
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.split('\t')[1]?.replace('refs/tags/', ''))
    .filter((tag) => tag && /^v\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => compareVersions(b.replace(/^v/, ''), a.replace(/^v/, '')));

  if (versionTags.length === 0) {
    return null;
  }

  return versionTags[0];
}

function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

runCommand().catch((err) => {
  console.error(c.red(`\n✗ ${err.message}`));
  process.exit(1);
});
