'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { analyzeRendererSource } = require('./renderer-source-analysis');
const { collectRendererScriptEntries, modulePaths } = require('./renderer-html-entrypoints');

const REGISTRY = 'scripts/renderer-feature-registry.json';
const safePath = value => typeof value === 'string' && /^[a-zA-Z0-9_./-]+$/u.test(value) &&
  !value.startsWith('/') && !value.split('/').includes('..') && path.posix.normalize(value) === value;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const strings = value => Array.isArray(value) && value.length <= 256 &&
  value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 160) &&
  new Set(value).size === value.length;

function validateRegistry(value) {
  if (!exactKeys(value, ['schemaVersion', 'bootstraps', 'legacyGlobals', 'features']) || value.schemaVersion !== 1 ||
      !strings(value.bootstraps) || !value.bootstraps.length ||
      !value.legacyGlobals || typeof value.legacyGlobals !== 'object' || Array.isArray(value.legacyGlobals) ||
      Object.keys(value.legacyGlobals).length > 128 || !Array.isArray(value.features) || value.features.length > 64) {
    throw new TypeError('Renderer feature registry schema is invalid');
  }
  for (const [file, exports] of Object.entries(value.legacyGlobals)) {
    if (!safePath(file) || !/\.(?:js|mjs)$/u.test(file) || !strings(exports) || !exports.length ||
        exports.some(name => !/^(?:@binding:)?[A-Za-z_$][\w$]*$/u.test(name))) {
      throw new TypeError('legacy Renderer export entry is invalid');
    }
  }
  const ids = new Set();
  for (const feature of value.features) {
    if (!exactKeys(feature, ['id', 'root', 'entrypoint', 'exports', 'allowedDependencies']) ||
        typeof feature.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(feature.id) || ids.has(feature.id) ||
        feature.root !== `renderer/features/${feature.id}` || feature.entrypoint !== `${feature.root}/index.mjs` ||
        !strings(feature.exports) || !feature.exports.length ||
        feature.exports.some(name => !/^[A-Za-z_$][\w$]*$/u.test(name)) || !strings(feature.allowedDependencies)) {
      throw new TypeError('Renderer feature ownership entry is invalid');
    }
    ids.add(feature.id);
  }
  for (const file of value.bootstraps) {
    if (!safePath(file) || !/^renderer\/.+\.(?:js|mjs)$/u.test(file) ||
        Object.hasOwn(value.legacyGlobals, file) ||
        value.features.some(feature => file.startsWith(`${feature.root}/`))) {
      throw new TypeError('Renderer bootstrap ownership is invalid');
    }
  }
  for (const feature of value.features) {
    if (feature.allowedDependencies.some(id => !ids.has(id) || id === feature.id)) {
      throw new TypeError('Renderer feature dependency is invalid');
    }
  }
  return value;
}

function analyzeRendererFiles(root, files, sharedSources = [], entries = collectRendererScriptEntries(root)) {
  const modules = modulePaths(entries);
  const shared = new Set(sharedSources);
  const result = new Map();
  for (const absolute of files) {
    const file = path.relative(root, absolute).split(path.sep).join('/');
    if (!file.startsWith('renderer/') && !shared.has(file)) continue;
    const source = fs.readFileSync(absolute, 'utf8');
    try {
      result.set(file, { ...analyzeRendererSource(source, { module: file.endsWith('.mjs') || modules.has(file) }),
        htmlModule: modules.has(file) });
    } catch {
      result.set(file, { exports: [], moduleExports: [], imports: [], globalReads: 0,
        errors: ['cannot parse or bound Renderer source analysis'] });
    }
  }
  return result;
}

function rendererBoundaryErrors(registry, records, entries = []) {
  const errors = [];
  try { validateRegistry(registry); } catch (error) { return [error.message]; }
  const owner = file => registry.features.find(feature => file.startsWith(`${feature.root}/`));
  for (const entry of entries) {
    if (!records.has(entry.file) ||
        (!registry.bootstraps.includes(entry.file) && !Object.hasOwn(registry.legacyGlobals,entry.file))) {
      errors.push(`unapproved HTML script entrypoint: ${entry.page} -> ${entry.file}`);
    } else if (records.get(entry.file).module !== entry.module) {
      errors.push(`HTML script mode mismatch: ${entry.page} -> ${entry.file}`);
    }
  }
  const graph = new Map([...records.keys()].map(file => [file, []]));
  for (const file of registry.bootstraps) {
    if (!records.has(file)) errors.push(`missing Renderer bootstrap: ${file}`);
    else if (records.get(file).module !== true) errors.push(`Renderer bootstrap must be a module: ${file}`);
  }
  for (const [file, names] of Object.entries(registry.legacyGlobals)) {
    if (!records.has(file)) errors.push(`stale legacy global owner: ${file}`);
    else for (const name of names) {
      if (!records.get(file).exports.includes(name)) errors.push(`remove retired global exception: ${file}:${name}`);
    }
  }
  for (const feature of registry.features) {
    const entry = records.get(feature.entrypoint);
    if (!entry) errors.push(`missing feature entrypoint: ${feature.entrypoint}`);
    else if (JSON.stringify([...entry.moduleExports].sort()) !== JSON.stringify([...feature.exports].sort())) {
      errors.push(`feature public exports changed: ${feature.entrypoint}`);
    }
  }
  for (const [file, record] of records) {
    const current = owner(file);
    if (record.htmlModule && !registry.bootstraps.includes(file) && !Object.hasOwn(registry.legacyGlobals, file)) {
      errors.push(`unapproved HTML module entrypoint: ${file}`);
    }
    if (!current && !Object.hasOwn(registry.legacyGlobals, file) && !registry.bootstraps.includes(file)) {
      errors.push(`unowned Renderer source: ${file}`);
    }
    if (record.module === false && !Object.hasOwn(registry.legacyGlobals, file)) {
      errors.push(`unregistered classic Renderer source: ${file}`);
    }
    if (file.startsWith('renderer/features/') && !current && !registry.bootstraps.includes(file)) {
      errors.push(`unowned Renderer feature source: ${file}`);
    }
    for (const error of record.errors) errors.push(`${file}:${error}`);
    for (const name of record.exports) {
      if (!registry.legacyGlobals[file]?.includes(name)) errors.push(`unapproved Renderer global: ${file}:${name}`);
    }
    if (current && (record.globalReads || record.exports.length)) {
      errors.push(`migrated feature uses browser globals: ${file}`);
    }
    for (const specifier of record.imports) {
      if (!specifier.startsWith('.') || specifier.includes('\\') || specifier.includes('?') || specifier.includes('#')) {
        errors.push(`non-local Renderer import: ${file}`); continue;
      }
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const target = [relative, `${relative}.js`, `${relative}/index.js`].find(candidate => records.has(candidate));
      if (!target) { errors.push(`unresolved Renderer import: ${file} -> ${specifier}`); continue; }
      graph.get(file).push(target);
      const dependency = owner(target);
      if (dependency && current?.id !== dependency.id && target !== dependency.entrypoint) {
        errors.push(`private Renderer import: ${file} -> ${target}`);
      }
      if (current && current.id !== dependency?.id && !current.allowedDependencies.includes(dependency?.id)) {
        errors.push(`disallowed Renderer dependency: ${file} -> ${target}`);
      }
    }
  }
  const active = new Set();
  const visited = new Set();
  function visit(file) {
    if (active.has(file)) { errors.push(`Renderer import cycle includes: ${file}`); return; }
    if (visited.has(file)) return;
    active.add(file);
    for (const target of graph.get(file)) visit(target);
    active.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return errors.sort();
}

function checkRendererBoundaries(root, files, sharedSources) {
  let registry;
  try {
    const source = fs.readFileSync(path.join(root, REGISTRY), 'utf8');
    if (Buffer.byteLength(source) > 64 * 1024) throw new Error('oversized registry');
    registry = JSON.parse(source);
  } catch { return ['Renderer feature registry is missing or invalid']; }
  try {
    const entries = collectRendererScriptEntries(root);
    return rendererBoundaryErrors(registry, analyzeRendererFiles(root, files, sharedSources, entries), entries);
  } catch { return ['Renderer HTML script inventory is missing or invalid']; }
}

module.exports = { analyzeRendererFiles, checkRendererBoundaries, rendererBoundaryErrors, validateRegistry };
