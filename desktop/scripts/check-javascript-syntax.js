'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_FILES = 4096;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const EXCLUDED_PREFIXES = Object.freeze([
  'desktop/node_modules/',
  'desktop/release/',
]);

function parseArguments(argv) {
  const values = [...argv];
  let tree = 'HEAD';
  while (values.length) {
    const flag = values.shift();
    if (flag !== '--tree' || !values.length) {
      throw new TypeError('usage: check-javascript-syntax.js [--tree <git-tree>]');
    }
    tree = values.shift();
  }
  if (typeof tree !== 'string' || !tree || tree.length > 128 || tree.startsWith('-') ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(tree)) {
    throw new TypeError('syntax tree reference is invalid');
  }
  return Object.freeze({ tree });
}

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: options.encoding,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function safeTrackedPath(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f:]/u.test(value) ||
      value.includes('\\') ||
      value.startsWith('/') || value.startsWith('../') || value.includes('/../') ||
      path.posix.normalize(value) !== value || !/\.(?:js|mjs)$/u.test(value)) {
    throw new TypeError('syntax gate received an invalid tracked path');
  }
  return value;
}

function listJavaScriptFiles({ repoRoot, tree, execute = runProcess }) {
  const result = execute('git', [
    'ls-tree', '-r', '-z', '--name-only', tree,
  ], { cwd: repoRoot, encoding: 'buffer' });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error('syntax gate could not enumerate the requested Git tree');
  }
  const files = result.stdout.toString('utf8').split('\0').filter(Boolean)
    .filter((file) => /\.(?:js|mjs)$/u.test(file))
    .map(safeTrackedPath)
    .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)));
  if (!files.length) throw new Error('syntax gate enumerated zero JavaScript files');
  if (files.length > MAX_FILES || new Set(files).size !== files.length) {
    throw new Error('syntax gate enumerated an invalid JavaScript file set');
  }
  return Object.freeze(files.sort());
}

function readTreeBlob({ repoRoot, tree, file, execute = runProcess }) {
  const result = execute('git', ['show', `${tree}:${safeTrackedPath(file)}`], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: MAX_SOURCE_BYTES + 1,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout) ||
      result.stdout.length > MAX_SOURCE_BYTES) {
    throw new Error(`syntax gate could not read a bounded blob: ${file}`);
  }
  return result.stdout;
}

function checkJavaScriptSource(source, { execute = runProcess, module = false } = {}) {
  if (!Buffer.isBuffer(source) || source.length > MAX_SOURCE_BYTES) {
    throw new TypeError('syntax source must be a bounded Buffer');
  }
  const result = execute(process.execPath, module ? ['--check', '--input-type=module'] : ['--check'], {
    input: source,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  return Object.freeze({
    ok: result.status === 0,
    diagnostic: result.status === 0 ? '' : String(result.stderr || '').slice(0, 4096),
  });
}

function controlModuleEntrypoints(html) {
  const modules = new Set();
  const source = String(html).replace(/<!--[\s\S]*?-->/gu, '');
  for (const [tag] of source.matchAll(/<script\b[^>]*>/giu)) {
    if (!/\btype\s*=\s*(['"])module\1/iu.test(tag)) continue;
    const specifier = tag.match(/\bsrc\s*=\s*(['"])([^'"]+)\1/iu)?.[2];
    if (!specifier || !specifier.endsWith('.js') && !specifier.endsWith('.mjs') ||
        specifier.startsWith('/') || specifier.includes(':') || specifier.includes('\\')) {
      throw new TypeError('control module entrypoint is invalid');
    }
    const file = safeTrackedPath(path.posix.join('desktop/renderer', specifier));
    if (!file.startsWith('desktop/renderer/')) throw new TypeError('control module entrypoint escapes Renderer');
    modules.add(file);
  }
  return modules;
}

function checkJavaScriptTree({ repoRoot, tree, execute = runProcess }) {
  const files = listJavaScriptFiles({ repoRoot, tree, execute });
  const markup = execute('git', ['show', `${tree}:desktop/renderer/index.html`], {
    cwd: repoRoot, encoding: 'buffer', maxBuffer: MAX_SOURCE_BYTES + 1,
  });
  if (markup.status !== 0 || !Buffer.isBuffer(markup.stdout) || markup.stdout.length > MAX_SOURCE_BYTES) {
    throw new Error('syntax gate could not read the control module entrypoints');
  }
  const modules = controlModuleEntrypoints(markup.stdout.toString('utf8'));
  if ([...modules].some(file => !files.includes(file))) throw new Error('control module entrypoint is missing');
  const failures = [];
  for (const file of files) {
    const source = readTreeBlob({ repoRoot, tree, file, execute });
    const result = checkJavaScriptSource(source, { execute, module: file.endsWith('.mjs') || modules.has(file) });
    if (!result.ok) failures.push(Object.freeze({ file, diagnostic: result.diagnostic }));
  }
  return Object.freeze({ files, failures: Object.freeze(failures) });
}

function main(argv = process.argv.slice(2)) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const { tree } = parseArguments(argv);
  const result = checkJavaScriptTree({ repoRoot, tree });
  if (result.failures.length) {
    for (const failure of result.failures) {
      process.stderr.write(`javascript syntax gate: FAIL ${failure.file}\n${failure.diagnostic}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `javascript syntax gate: PASS (tree=${tree}, files=${result.files.length})\n`,
  );
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`javascript syntax gate: FAIL (${error.message})\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  controlModuleEntrypoints,
  checkJavaScriptSource,
  checkJavaScriptTree,
  listJavaScriptFiles,
  parseArguments,
  readTreeBlob,
  safeTrackedPath,
};
