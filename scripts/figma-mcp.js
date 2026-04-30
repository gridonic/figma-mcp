#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
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
    case 'tokens:sync':
      cmdDelegateToScript('sync-design-tokens.ts', args);
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
  const configCreated = createConfigTemplate();
  const scriptsAdded = addNpmScripts();

  console.log('');
  if (rulesCopied + scriptsAdded + (configCreated ? 1 : 0) === 0) {
    console.log(c.green('✓ Already up to date — nothing to do.'));
  } else {
    console.log(c.green('✓ Done.'));
    if (configCreated) {
      console.log(
        `\n${c.cyan('Next:')} Fill in your Figma node URLs in ${c.dim('.cursor/mcp/figma-links.yaml')}`
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

  const count = copyCursorRules();
  console.log('');
  if (count === 0) {
    console.log(c.green('✓ Cursor rules already up to date.'));
    return;
  }
  console.log(c.green(`✓ Upgraded ${count} cursor rule(s).`));
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

function createConfigTemplate() {
  const templatePath = join(PACKAGE_ROOT, 'templates/figma-links.yaml');
  const targetDir = join(PROJECT_ROOT, '.cursor/mcp');
  const targetPath = join(targetDir, 'figma-links.yaml');

  if (existsSync(targetPath)) {
    console.log(`  ${c.dim('skip')} .cursor/mcp/figma-links.yaml ${c.dim('(already exists)')}`);
    return false;
  }

  if (!existsSync(templatePath)) {
    console.log(c.yellow('⚠️  Config template not found in package, skipping.'));
    return false;
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(templatePath, targetPath);
  console.log(`  📄 .cursor/mcp/figma-links.yaml ${c.dim('(created from template)')}`);
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
  console.log('  init                       Copy cursor rules, create config template, add npm wrapper script');
  console.log('  upgrade [--rules-only]     Install latest published version and refresh cursor rules');
  console.log('  cache list                 List all cached Figma MCP artifacts');
  console.log('  cache clear                Delete entire local cache');
  console.log('  cache warm                 Pre-populate cache from figma-links.yaml');
  console.log('  cache refresh              Force-refresh cache from Figma MCP');
  console.log('  cache get --url --node     Fetch and cache a single artifact');
  console.log('  tokens:sync                Sync color + typography tokens to SCSS files');
  console.log('  modules:setup              Run full setup pipeline (supports --debug-cache, --cache-root)');
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
