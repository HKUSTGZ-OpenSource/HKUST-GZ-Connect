'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// This fixture owns synthetic storage; it never opens installed application data.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-search-focus-')));
const locale = process.env.HKUSTGZ_E2E_LOCALE === 'en' ? 'en' : 'zh';
const output = process.env.HKUSTGZ_SEARCH_FOCUS_OUTPUT;
const rows = [];
if (output) fs.mkdirSync(output, { recursive: true });

async function waitFor(window, expression, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function key(window, keyCode, modifiers = []) {
  for (const type of ['keyDown', 'keyUp']) {
    window.webContents.sendInputEvent({ type, keyCode, modifiers });
  }
}

async function inspect(window) {
  return window.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('resourceSearch');
    const badge = document.querySelector('.ws-search kbd');
    const group = input.parentElement;
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
    };
    const style = getComputedStyle(input);
    const inputRect = rect(input), groupRect = rect(group), badgeRect = rect(badge);
    const outset = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    const outlineRect = {
      left:inputRect.left-outset, top:inputRect.top-outset,
      right:inputRect.right+outset, bottom:inputRect.bottom+outset,
    };
    const contained = (inner, outer) => inner.left >= outer.left - 1 &&
      inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
    const viewport = { left:0, top:0, right:innerWidth, bottom:innerHeight };
    const clippingAncestors = [];
    for (let node = input.parentElement; node; node = node.parentElement) {
      const s = getComputedStyle(node), r = rect(node);
      if (/(hidden|clip|auto|scroll)/.test(s.overflowX) &&
          (outlineRect.left < r.left-1 || outlineRect.right > r.right+1) ||
          /(hidden|clip|auto|scroll)/.test(s.overflowY) &&
          (outlineRect.top < r.top-1 || outlineRect.bottom > r.bottom+1)) {
        clippingAncestors.push(node.id || node.className || node.tagName);
      }
    }
    return {
      documentFocused: document.hasFocus(), focused: document.activeElement === input,
      focusVisible: input.matches(':focus-visible'),
      outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor, outlineOffset: parseFloat(style.outlineOffset),
      locale: document.documentElement.lang,
      personal: !document.getElementById('servicePersonalView').hidden,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      viewport: { width:innerWidth, height:innerHeight },
      inputRect, groupRect, badgeRect, outlineRect, clippingAncestors,
      outlineContained: contained(outlineRect, groupRect) && contained(outlineRect, viewport),
      badgeContained: badgeRect.width > 0 && contained(badgeRect, groupRect) && contained(badgeRect, viewport),
      separated: outlineRect.right <= badgeRect.left + 1,
      badgeOverflow: badge.scrollWidth - badge.clientWidth,
      searchOverflow: group.scrollWidth - group.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`);
}

function assertFocus(row, label, keyboard) {
  assert.equal(row.documentFocused, true, `${label}: native document focus`);
  assert.equal(row.focused, true, `${label}: actual input focus`);
  if (keyboard) assert.equal(row.focusVisible, true, `${label}: keyboard focus-visible semantics`);
  if (row.focusVisible) {
    assert.ok(row.outlineWidth > 0 && !['none', 'hidden'].includes(row.outlineStyle),
      `${label}: focused search needs a visible outline`);
    assert.notEqual(row.outlineColor, 'transparent', `${label}: transparent outline`);
    assert.doesNotMatch(row.outlineColor, /rgba\([^)]*,\s*0\s*\)$/u);
    assert.equal(row.outlineContained, true, `${label}: focus outline is clipped`);
    assert.deepEqual(row.clippingAncestors, [], `${label}: ancestor clips focus outline`);
    assert.equal(row.separated, true, `${label}: outline overlaps shortcut badge`);
  }
  assert.equal(row.badgeContained, true, `${label}: shortcut badge is clipped`);
  assert.ok(row.badgeOverflow <= 1 && row.searchOverflow <= 1 && row.pageOverflow <= 1,
    `${label}: horizontal overflow`);
}

async function record(window, context, entry) {
  // Wait out finite page transitions before geometry assertions and screenshots.
  await waitFor(window, `document.getAnimations().every(animation =>
    animation.playState !== 'running' ||
    !Number.isFinite(animation.effect.getComputedTiming().endTime))`, 'settled page animations');
  await window.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const row = { ...context, entry, zoom: window.webContents.getZoomFactor(), ...await inspect(window) };
  rows.push(row);
  if (output) {
    fs.writeFileSync(path.join(output, 'search-focus.json'), JSON.stringify(rows, null, 2));
    if (entry === 'shortcut' || entry === 'pointer') {
      const name = `${locale}-${context.width}-${context.view}-zoom${context.zoom}-${context.motion}-${entry}.png`;
      fs.writeFileSync(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    }
  }
  assertFocus(row, JSON.stringify(context) + ' ' + entry, entry !== 'pointer');
  assert.equal(row.locale, locale === 'zh' ? 'zh-CN' : 'en');
  assert.equal(row.personal, context.view === 'personal');
  assert.equal(row.reducedMotion, context.motion === 'reduce');
  assert.equal(row.zoom, context.zoom);
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show:false, width:500, height:640,
    webPreferences: {
      contextIsolation:true, nodeIntegration:false,
      preload:path.join(__dirname, 'resource-manager-layout-preload.js'),
    },
  });
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    await waitFor(window, "!document.getElementById('dash').hidden", 'synthetic dashboard');
    window.show(); window.focus(); window.webContents.focus();
    await waitFor(window, 'document.hasFocus() && !document.hidden', 'native window focus');
    window.webContents.debugger.attach('1.3');
    for (const motion of ['no-preference', 'reduce']) {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',
        { features:[{ name:'prefers-reduced-motion', value:motion }] });
      for (const [width, height] of [[500, 640], [840, 900], [1180, 900]]) {
        for (const zoom of [1, 1.25]) {
          window.setContentSize(width, height);
          window.webContents.setZoomFactor(zoom);
          await waitFor(window, `Math.abs(innerWidth * ${zoom} - ${width}) <= 1`, 'resized viewport');
          const actualSize = window.getContentSize();
          for (const view of ['official', 'personal']) {
            const context = { width, height, actualSize, zoom, view, motion };
            await window.webContents.executeJavaScript(`
              document.querySelector('.nav[data-page="browser"]').click();
              document.getElementById('${view === 'personal' ? 'serviceTabPersonal' : 'serviceTabOfficial'}').click();
              document.getElementById('openCampusWorkspace').focus();
            `);
            key(window, 'K', [process.platform === 'darwin' ? 'meta' : 'control']);
            await waitFor(window, "document.activeElement.id === 'resourceSearch'", 'native search shortcut');
            await record(window, context, 'shortcut');

            // The next control follows search in DOM order. Native Shift+Tab must reach search.
            await window.webContents.executeJavaScript("document.getElementById('openCampusWorkspace').focus()");
            key(window, 'Tab', ['shift']);
            await waitFor(window, "document.activeElement.id === 'resourceSearch'", 'ordinary Shift+Tab entry');
            await record(window, context, 'shift-tab');
            key(window, 'Tab', ['shift']);
            await waitFor(window, "document.activeElement.id !== 'resourceSearch'", 'previous tab stop');
            key(window, 'Tab');
            await waitFor(window, "document.activeElement.id === 'resourceSearch'", 'ordinary Tab entry');
            await record(window, context, 'tab');

            await window.webContents.executeJavaScript("document.getElementById('openCampusWorkspace').focus()");
            const rect = (await inspect(window)).inputRect;
            for (const type of ['mouseDown', 'mouseUp']) window.webContents.sendInputEvent({
              type, x:Math.round((rect.left + rect.right) / 2 * zoom),
              y:Math.round((rect.top + rect.bottom) / 2 * zoom), button:'left', clickCount:1,
            });
            await waitFor(window, "document.activeElement.id === 'resourceSearch'", 'native pointer entry');
            await record(window, context, 'pointer');
          }
        }
      }
    }
    process.stdout.write(`workspace search focus (${locale}): PASS (${rows.length} entry checks)\n`);
  } finally {
    if (!window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.destroy();
    }
  }
}

main().then(() => app.quit(), error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
