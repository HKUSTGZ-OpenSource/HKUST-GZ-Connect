'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function exerciseAddWebsiteZoom(window) {
  const run = source => window.webContents.executeJavaScript(source);
  const pause = () => new Promise(resolve => setTimeout(resolve, 100));
  const observations = [];
  let currentCase = 'setup';
  async function inputState(stage) {
    const input = await run(`(() => {const field=document.getElementById('addWebsiteUrl');return {
      value:field.value.slice(0,2048),valueLength:field.value.length,
      selectionStart:field.selectionStart,selectionEnd:field.selectionEnd,disabled:field.disabled,
      documentFocused:document.hasFocus(),focus:document.activeElement.id,
      preview:document.getElementById('addWebsitePreview').textContent.slice(0,512),
      previewHidden:document.getElementById('addWebsitePreview').hidden,
      route:document.getElementById('addWebsiteRoute').value,
      conflictHidden:document.getElementById('addWebsiteConflict').hidden,
      error:document.getElementById('addWebsiteError').textContent.slice(0,512)};})()`);
    return { stage, case: currentCase, locale: process.env.HKUSTGZ_E2E_LOCALE || 'zh',
      zoom: window.webContents.getZoomFactor(), windowFocused: window.isFocused(), ...input };
  }
  async function waitFor(expression, deadline = Date.now() + 3000, stage = 'condition') {
    while (Date.now() < deadline) {
      if (await run(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const input = await inputState(stage).catch(() => ({ stage, case: currentCase, unavailable: true }));
    throw new Error(`Add Website fixture did not settle: ${expression}; input=${JSON.stringify(input)}`);
  }
  async function key(keyCode, modifiers = []) {
    window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Return' || keyCode === 'Space') {
      window.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : ' ' });
    }
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause();
  }
  const open = async () => { await run(`document.getElementById('addWebsite').click()`); await pause(); };
  async function typeUrl(value, previewExpression) {
    const deadline = Date.now() + 3000;
    window.focus(); window.webContents.focus();
    await waitFor('document.hasFocus()', deadline, 'input-focus');
    // Select fixture text directly; menu accelerators are not under test here.
    await run(`(() => {const field=document.getElementById('addWebsiteUrl');field.focus();field.select();})()`);
    const selected = await inputState('selected');
    assert.ok(selected.documentFocused && selected.focus === 'addWebsiteUrl' && !selected.disabled &&
      selected.selectionStart === 0 && selected.selectionEnd === selected.valueLength,
      `URL selection was not ready: ${JSON.stringify(selected)}`);
    await window.webContents.insertText(value);
    const inserted = await inputState('inserted');
    assert.equal(inserted.value, value, `Native URL input differed: ${JSON.stringify(inserted)}`);
    assert.ok(inserted.selectionStart === value.length && inserted.selectionEnd === value.length,
      `Native URL caret did not collapse: ${JSON.stringify(inserted)}`);
    await waitFor(previewExpression, deadline, 'preview');
  }
  const validUrl = () => typeUrl('https://fixture-0.example.edu/zoom',
    `document.getElementById('addWebsitePreview').textContent.includes('fixture-0.example.edu')`);
  const count = () => run(`window.api.testState().resources.filter(resource => resource.id.startsWith('custom-test-')).length`);
  async function resize(width, height, zoom) {
    window.setContentSize(width, height); window.webContents.setZoomFactor(zoom);
    await pause();
    const [actualWidth, actualHeight] = window.getContentSize();
    await waitFor(`Math.abs(innerWidth-${actualWidth / zoom})<=1 && Math.abs(innerHeight-${actualHeight / zoom})<=1`);
    assert.equal(window.webContents.getZoomFactor(), zoom);
    return { requested: { width, height, zoom }, actualWidth, actualHeight };
  }
  async function inspect(label) {
    await run(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const result = await run(`(() => {
      const dialog=document.getElementById('addWebsiteDialog'),body=dialog.querySelector('.manager-body');
      const rect=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height}};
      const focusStyle=getComputedStyle(document.activeElement);
      return {width:innerWidth,height:innerHeight,dialog:rect(dialog),head:rect(dialog.querySelector('.dialog-head')),
        actions:rect(dialog.querySelector('.dialog-actions')),save:rect(document.getElementById('submitAddWebsite')),
        cancel:rect(document.getElementById('cancelAddWebsite')),body:rect(body),dialogScroll:dialog.scrollTop,
        bodyScroll:body.scrollTop,bodyRange:body.scrollHeight-body.clientHeight,
        overflow:dialog.scrollWidth-dialog.clientWidth,focus:document.activeElement.id,
        visibleFocus:(focusStyle.outlineStyle!=='none'&&parseFloat(focusStyle.outlineWidth)>0)||focusStyle.boxShadow!=='none'};
    })()`);
    const within = rect => rect.top >= result.dialog.top - 1 && rect.bottom <= result.dialog.bottom + 1 &&
      rect.left >= result.dialog.left - 1 && rect.right <= result.dialog.right + 1;
    assert.ok(result.dialog.top >= 0 && result.dialog.bottom <= result.height && result.dialog.left >= 0 && result.dialog.right <= result.width,
      `${label}: dialog outside viewport ${JSON.stringify(result)}`);
    for (const name of ['head', 'actions', 'save', 'cancel']) {
      assert.ok(within(result[name]), `${label}: ${name} clipped ${JSON.stringify(result)}`);
    }
    assert.equal(result.dialogScroll, 0, `${label}: outer dialog scrolled its header/actions`);
    assert.ok(result.overflow <= 0, `${label}: horizontal overflow`);
    return result;
  }
  async function wheelBody(label) {
    await run(`document.querySelector('#addWebsiteDialog .manager-body').scrollTop=0`);
    const before = await inspect(label), zoom = window.webContents.getZoomFactor();
    const point = { x: Math.round((before.body.left + 5) * zoom), y: Math.round((before.body.top + before.body.bottom) / 2 * zoom) };
    const deadline = Date.now() + 3000;
    window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: -600 });
    if (before.bodyRange > 1) {
      await waitFor(`document.querySelector('#addWebsiteDialog .manager-body').scrollTop > 0`, deadline);
      await run(`new Promise((resolve,reject)=>{
        const body=document.querySelector('#addWebsiteDialog .manager-body');let previous=-1,stable=0,done=false;
        const timer=setTimeout(()=>{done=true;reject(new Error('Body scrolling did not settle'));},Math.max(1,${deadline}-Date.now()));
        function frame(){if(done)return;const current=body.scrollTop;stable=Math.abs(current-previous)<0.01?stable+1:0;previous=current;
          if(stable>=3){done=true;clearTimeout(timer);resolve();}else requestAnimationFrame(frame);}
        requestAnimationFrame(frame);
      })`);
    }
    const after = await inspect(label + ' after wheel');
    if (before.bodyRange > 1) assert.ok(after.bodyScroll > 0, `${label}: native wheel did not scroll body ${JSON.stringify({ before, after })}`);
    return after;
  }
  async function pointer(id) {
    const rect = await run(`(() => {const r=document.getElementById('${id}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const point = { x: Math.round(rect.x * window.webContents.getZoomFactor()), y: Math.round(rect.y * window.webContents.getZoomFactor()) };
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 }); await pause();
  }
  async function tabTo(id) {
    for (let index = 0; index < 8; index++) {
      if (await run(`document.activeElement.id === '${id}'`)) return;
      await key('Tab');
    }
    throw new Error(`Could not tab to ${id}`);
  }
  const cases = [['regression', 1000, 900, 2], ...[
    ['narrow', 660, 720], ['standard', 1040, 740], ['wide', 1400, 900],
  ].flatMap(([label, width, height]) => [1, 1.25, 2].map(zoom => [label, width, height, zoom]))];
  for (const [label, width, height, zoom] of cases) {
    currentCase = `${label}/${zoom}`;
    const viewport = await resize(width, height, zoom); await open();
    await typeUrl('https://', `document.getElementById('addWebsitePreview').classList.contains('error')`);
    await key('Return'); await waitFor(`document.getElementById('addWebsiteError').textContent.length > 0`);
    await inspect(`${label}/${zoom} validation`);
    await validUrl(); await inspect(`${label}/${zoom} preview`);
    // Prepare the existing option through its change owner, which renders the conflict text.
    await run(`(() => {const route=document.getElementById('addWebsiteRoute');
      if(![...route.options].some(option=>option.value==='direct'))throw new Error('Direct route option is missing');
      route.focus();route.value='direct';route.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.getElementById('addWebsiteRoute').value === 'direct' && !document.getElementById('addWebsiteConflict').hidden`);
    const frame = await wheelBody(`${label}/${zoom} conflict`);
    observations.push({ label, ...viewport, frame });
    const output = process.env.HKUSTGZ_ADD_WEBSITE_LAYOUT_DIR;
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, `${process.env.HKUSTGZ_E2E_LOCALE || 'zh'}-${label}-${zoom}.png`),
        (await window.webContents.capturePage()).toPNG());
    }
    await key('Escape'); assert.equal(await run(`document.getElementById('addWebsiteDialog').open`), false);
  }
  // The same open form must shrink and grow without a forced tall layout.
  currentCase = 'resize-recovery';
  await resize(1400, 900, 1); await open(); await validUrl(); const natural = await inspect('natural height');
  await resize(1000, 900, 2); await wheelBody('shrunken open form');
  await resize(1400, 900, 1); const grown = await inspect('grown open form');
  assert.ok(Math.abs(grown.dialog.height - natural.dialog.height) <= 1); assert.equal(grown.bodyRange, 0);
  await key('Escape');
  await resize(1000, 900, 2);
  for (const action of ['pointer-save', 'pointer-cancel', 'enter-save', 'space-cancel']) {
    currentCase = action;
    const before = await count(); await open(); await validUrl(); await wheelBody(action);
    if (action.startsWith('pointer')) await pointer(action.endsWith('save') ? 'submitAddWebsite' : 'cancelAddWebsite');
    else {
      await tabTo(action.endsWith('save') ? 'submitAddWebsite' : 'cancelAddWebsite');
      assert.equal((await inspect('focused action')).visibleFocus, true);
      await key(action.startsWith('enter') ? 'Return' : 'Space');
    }
    await waitFor(`!document.getElementById('addWebsiteDialog').open`);
    assert.equal(await count(), before + (action.endsWith('save') ? 1 : 0));
    if (action.endsWith('save')) {
      const opened = await run(`(() => { const state=window.api.testState();return {
        actual:state.lastOpenRequest?.resourceId,
        saved:state.resources.filter(resource=>resource.id.startsWith('custom-test-')).at(-1)?.id,
      }; })()`);
      assert.equal(opened.actual, opened.saved, `${action}: saved resource was not opened`);
    }
  }
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
  currentCase = 'reduced-motion';
  await open(); await validUrl(); await wheelBody('reduced motion'); await key('Escape');
  window.webContents.debugger.detach(); window.webContents.setZoomFactor(1);
  if (process.env.HKUSTGZ_ADD_WEBSITE_LAYOUT_DIR) {
    fs.writeFileSync(path.join(process.env.HKUSTGZ_ADD_WEBSITE_LAYOUT_DIR,
      `${process.env.HKUSTGZ_E2E_LOCALE || 'zh'}-metrics.json`), JSON.stringify(observations, null, 2));
  }
  process.stdout.write(`Add Website zoom: PASS (${process.env.HKUSTGZ_E2E_LOCALE || 'zh'}, 10 viewports, native wheel/actions)\n`);
}

module.exports = { exerciseAddWebsiteZoom };
