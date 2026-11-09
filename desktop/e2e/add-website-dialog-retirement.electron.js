'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'hkust-website-dialog-')));
app.disableHardwareAcceleration();
const wait = () => new Promise(resolve => setTimeout(resolve, 100));
async function main() {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('file:') });
  });
  const window = new BrowserWindow({ width: 1000, height: 760, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(__dirname, 'resource-manager-layout-preload.js') } });
  const run = source => window.webContents.executeJavaScript(source);
  const finish = async outcome => { await run(`window.api.testFinishWebsiteRequest(0, ${JSON.stringify(outcome)})`); await wait(); };
  const hold = kind => run(`window.api.testHoldWebsiteRequest(${JSON.stringify(kind)})`);
  const open = (name = 'New draft') => run(`document.getElementById('addWebsite').click();
    document.getElementById('addWebsiteUrl').value='https://synthetic.example.edu/';
    document.getElementById('addWebsiteName').value=${JSON.stringify(name)};`);
  const submit = async () => { await run(`document.getElementById('addWebsiteForm').requestSubmit()`); await wait(); };
  const inspect = () => run(`({open:document.getElementById('addWebsiteDialog').open,
    name:document.getElementById('addWebsiteName').value,error:document.getElementById('addWebsiteError').textContent,
    busy:document.getElementById('submitAddWebsite').disabled,focus:document.activeElement.id,
    pending:window.api.testPendingWebsiteRequests(),state:window.api.testState()})`);
  const escape = async () => {
    window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await wait();
    assert.equal((await inspect()).open, false, 'native Escape must dismiss this dialog');
  };
  try {
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')); await wait();
    await run(`document.querySelector('.nav[data-page="browser"]').click();document.getElementById('serviceTabPersonal').click()`);
    for (const outcome of ['success', 'failure', 'reject']) {
      await hold('create'); await open('First draft'); await submit();
      assert.deepEqual((await inspect()).pending, ['create']);
      await escape(); await open();
      const previousOpen = (await inspect()).state.lastOpenRequest;
      await finish(outcome);
      const next = await inspect();
      assert.equal(next.open, true, `${outcome}: old create closed the newer draft`);
      assert.equal(next.name, 'New draft'); assert.equal(next.error, '');
      assert.equal(next.focus, 'addWebsiteUrl'); assert.deepEqual(next.state.lastOpenRequest, previousOpen);
      if (outcome === 'success') {
        const saved = next.state.resources.find(resource => resource.name === 'First draft');
        assert.ok(saved, 'committed resource disappeared');
        assert.equal(await run(`(() => {
          const search=document.getElementById('resourceSearch');search.value='First draft';search.dispatchEvent(new Event('input'));
          const found=!!document.querySelector('[data-personal-site="${saved.id}"]');search.value='';search.dispatchEvent(new Event('input'));return found;
        })()`), true, 'retired success did not reconcile the Control resource model');
      }
      await escape();
    }
    // Native close is queued: reopening in the same task must survive its late event.
    await open(); await run(`document.getElementById('addWebsiteDialog').close();document.getElementById('addWebsite').click();document.getElementById('addWebsiteName').value='Queued close draft'`);
    await wait(); assert.equal((await inspect()).name, 'Queued close draft'); await escape();
    await hold('preview'); await open(); await submit(); await submit();
    assert.deepEqual((await inspect()).pending, ['preview'], 'preview must own single submission');
    await escape(); await open(); await finish('failure');
    assert.equal((await inspect()).error, ''); assert.equal((await inspect()).name, 'New draft'); await escape();
    // Enter disables the focused URL; its blur and queued debounce must not replace the submitted preview.
    await hold('preview'); await open('Keyboard save');
    await run(`document.getElementById('addWebsiteUrl').dispatchEvent(new Event('input'))`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); await wait();
    assert.deepEqual((await inspect()).pending, ['preview']);
    await finish('success'); assert.equal((await inspect()).open, false, 'native Enter failed after its preview');
    // A real mouse click can start a background blur preview before the submit preview.
    await hold('preview'); await hold('preview'); await open('Mouse save');
    const button = await run(`(() => {const r=document.getElementById('submitAddWebsite').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...button, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...button, button: 'left', clickCount: 1 }); await wait();
    assert.deepEqual((await inspect()).pending, ['preview', 'preview']);
    await run(`window.api.testFinishWebsiteRequest(1, 'success')`); await wait();
    assert.equal((await inspect()).open, false, 'mouse submission lost its preview to blur');
    await open(); await finish('success'); assert.equal((await inspect()).name, 'New draft'); await escape();
    await hold('preview'); await open('Invalid draft'); await submit(); await finish('failure');
    assert.equal((await inspect()).busy, false); assert.equal((await inspect()).focus, 'addWebsiteUrl'); await escape();
    await hold('create'); await open(); await submit(); await escape();
    await hold('create'); await open(); await submit(); await finish('reject');
    assert.equal((await inspect()).busy, true, 'old finally unlocked the newer submission');
    await finish('failure'); assert.equal((await inspect()).busy, false);
    assert.equal((await inspect()).error, 'Synthetic failed request');
    await submit(); assert.equal((await inspect()).open, false, 'current retry did not save and close');
    assert.ok((await inspect()).state.lastOpenRequest?.resourceId, 'current retry did not open the saved resource');
    await hold('open'); await open(); await submit();
    assert.deepEqual((await inspect()).pending, ['open']);
    await hold('create'); await open(); await submit(); await finish('failure');
    assert.equal((await inspect()).busy, true, 'old open completion unlocked the newer submission');
    assert.equal((await inspect()).error, ''); await finish('failure'); await escape();
    // Exercise the unchanged dialog geometry and keyboard entry with the new lifetime rules.
    for (const [label, width, height, zoom] of [
      ['narrow', 500, 640, 1], ['standard', 1000, 760, 1], ['wide', 1400, 900, 1], ['zoom200', 1000, 900, 2],
    ]) {
      window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); await wait();
      await open();
      await run(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const layout = await run(`(() => { const dialog=document.getElementById('addWebsiteDialog');const r=dialog.getBoundingClientRect();return {
        left:r.left,right:r.right,width:innerWidth,overflow:dialog.scrollWidth-dialog.clientWidth,focus:document.activeElement.id,
        visibleFocus:getComputedStyle(document.activeElement).outlineStyle !== 'none' || getComputedStyle(document.activeElement).boxShadow !== 'none'
      }; })()`);
      assert.ok(layout.left >= 0 && layout.right <= layout.width, `${label}: horizontal dialog overflow`);
      assert.ok(layout.overflow <= 0, `${label}: content overflow`); assert.equal(layout.focus, 'addWebsiteUrl');
      assert.equal(layout.visibleFocus, true, `${label}: missing input focus indicator`);
      if (process.env.HKUSTGZ_WEBSITE_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.HKUSTGZ_WEBSITE_SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.HKUSTGZ_WEBSITE_SCREENSHOT_DIR,
          `${process.env.HKUSTGZ_E2E_LOCALE || 'zh'}-${label}.png`), (await window.webContents.capturePage()).toPNG());
      }
      await escape();
    }
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
    await open(); await submit(); assert.equal((await inspect()).open, false);
    window.webContents.debugger.detach();
    process.stdout.write(`add website retirement: PASS (${process.platform}, ${process.env.HKUSTGZ_E2E_LOCALE || 'zh'})\n`);
  } finally { window.destroy(); }
}
main().then(() => app.quit(), error => { console.error(error); app.exit(1); });
