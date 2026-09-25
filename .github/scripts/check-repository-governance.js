'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { moduleCoverage, moduleMapErrors } = require('../../desktop/scripts/module-map-coverage');

const MAX_TRACKED_FILE_BYTES = 5 * 1024 * 1024;
const ROOT_TEST_DEBT_CAP = 0;
const ROOT_TEST_DEBT_FILE = '.github/scripts/desktop-root-test-debt.json';
const ROOT_TEST_PATH = /^desktop\/test\/[^/]+\.(?:js|mjs|cjs)$/iu;
const REQUIRED_FILES = Object.freeze([
  '.github/AGENTS.md',
  '.github/CODEOWNERS',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/feature.yml',
  '.github/dependabot.yml',
  '.github/pull_request_template.md',
  '.github/scripts/audit-live-github-governance.js',
  ROOT_TEST_DEBT_FILE,
  'AGENTS.md',
  'ARCHITECTURE.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'GOAL.md',
  'SECURITY.md',
  'desktop/AGENTS.md',
  'desktop/test/AGENTS.md',
  'desktop/test/contracts/live-github-governance.test.js',
  'desktop/renderer/AGENTS.md',
  'docs/AGENTS.md',
  'docs/README.md',
  'docs/architecture/modularization-plan.md',
  'docs/architecture/module-map.yml',
  'docs/governance/collaboration-model.md',
  'docs/governance/repository-governance-contract.json',
  'docs/security/data-classification.md',
  'independent/AGENTS.md',
]);

const FORBIDDEN_TRACKED_PATTERNS = Object.freeze([
  { pattern: /(^|\/)\.DS_Store$/u, reason: 'operating-system metadata' },
  { pattern: /(^|\/)node_modules\//u, reason: 'Node dependency output' },
  { pattern: /(^|\/)target\//u, reason: 'Cargo build output' },
  { pattern: /(^|\/)release\//u, reason: 'packaged release output' },
  { pattern: /^docs\/superpowers\//u, reason: 'tool-specific historical documentation' },
  { pattern: /^config\.toml$/u, reason: 'local runtime configuration' },
  { pattern: /\.(?:pcap|pcapng|har|key|pem|p12|mobileprovision)$/iu, reason: 'private capture or key material' },
  { pattern: /\.(?:dmg|exe|AppImage|apk|blockmap|zip)$/u, reason: 'generated package artifact' },
]);

function normalizePath(value) {
  return String(value).replaceAll(path.sep, '/');
}

function trackedFiles(repositoryRoot) {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean).map(normalizePath).sort();
  } catch (error) {
    throw new Error(`cannot enumerate the exact Git index: ${error.message}`);
  }
}

function actionPinErrors(source, workflow) {
  const errors = [];
  for (const [index, line] of String(source).split('\n').entries()) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/u);
    if (!match) continue;
    const target = match[1];
    if (target.startsWith('./')) continue;
    if (!/@[0-9a-f]{40}$/u.test(target)) {
      errors.push(`${workflow}:${index + 1} action is not pinned to a full commit SHA: ${target}`);
    }
  }
  if (/\bpull_request_target\s*:/u.test(source)) {
    errors.push(`${workflow} uses forbidden pull_request_target`);
  }
  return errors;
}

function rootTestDebtErrors(tracked, document) {
  if (!document || typeof document !== 'object' || Array.isArray(document) ||
      Object.keys(document).length !== 2 || document.schemaVersion !== 1 ||
      !Array.isArray(document.rootFiles) || document.rootFiles.length > ROOT_TEST_DEBT_CAP ||
      document.rootFiles.some(file => typeof file !== 'string' || !ROOT_TEST_PATH.test(file) ||
        /[\\\u0000-\u001f\u007f]/u.test(file)) ||
      new Set(document.rootFiles).size !== document.rootFiles.length) {
    return ['root Desktop test debt manifest is invalid'];
  }
  const rootTests = tracked.filter(file => ROOT_TEST_PATH.test(file));
  const errors = [];
  const allowed = new Set(document.rootFiles);
  const actual = new Set(rootTests);
  for (const file of rootTests) {
    if (!allowed.has(file)) errors.push(`new root Desktop test is forbidden: ${file}`);
  }
  for (const file of allowed) {
    if (!actual.has(file)) errors.push(`remove migrated root Desktop test exception: ${file}`);
  }
  if (rootTests.length > ROOT_TEST_DEBT_CAP) {
    errors.push(`root Desktop test debt grew from ${ROOT_TEST_DEBT_CAP} to ${rootTests.length}`);
  }
  return errors.sort();
}

function relativeMarkdownTargets(source) {
  const targets = [];
  for (const match of String(source).matchAll(/\]\(([^)]+)\)/gu)) {
    let target = match[1].trim().replace(/^<|>$/gu, '').split('#')[0];
    if (!target || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      targets.push({ target, invalidEncoding: true });
      continue;
    }
    targets.push({ target, invalidEncoding: false });
  }
  return targets;
}

function markdownLinkErrors(repositoryRoot, tracked) {
  const errors = [];
  for (const file of tracked.filter((entry) => entry.endsWith('.md'))) {
    const source = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
    for (const { target, invalidEncoding } of relativeMarkdownTargets(source)) {
      if (invalidEncoding) {
        errors.push(`invalid encoded Markdown link in ${file}: ${target}`);
        continue;
      }
      const resolved = path.resolve(repositoryRoot, path.dirname(file), target);
      if (!fs.existsSync(resolved)) errors.push(`broken relative Markdown link in ${file}: ${target}`);
    }
  }
  return errors;
}

function governanceErrors(repositoryRoot) {
  const errors = [];
  const tracked = trackedFiles(repositoryRoot);
  const trackedSet = new Set(tracked);

  for (const file of REQUIRED_FILES) {
    if (!trackedSet.has(file) && !fs.existsSync(path.join(repositoryRoot, file))) {
      errors.push(`required governance file is missing: ${file}`);
    }
  }

  for (const file of tracked) {
    for (const { pattern, reason } of FORBIDDEN_TRACKED_PATTERNS) {
      if (pattern.test(file)) errors.push(`forbidden tracked ${reason}: ${file}`);
    }
    const absolute = path.join(repositoryRoot, file);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      errors.push(`tracked symlink requires an explicit governance exception: ${file}`);
    } else if (stat.isFile() && stat.size > MAX_TRACKED_FILE_BYTES) {
      errors.push(`tracked file exceeds 5 MiB; use a reviewed artifact/LFS policy: ${file}`);
    }
  }

  try {
    const debtSource = fs.readFileSync(path.join(repositoryRoot, ROOT_TEST_DEBT_FILE), 'utf8');
    if (Buffer.byteLength(debtSource) > 32 * 1024) throw new Error('oversized test debt manifest');
    errors.push(...rootTestDebtErrors(tracked, JSON.parse(debtSource)));
  } catch { errors.push('root Desktop test debt manifest is missing or unreadable'); }

  const workflows = tracked.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file));
  for (const workflow of workflows) {
    errors.push(...actionPinErrors(fs.readFileSync(path.join(repositoryRoot, workflow), 'utf8'), workflow));
  }

  const moduleMap = path.join(repositoryRoot, 'docs', 'architecture', 'module-map.yml');
  if (fs.existsSync(moduleMap)) errors.push(...moduleCoverage(fs.readFileSync(moduleMap, 'utf8'), tracked).errors);
  errors.push(...markdownLinkErrors(repositoryRoot, tracked));

  return errors.sort();
}

function run() {
  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const errors = governanceErrors(repositoryRoot);
  if (errors.length) {
    for (const error of errors) process.stderr.write(`repository governance: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('repository governance: PASS\n');
}

if (require.main === module) run();

module.exports = {
  rootTestDebtErrors,
  FORBIDDEN_TRACKED_PATTERNS,
  MAX_TRACKED_FILE_BYTES,
  REQUIRED_FILES,
  ROOT_TEST_DEBT_CAP,
  actionPinErrors,
  governanceErrors,
  markdownLinkErrors,
  moduleMapErrors,
  normalizePath,
  relativeMarkdownTargets,
  trackedFiles,
};
