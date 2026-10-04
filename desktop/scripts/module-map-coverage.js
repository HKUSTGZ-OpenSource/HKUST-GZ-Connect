'use strict';

const yaml = require('js-yaml');

// Fixed in the checker, not configurable from the map: an incomplete map cannot
// hide unowned runtime files by narrowing its own coverage request.
const SOURCE_PREFIXES = Object.freeze([
  'desktop/lib/', 'desktop/renderer/', 'desktop/assets/',
  'independent/src/', 'independent/config/', 'tools/mac-cli/',
]);
const SOURCE_FILES = new Set(['desktop/main.js', 'desktop/preload.js', 'desktop/campus-preload.js', 'hkustgzconnect']);
const RISK = new Set(['low', 'medium', 'high', 'critical', 'restricted-evidence']);
const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_FILES = 10000;
const MAX_LEGACY_EDGE_DEBT = 89;
// Reviewed check vocabulary, not execution evidence or permission to run a check.
// Includes existing local acceptance aliases as well as required GitHub contexts.
const REQUIRED_CHECKS = new Set([
  'desktop', 'desktop-electron', 'engine', 'offline-tests', 'package-verifier',
  'secret-scan', 'windows-private-file', 'architecture', 'browser-e2e', 'mfa-e2e',
  'migration-e2e', 'upgrade-compatibility', 'profile-e2e', 'renderer-layout',
  'routing-restart', 'strict-proxy-auth', 'integration-contract', 'workspace-layout',
  'all-required-checks', 'governance', 'link-check',
]);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function strings(value, max = 256) {
  return Array.isArray(value) && value.length <= max &&
    value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 512) &&
    new Set(value).size === value.length;
}
function validPath(value, pattern = false) {
  if (typeof value !== 'string' || !value || value.length > 512) return false;
  const literal = pattern && value.endsWith('/**') ? value.slice(0, -3) : value;
  return literal.length > 0 && !/[\u0000-\u001f\u007f\\:*?<>|]/u.test(literal) &&
    literal.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}
function matches(pattern, file) {
  return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : pattern === file;
}
function overlap(left, right) {
  if (left === right) return true;
  if (left.endsWith('/**') && right.endsWith('/**')) {
    const a = left.slice(0, -2), b = right.slice(0, -2);
    return a.startsWith(b) || b.startsWith(a);
  }
  return left.endsWith('/**') ? matches(left, right) : right.endsWith('/**') && matches(right, left);
}
function schemaErrors(document) {
  if (!exactKeys(document, ['schemaVersion', 'status', 'owner', 'lastVerified', 'enforcement',
    'dependencyEnforcement', 'modules']) || document.schemaVersion !== 2 ||
    !['proposed', 'accepted'].includes(document.status) || typeof document.owner !== 'string' || !ID.test(document.owner) ||
    typeof document.lastVerified !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(document.lastVerified) ||
    document.enforcement !== 'path-coverage-and-entrypoint-ownership' ||
    document.dependencyEnforcement !== 'inventory-only' ||
    !Array.isArray(document.modules) || !document.modules.length || document.modules.length > 128) {
    return ['module map schema is invalid'];
  }
  const errors = [];
  const ids = new Set();
  const patterns = [];
  for (const module of document.modules) {
    if (!exactKeys(module, ['id', 'paths', 'publicEntrypoints', 'allowedDependencies', 'risk', 'requiredChecks']) ||
        typeof module.id !== 'string' || !ID.test(module.id) || !strings(module.paths) || !module.paths.length ||
        module.paths.some(item => !validPath(item, true)) || !strings(module.publicEntrypoints) ||
        module.publicEntrypoints.some(item => !validPath(item)) || !strings(module.allowedDependencies, 128) ||
        module.allowedDependencies.some(item => !ID.test(item)) || !RISK.has(module.risk) ||
        !strings(module.requiredChecks) || !module.requiredChecks.length ||
        module.requiredChecks.some(item => !ID.test(item) || !REQUIRED_CHECKS.has(item))) {
      errors.push('module record is invalid'); continue;
    }
    if (ids.has(module.id)) errors.push(`duplicate module id: ${module.id}`);
    ids.add(module.id);
    for (const item of module.paths) patterns.push({ pattern: item, id: module.id });
    for (const entry of module.publicEntrypoints) {
      if (!module.paths.some(item => matches(item, entry))) {
        errors.push(`public entrypoint outside owner: ${module.id} -> ${entry}`);
      }
    }
  }
  if (errors.some(error => error === 'module record is invalid')) return errors.sort();
  for (const module of document.modules) {
    for (const dependency of module.allowedDependencies) {
      if (!ids.has(dependency)) errors.push(`unknown module dependency: ${module.id} -> ${dependency}`);
    }
  }
  for (let i = 0; i < patterns.length; i++) for (let j = i + 1; j < patterns.length; j++) {
    const a = patterns[i], b = patterns[j];
    if (overlap(a.pattern, b.pattern)) {
      errors.push(`overlapping module paths: ${a.id}:${a.pattern} and ${b.id}:${b.pattern}`);
    }
  }
  return errors.sort();
}

function parseModuleMap(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    throw new TypeError('module map input is invalid or oversized');
  }
  // JSON schema avoids implicit Date objects and executable YAML-specific types.
  return yaml.load(source, { schema: yaml.JSON_SCHEMA });
}
function moduleMapErrors(source) {
  try { return schemaErrors(parseModuleMap(source)); }
  catch { return ['module map YAML is invalid']; }
}
function sourceInScope(file) {
  return SOURCE_FILES.has(file) || SOURCE_PREFIXES.some(prefix => file.startsWith(prefix));
}
function moduleCoverage(source, files) {
  let document;
  try { document = parseModuleMap(source); }
  catch { return { errors: ['module map YAML is invalid'], sourceCount: 0, owners: {} }; }
  const errors = schemaErrors(document);
  if (errors.length) return { errors, sourceCount: 0, owners: {} };
  if (!Array.isArray(files) || files.length > MAX_FILES || files.some(file => !validPath(file)) ||
      new Set(files).size !== files.length) {
    return { errors: ['module coverage file inventory is invalid'], sourceCount: 0, owners: {} };
  }
  const tracked = new Set(files);
  const owners = {};
  let sourceCount = 0;
  for (const file of files) {
    const found = document.modules.filter(module => module.paths.some(pattern => matches(pattern, file)));
    if (found.length > 1) errors.push(`multiple module owners: ${file}`);
    if (!sourceInScope(file)) continue;
    sourceCount++;
    if (!found.length) errors.push(`unowned production path: ${file}`);
    else if (found.length === 1) owners[file] = found[0].id;
  }
  if (!sourceCount) errors.push('module coverage contains no production paths');
  for (const module of document.modules) {
    for (const entry of module.publicEntrypoints) {
      if (!tracked.has(entry)) errors.push(`missing public entrypoint: ${module.id} -> ${entry}`);
    }
    for (const pattern of module.paths) {
      if (!files.some(file => matches(pattern, file))) errors.push(`stale module path: ${module.id}:${pattern}`);
    }
  }
  return { errors: [...new Set(errors)].sort(), sourceCount, owners };
}

// This is deliberately limited to already-resolved static JavaScript imports.
// Dynamic Renderer edges and Rust visibility remain separate M5 obligations.
function moduleImportViolations(source, imports) {
  let document;
  try { document = parseModuleMap(source); }
  catch { return { errors: ['module map YAML is invalid'], violations: [] }; }
  const errors = schemaErrors(document);
  if (errors.length) return { errors, violations: [] };
  if (!Array.isArray(imports) || imports.length > MAX_FILES || imports.some(edge => (
    !Array.isArray(edge) || edge.length !== 2 || !validPath(edge[0]) || !validPath(edge[1])
  ))) return { errors: ['module import inventory is invalid'], violations: [] };
  const ownerFor = file => document.modules.find(module =>
    module.paths.some(pattern => matches(pattern, file)));
  const violations = new Set();
  for (const [from, to] of imports) {
    const sourceOwner = ownerFor(from);
    const targetOwner = ownerFor(to);
    if (!sourceOwner) errors.push(`unowned import source: ${from}`);
    if (!targetOwner) errors.push(`unowned import target: ${to}`);
    if (!sourceOwner || !targetOwner || sourceOwner.id === targetOwner.id) continue;
    const reasons = [];
    if (!sourceOwner.allowedDependencies.includes(targetOwner.id)) {
      reasons.push('undeclared-dependency');
    }
    if (!targetOwner.publicEntrypoints.includes(to)) reasons.push('private-entrypoint');
    if (reasons.length) violations.add(`${from} -> ${to} [${reasons.join('+')}]`);
  }
  return { errors: [...new Set(errors)].sort(), violations: [...violations].sort() };
}

function moduleEdgeDebtErrors(violations, debt) {
  if (!exactKeys(debt, ['schemaVersion', 'baseSha', 'exceptions']) ||
      debt.schemaVersion !== 1 || !/^[0-9a-f]{40}$/u.test(debt.baseSha) ||
      !strings(debt.exceptions, MAX_LEGACY_EDGE_DEBT) ||
      debt.exceptions.some(value => !/^desktop\/[^\n]+ -> desktop\/[^\n]+ \[(?:undeclared-dependency\+)?(?:private-entrypoint|undeclared-dependency)\]$/u.test(value)) ||
      debt.exceptions.some((value, index) => index > 0 && debt.exceptions[index - 1] >= value) ||
      !strings(violations, MAX_FILES)) {
    return ['module edge debt manifest is invalid'];
  }
  const old = new Set(debt.exceptions), current = new Set(violations);
  return [
    ...[...current].filter(edge => !old.has(edge)).map(edge => `new module edge bypass: ${edge}`),
    ...debt.exceptions.filter(edge => !current.has(edge)).map(edge => `stale module edge debt: ${edge}`),
  ].sort();
}

module.exports = {
  moduleCoverage, moduleEdgeDebtErrors, moduleImportViolations,
  moduleMapErrors, parseModuleMap, schemaErrors, sourceInScope,
};
