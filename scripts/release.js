#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageJsonPath = join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const currentVersion = packageJson.version;
const isDryRun = process.argv.includes('--dry-run');

console.log(`Current version: ${currentVersion}`);
if (isDryRun) {
  console.log('\nDRY RUN MODE - no commits or tags will be created');
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function collectChangelogEntries() {
  return new Promise((resolve) => {
    console.log('\nEnter changelog entries (one per line, empty line to finish):');
    const changelogEntries = [];

    const askForEntry = () => {
      rl.question('  - ', (entry) => {
        if (entry.toLowerCase() === '') {
          if (changelogEntries.length === 0) {
            console.log('At least one changelog entry is required.');
            askForEntry();
            return;
          }
          resolve(changelogEntries);
          return;
        }

        if (entry.trim()) {
          changelogEntries.push(entry.trim());
        }
        askForEntry();
      });
    };

    askForEntry();
  });
}

function getCommitMessagesSinceLastVersion() {
  try {
    const latestTag = execSync('git describe --tags --abbrev=0', {
      encoding: 'utf8',
    }).trim();
    console.log(`\nCommits since ${latestTag}:`);

    const commits = execSync(`git log ${latestTag}..HEAD --oneline`, {
      encoding: 'utf8',
    }).trim();

    if (!commits) {
      console.log('  No commits found since last version');
      return;
    }

    commits.split('\n').forEach((commit) => console.log(`  ${commit}`));
  } catch {
    console.log('\nNo previous version tag found.');
  }
}

function updateChangelog(newVersion, changelogEntries) {
  const changelogPath = join(__dirname, '..', 'CHANGELOG.md');
  const currentContent = readFileSync(changelogPath, 'utf-8');
  const newEntry = `## [${newVersion}](https://github.com/gridonic/figma-mcp/compare/v${currentVersion}...v${newVersion})\n\n${changelogEntries
    .map((entry) => `- ${entry}`)
    .join('\n')}\n\n`;

  writeFileSync(changelogPath, newEntry + currentContent);
  console.log(`\nCHANGELOG.md updated with version ${newVersion}`);
}

function isHigherVersion(current, next) {
  const currentParts = current.split('.').map(Number);
  const nextParts = next.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (nextParts[i] > currentParts[i]) return true;
    if (nextParts[i] < currentParts[i]) return false;
  }
  return false;
}

async function runRelease() {
  try {
    const stagedFiles = execSync('git diff --cached --name-only', {
      encoding: 'utf8',
    }).trim();
    if (stagedFiles) {
      console.error('There are staged files. Unstage them before release.');
      process.exit(1);
    }

    const newVersion = await new Promise((resolve) => {
      rl.question('Enter new version (x.y.z): ', resolve);
    });

    if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
      console.error('Invalid version format. Use semantic versioning, e.g. 1.2.3.');
      process.exit(1);
    }

    if (!isHigherVersion(currentVersion, newVersion)) {
      console.error(`New version ${newVersion} must be higher than ${currentVersion}.`);
      process.exit(1);
    }

    try {
      execSync(`git rev-parse v${newVersion}`, { stdio: 'pipe' });
      console.error(`Tag v${newVersion} already exists.`);
      process.exit(1);
    } catch {
      // expected: tag not found
    }

    getCommitMessagesSinceLastVersion();
    const changelogEntries = await collectChangelogEntries();

    if (isDryRun) {
      console.log('\nDRY RUN: would update package.json, package-lock.json, CHANGELOG.md');
      console.log(`DRY RUN: would create commit "build(${newVersion}): version bump"`);
      console.log(`DRY RUN: would create tag v${newVersion}`);
      return;
    }

    updateChangelog(newVersion, changelogEntries);
    packageJson.version = newVersion;
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
    execSync('npm install', { stdio: 'inherit' });

    execSync('git add package.json package-lock.json CHANGELOG.md', {
      stdio: 'inherit',
    });
    execSync(`git commit -m "build(${newVersion}): version bump"`, {
      stdio: 'inherit',
    });
    execSync(`git tag v${newVersion}`, { stdio: 'inherit' });

    console.log('\nRelease prep complete.');
    console.log(`Next: git push && git push origin v${newVersion}`);
  } catch (error) {
    console.error(`Release failed: ${error.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

runRelease();
