'use strict';

// Repository source contract, not a general HTML parser: canonical external script tags only.
const fs = require('node:fs');
const path = require('node:path');
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function parseScriptEntries(markup, page) {
  if (typeof markup !== 'string' || Buffer.byteLength(markup) > MAX_HTML_BYTES ||
      !/^renderer\/[a-zA-Z0-9_./-]+\.html$/u.test(page) || page.split('/').includes('..')) {
    throw new TypeError('invalid Renderer HTML source');
  }
  const source = markup.replace(/<!--[\s\S]*?-->/gu, '');
  if (source.includes('<!--') || source.includes('-->')) throw new TypeError('noncanonical Renderer HTML comment');
  if (/<base\b/iu.test(source)) throw new TypeError('Renderer base URL override is forbidden');
  const entries = [], seen = new Set();
  const remaining = source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu, (_tag, attributes, body) => {
    if (body.trim()) throw new TypeError('inline Renderer script content is forbidden');
    const values = new Map();
    let rest = attributes;
    while (rest.trim()) {
      const match = rest.match(/^\s+([a-zA-Z][\w-]*)\s*=\s*(["'])(.*?)\2/su);
      if (!match) throw new TypeError('noncanonical Renderer script attributes');
      const name = match[1].toLowerCase();
      if (!['src','type'].includes(name) || values.has(name)) throw new TypeError('ambiguous Renderer script attributes');
      values.set(name,match[3]); rest = rest.slice(match[0].length);
    }
    const src = values.get('src'), type = (values.get('type') || '').toLowerCase();
    if (!src || src.startsWith('/') || !/^[a-zA-Z0-9_./-]+\.(?:js|mjs)$/u.test(src) ||
        !['','module','text/javascript','application/javascript'].includes(type)) {
      throw new TypeError('noncanonical Renderer script source or type');
    }
    const file = path.posix.normalize(path.posix.join(path.posix.dirname(page), src));
    if (file.startsWith('../') || seen.has(file)) throw new TypeError('escaped or duplicate Renderer script');
    seen.add(file); entries.push({page,file,module:type === 'module'});
    if (entries.length > 256) throw new TypeError('Renderer script inventory exceeds bound');
    return '';
  });
  if (/<\/?script\b/iu.test(remaining)) throw new TypeError('incomplete Renderer script tag');
  return entries;
}

function modulePaths(entries) {
  const modes = new Map();
  for (const entry of entries) {
    if (modes.has(entry.file) && modes.get(entry.file) !== entry.module) {
      throw new TypeError('Renderer script is loaded in conflicting modes');
    }
    modes.set(entry.file,entry.module);
  }
  return new Set([...modes].filter(([,module])=>module).map(([file])=>file));
}

function collectRendererScriptEntries(root) {
  const pages = []; let visited = 0;
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(root,directory),{withFileTypes:true})) {
      if (++visited > 4096 || entry.isSymbolicLink()) throw new TypeError('invalid Renderer HTML inventory');
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile() && entry.name.endsWith('.html')) pages.push(relative);
    }
  }
  visit('renderer');
  if (!pages.includes('renderer/index.html') || pages.length > 64) throw new TypeError('invalid Renderer HTML page set');
  return pages.sort().flatMap(page => {
    if (fs.statSync(path.join(root,page)).size > MAX_HTML_BYTES) throw new TypeError('oversized Renderer HTML source');
    return parseScriptEntries(fs.readFileSync(path.join(root,page),'utf8'),page);
  });
}

module.exports = { parseScriptEntries, modulePaths, collectRendererScriptEntries };
