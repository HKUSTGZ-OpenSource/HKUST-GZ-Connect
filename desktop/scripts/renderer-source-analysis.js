'use strict';

const { parse } = require('acorn');
const ROOT = Symbol('browser global');
const GLOBAL_NAMES = new Set(['window', 'self', 'globalThis', 'global']);
const GLOBAL_READ_NAMES = new Set([...GLOBAL_NAMES, 'document', 'navigator', 'location',
  'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'WebSocket']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const MAX_BYTES = 2 * 1024 * 1024;

function children(node) {
  return Object.entries(node).flatMap(([key, value]) => {
    if (Array.isArray(value)) return value.filter(item => item?.type).map(child => ({ child, key }));
    return value?.type ? [{ child: value, key }] : [];
  });
}
function add(target, values) {
  let changed = false;
  for (const value of values) if (!target.has(value)) { target.add(value); changed = true; }
  return changed;
}
function union(...sets) { return new Set(sets.flatMap(value => [...value])); }
function literalKey(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal') return String(node.value);
  return null;
}

function analyzeRendererSource(source, { module = false } = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_BYTES) {
    throw new TypeError('Renderer source exceeds the analysis bound');
  }
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', locations: true });
  const scopes = new WeakMap();
  const functionScopes = new Map();
  const returns = new Map();
  const bindings = [];
  const calls = [];
  const nodes = [];
  const parents = new WeakMap();
  const parameterFlows = new Map();
  const program = { parent: null, function: true, names: new Map() };
  const lookup = (scope, name) => {
    for (let current = scope; current; current = current.parent) {
      if (current.names.has(name)) return current.names.get(name);
    }
    return null;
  };
  function declare(scope, name, value = []) {
    if (!scope.names.has(name)) scope.names.set(name, { values: new Set() });
    const binding = scope.names.get(name);
    add(binding.values, value);
    return binding;
  }
  function pattern(scope, node, init = null, path = []) {
    if (!node) return;
    if (node.type === 'Identifier') {
      const target = declare(scope, node.name);
      if (init) bindings.push({ target, init, scope, path });
    } else if (node.type === 'AssignmentPattern') {
      pattern(scope, node.left, init, path);
      pattern(scope, node.left, node.right);
    } else if (node.type === 'ObjectPattern') {
      for (const property of node.properties) {
        if (property.type === 'Property' && !property.computed) {
          pattern(scope, property.value, init, [...path, literalKey(property.key)]);
        } else pattern(scope, property.argument);
      }
    } else if (node.type === 'ArrayPattern') {
      node.elements.forEach((element, index) => pattern(scope, element, init, [...path, String(index)]));
    } else if (node.type === 'RestElement') pattern(scope, node.argument);
  }
  function visit(node, outer, owner = null) {
    let scope = outer;
    if (FUNCTIONS.has(node.type)) {
      if (node.type === 'FunctionDeclaration' && node.id) declare(outer, node.id.name, [node]);
      scope = { parent: outer, function: true, lexicalThis: node.type === 'ArrowFunctionExpression', names: new Map() };
      if (node.id) declare(scope, node.id.name, [node]);
      for (const param of node.params) pattern(scope, param);
      functionScopes.set(node, scope);
      returns.set(node, { expressions: [], values: new Set() });
      if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
        returns.get(node).expressions.push(node.body);
      }
      owner = node;
    } else if (['BlockStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement',
      'SwitchStatement', 'StaticBlock'].includes(node.type)) {
      scope = { parent: outer, function: false, names: new Map() };
      if (node.type === 'CatchClause') pattern(scope, node.param);
    }
    scopes.set(node, scope);
    nodes.push(node);
    if (node.type === 'VariableDeclaration') {
      let destination = scope;
      if (node.kind === 'var') while (!destination.function) destination = destination.parent;
      for (const item of node.declarations) pattern(destination, item.id, item.init);
    }
    if (node.type === 'ClassDeclaration' && node.id) declare(scope, node.id.name);
    if (node.type === 'ImportDeclaration') for (const item of node.specifiers) declare(scope, item.local.name);
    if (node.type === 'ReturnStatement' && owner && node.argument) returns.get(owner).expressions.push(node.argument);
    if (node.type === 'CallExpression') calls.push(node);
    for (const { child, key } of children(node)) {
      parents.set(child, { node, key });
      visit(child, scope, owner);
    }
  }
  visit(ast, program);

  function member(objects, key) {
    const result = new Set();
    for (const object of objects) {
      if (object === ROOT && ['window', 'self', 'globalThis'].includes(key)) result.add(ROOT);
      if (object === ROOT && ['eval', 'Function'].includes(key)) result.add(`builtin:${key}`);
      if (['builtin:Object', 'builtin:Reflect'].includes(object)) result.add(`${object}.${key}`);
      if (object?.type === 'ObjectExpression') {
        for (const property of object.properties) {
          if (property.type === 'Property' && keyFor({ property: property.key, computed: property.computed }) === key) {
            add(result, property.kind === 'get' ? (returns.get(property.value)?.values || new Set())
              : values(property.value));
          }
        }
      }
      if (object?.type === 'ArrayExpression' && /^\d+$/u.test(key || '')) {
        add(result, values(object.elements[Number(key)]));
      }
    }
    return result;
  }
  function keyFor(node) {
    if (!node.computed) return literalKey(node.property);
    const keys = [...values(node.property)].filter(value => typeof value === 'string' && value.startsWith('string:'));
    return keys.length === 1 ? keys[0].slice(7) : null;
  }
  const evaluating = new Set();
  function values(node, fallback = program) {
    if (!node || evaluating.has(node)) return new Set();
    evaluating.add(node);
    try { return expressionValues(node, fallback); }
    finally { evaluating.delete(node); }
  }
  function expressionValues(node, fallback) {
    if (!node) return new Set();
    const scope = scopes.get(node) || fallback;
    if (node.type === 'ThisExpression' && !module) {
      let owner = scope;
      while (owner && (!owner.function || owner.lexicalThis)) owner = owner.parent;
      if (owner === program) return new Set([ROOT]);
    }
    if (node.type === 'Identifier') {
      const binding = lookup(scope, node.name);
      if (binding) return binding.values;
      if (GLOBAL_NAMES.has(node.name)) return new Set([ROOT]);
      if (['Object', 'Reflect'].includes(node.name)) return new Set([`builtin:${node.name}`]);
      if (['eval', 'Function'].includes(node.name)) return new Set([`builtin:${node.name}`]);
    }
    if (node.type === 'Literal' && ['string', 'number'].includes(typeof node.value)) {
      return new Set([`string:${node.value}`]);
    }
    if (FUNCTIONS.has(node.type) || ['ObjectExpression', 'ArrayExpression'].includes(node.type)) return new Set([node]);
    if (node.type === 'ConditionalExpression') return union(values(node.consequent), values(node.alternate));
    if (node.type === 'LogicalExpression') return union(values(node.left), values(node.right));
    if (node.type === 'ChainExpression') return values(node.expression);
    if (node.type === 'SequenceExpression') return values(node.expressions.at(-1));
    if (node.type === 'AssignmentExpression') return values(node.right);
    if (node.type === 'MemberExpression') return member(values(node.object), keyFor(node));
    if (node.type === 'CallExpression') {
      return union(...[...values(node.callee)].map(fn => returns.get(fn)?.values || new Set()));
    }
    return new Set();
  }
  let changed = true;
  for (let round = 0; changed && round < 64; round += 1) {
    changed = false;
    for (const flow of bindings) {
      let result = values(flow.init, flow.scope);
      for (const key of flow.path) result = member(result, key);
      changed = add(flow.target.values, result) || changed;
    }
    for (const node of nodes) {
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
        const target = lookup(scopes.get(node), node.left.name);
        if (target) changed = add(target.values, values(node.right)) || changed;
      }
    }
    for (const call of calls) for (const fn of values(call.callee)) {
      const scope = functionScopes.get(fn);
      if (!scope) continue;
      if (!parameterFlows.has(call)) parameterFlows.set(call, new Set());
      const registered = parameterFlows.get(call);
      if (!registered.has(fn)) {
        fn.params.forEach((param, index) => pattern(scope, param, call.arguments[index]));
        registered.add(fn);
        changed = true;
      }
      fn.params.forEach((param, index) => {
        if (param.type === 'Identifier') changed = add(lookup(scope, param.name).values,
          values(call.arguments[index])) || changed;
      });
    }
    for (const entry of returns.values()) for (const expression of entry.expressions) {
      changed = add(entry.values, values(expression)) || changed;
    }
    if (round === 63 && changed) throw new TypeError('Renderer alias analysis did not converge');
  }

  const exports = new Set();
  const errors = [];
  const imports = new Set();
  const moduleExports = new Set();
  const error = (node, message) => errors.push(`${node.loc.start.line}: ${message}`);
  const publish = (node, name) => {
    if (!name || !/^[A-Za-z_$][\w$]*$/u.test(name)) error(node, 'dynamic global export is forbidden');
    else exports.add(name);
  };
  const string = node => {
    const list = [...values(node)].filter(value => typeof value === 'string' && value.startsWith('string:'));
    return list.length === 1 ? list[0].slice(7) : null;
  };
  const importSource = (node, value) => {
    if (typeof value !== 'string') error(node, 'dynamic module path is forbidden');
    else imports.add(value);
  };
  function inspectWrite(target, node) {
    if (!target) return;
    if (target.type === 'MemberExpression' && values(target.object).has(ROOT)) publish(node, keyFor(target));
    if (target.type === 'Identifier' && !lookup(scopes.get(target), target.name)) publish(node, target.name);
    if (target.type === 'ObjectPattern') {
      for (const property of target.properties) inspectWrite(property.value || property.argument, node);
    }
    if (target.type === 'ArrayPattern') for (const element of target.elements) inspectWrite(element, node);
    if (target.type === 'AssignmentPattern') inspectWrite(target.left, node);
    if (target.type === 'RestElement') inspectWrite(target.argument, node);
  }
  for (const node of nodes) {
    if (['CallExpression', 'NewExpression'].includes(node.type) &&
        [...values(node.callee)].some(value => ['builtin:eval', 'builtin:Function'].includes(value))) {
      error(node, 'dynamic code execution is forbidden');
    }
    if (node.type === 'ExportDefaultDeclaration') moduleExports.add('default');
    if (node.type === 'ExportAllDeclaration') {
      if (node.exported) moduleExports.add(literalKey(node.exported));
      else error(node, 'wildcard module exports must be explicit');
    }
    if (node.type === 'ExportNamedDeclaration') {
      for (const item of node.specifiers) moduleExports.add(literalKey(item.exported));
      if (node.declaration?.id) moduleExports.add(node.declaration.id.name);
      for (const item of node.declaration?.declarations || []) {
        if (item.id.type === 'Identifier') moduleExports.add(item.id.name);
        else error(node, 'destructured public exports must be explicit');
      }
    }
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
      importSource(node, node.source.value);
    }
    if (node.type === 'ImportExpression') importSource(node, string(node.source));
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      inspectWrite(node.left || node.argument, node);
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' &&
          values(node.right).has(ROOT) && !values(node.left.object).has(ROOT)) {
        error(node, 'browser global stored in mutable member is forbidden');
      }
    }
    if (['ForInStatement', 'ForOfStatement'].includes(node.type) && node.left.type !== 'VariableDeclaration') {
      inspectWrite(node.left, node);
    }
  }
  for (const call of calls) {
    if (call.callee.type === 'Identifier' && call.callee.name === 'require' && !lookup(scopes.get(call), 'require')) {
      importSource(call, string(call.arguments[0]));
    }
    for (const writer of values(call.callee)) {
      if (!values(call.arguments[0]).has(ROOT)) continue;
      if (['builtin:Object.defineProperty', 'builtin:Reflect.defineProperty', 'builtin:Reflect.set'].includes(writer)) {
        publish(call, string(call.arguments[1]));
      }
      if (['builtin:Object.assign', 'builtin:Object.defineProperties'].includes(writer)) {
        for (const arg of call.arguments.slice(1)) {
          const objects = [...values(arg)];
          if (!objects.length || objects.some(object => object?.type !== 'ObjectExpression')) {
            error(call, 'dynamic global export object is forbidden'); continue;
          }
          for (const object of objects) for (const property of object.properties) {
            publish(property, property.type === 'Property'
              ? (property.computed ? string(property.key) : literalKey(property.key)) : null);
          }
        }
      }
    }
    if (call.arguments.some(argument => values(argument).has(ROOT)) &&
        ![...values(call.callee)].some(value => functionScopes.has(value) ||
          /^builtin:(?:Object|Reflect)\.(?:assign|defineProperty|defineProperties|set|keys|values|entries|ownKeys|hasOwn|getOwnPropertyDescriptor|getOwnPropertyNames|getPrototypeOf|isFrozen)$/u.test(String(value)))) {
      error(call, 'opaque call receives the browser global');
    }
  }
  if (!module) for (const name of program.names.keys()) exports.add(`@binding:${name}`);
  const globalReads = nodes.filter(node => {
    if (node.type !== 'Identifier' || !GLOBAL_READ_NAMES.has(node.name) || lookup(scopes.get(node), node.name)) return false;
    const parent = parents.get(node);
    if (parent?.key === 'property' && !parent.node.computed) return false;
    if (parent?.key === 'key' && !parent.node.computed && !parent.node.shorthand) return false;
    return true;
  }).length;
  return Object.freeze({ module, exports: [...exports].sort(), moduleExports: [...moduleExports].sort(),
    imports: [...imports].sort(), globalReads,
    errors: [...new Set(errors)].sort() });
}

module.exports = { analyzeRendererSource };
