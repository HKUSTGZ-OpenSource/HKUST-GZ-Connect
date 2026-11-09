'use strict';

const assert = require('node:assert/strict');

async function exerciseWorkspaceGroupDialog({ window, controller, capture }) {
  const run = source => window.webContents.executeJavaScript(source);
  const wait = () => new Promise(resolve => setTimeout(resolve, 80));
  const calls = [], pending = [];
  const originalCommand = controller.onCommand, originalLocale = controller.getLocale;
  let holdNext = false;
  controller.onCommand = command => {
    if (!['create-group', 'rename-group'].includes(command.command)) return originalCommand(command);
    calls.push(command);
    if (!holdNext) return { ok: true };
    holdNext = false;
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  };
  const inspect = () => run(`({open:document.getElementById('groupDialog').open,
    name:document.getElementById('groupName').value,error:document.getElementById('groupError').textContent,
    busy:document.getElementById('saveGroup').disabled,focus:document.activeElement.id})`);
  const open = async (name = 'Synthetic category', rename = false) => {
    await run(`${rename
      ? `openGroupDialog({id:'group_abcdefghijkl',name:'Existing category'})`
      : `document.getElementById('primaryWorkspace').click();document.getElementById('quickCreateGroup').focus();document.getElementById('quickCreateGroup').click()`};
      document.getElementById('groupName').value=${JSON.stringify(name)};document.getElementById('groupName').focus();`);
  };
  const key = async keyCode => {
    window.focus(); window.webContents.focus();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Return') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await wait();
  };
  const finish = async (outcome, index = 0) => {
    const operation = pending.splice(index, 1)[0];
    assert.ok(operation, 'expected a pending group mutation');
    if (outcome === 'reject') operation.reject(new Error('Synthetic internal failure'));
    else operation.resolve(outcome === 'success' ? { ok: true } : { ok: false, error: 'Synthetic group failure' });
    await wait();
  };
  try {
    for (const locale of ['zh', 'en']) {
      controller.getLocale = () => locale;
      controller.sendState(window.webContents); await wait();
      let before = calls.length;
      await open(); await key('Return');
      assert.equal(calls.length, before + 1, `${locale}: native Enter must create exactly once`);
      assert.deepEqual(calls.at(-1), { command: 'create-group', name: 'Synthetic category' });
      assert.equal((await inspect()).open, false);
      before = calls.length; await open('Click category');
      await run(`document.getElementById('saveGroup').click()`); await wait();
      assert.deepEqual(calls.slice(before), [{ command: 'create-group', name: 'Click category' }]);
      assert.equal((await inspect()).open, false);
      for (const name of ['', 'x'.repeat(31)]) {
        before = calls.length; await open(name); await key('Return');
        const invalid = await inspect();
        assert.equal(invalid.open, true); assert.equal(invalid.focus, 'groupName');
        assert.equal(invalid.error, locale === 'en'
          ? 'Enter a category name between 1 and 30 characters' : '请输入 1–30 个字符的分类名称');
        assert.equal(calls.length, before); await key('Escape');
      }
      for (const action of ['Cancel', 'Escape']) {
        before = calls.length; await open();
        if (action === 'Cancel') await run(`document.getElementById('cancelGroup').click()`);
        else await key('Escape');
        await wait(); assert.equal((await inspect()).open, false); assert.equal(calls.length, before);
        assert.equal((await inspect()).focus, 'quickCreateGroup');
      }
      before = calls.length; holdNext = true; await open(); await key('Return');
      await key('Return'); await key('Return');
      await run(`document.querySelector('#groupDialog form').requestSubmit()`); await wait();
      assert.equal(calls.length, before + 1, 'busy Enter or form submission duplicated the command');
      assert.equal((await inspect()).busy, true); await finish('failure');
      assert.equal((await inspect()).error, 'Synthetic group failure'); assert.equal((await inspect()).busy, false);
      await key('Return'); assert.equal(calls.length, before + 2); assert.equal((await inspect()).open, false);
      for (const outcome of ['success', 'failure', 'reject']) {
        holdNext = true; await open('Old category'); await key('Return'); await key('Escape');
        holdNext = true; await open('New category'); await key('Return');
        await finish(outcome);
        const current = await inspect();
        assert.equal(current.open, true); assert.equal(current.name, 'New category');
        assert.equal(current.error, ''); assert.equal(current.busy, true);
        await finish('success'); assert.equal((await inspect()).open, false);
      }
      // The existing rename owner uses this form; it has no new visible entrypoint.
      before = calls.length; await open('Renamed category', true); await key('Return');
      assert.deepEqual(calls.slice(before), [{ command: 'rename-group', groupId: 'group_abcdefghijkl', name: 'Renamed category' }]);
      await open();
      await run(`document.getElementById('groupDialog').close();openGroupDialog({id:'group_abcdefghijkl',name:'Queued rename'});`);
      await wait(); before = calls.length; await key('Return');
      assert.deepEqual(calls.slice(before), [{ command: 'rename-group', groupId: 'group_abcdefghijkl', name: 'Queued rename' }],
        'queued old close event retired the newer rename identity');
      for (const [label, width, height, zoom] of [
        ['narrow', 660, 720, 1], ['standard', 1040, 740, 1], ['wide', 1400, 900, 1], ['zoom125', 1000, 760, 1.25],
      ]) {
        window.setContentSize(width, height); window.webContents.setZoomFactor(zoom); await wait();
        await open(); await run(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const layout = await run(`(() => { const dialog=document.getElementById('groupDialog'),r=dialog.getBoundingClientRect(),
          save=document.getElementById('saveGroup').getBoundingClientRect(),style=getComputedStyle(document.activeElement);
          return {width:innerWidth,height:innerHeight,left:r.left,right:r.right,top:r.top,bottom:r.bottom,saveBottom:save.bottom,
            overflow:dialog.scrollWidth-dialog.clientWidth,focus:document.activeElement.id,
            visibleFocus:(style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>0)||style.boxShadow!=='none'}; })()`);
        assert.ok(Math.abs(layout.width - width / zoom) <= 1); assert.equal(window.webContents.getZoomFactor(), zoom);
        assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height);
        assert.ok(layout.saveBottom <= layout.bottom && layout.overflow <= 0);
        assert.equal(layout.focus, 'groupName'); assert.equal(layout.visibleFocus, true);
        await capture(window, `group-${locale}-${label}`); await key('Escape');
      }
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
      await open(); await key('Return'); assert.equal((await inspect()).open, false);
      window.webContents.debugger.detach(); window.webContents.setZoomFactor(1);
    }
    process.stdout.write('workspace group dialog: PASS (zh/en, native Enter, retirement, layout)\n');
  } finally {
    controller.onCommand = originalCommand; controller.getLocale = originalLocale;
  }
}

module.exports = { exerciseWorkspaceGroupDialog };
