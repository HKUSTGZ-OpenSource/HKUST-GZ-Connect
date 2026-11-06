'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function exerciseSidebarLabels(window) {
  const contents = window.webContents;
  const evaluate = source => contents.executeJavaScript(source);
  const frame = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  async function waitFor(expression) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await evaluate(typeof expression === 'function' ? expression() : expression)) { await frame(); return; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Sidebar fixture did not settle: ${expression}`);
  }
  const initialSize = window.getContentSize();
  const initialZoom = contents.getZoomFactor();
  const initialLocale = await evaluate('document.documentElement.lang');
  const failures = [], rows = [];
  const check = (condition, name) => { if (!condition) failures.push(name); };
  const output = process.env.HKUSTGZ_SIDEBAR_LAYOUT_ARTIFACTS;
  if (output) fs.mkdirSync(output, { recursive: true });
  contents.setBackgroundThrottling(false);
  window.show(); window.focus(); contents.focus();
  await waitFor('document.hasFocus() && !document.hidden');
  try {
    for (const language of ['en', 'zh']) {
      await evaluate(`(async () => { await window.api.save({language:'${language}'}); document.dispatchEvent(new Event('visibilitychange')); })()`);
      await waitFor(`document.documentElement.lang === '${language === 'zh' ? 'zh-CN' : 'en'}'`);
      for (const [width, height, zoom] of [[518,700,1],[519,700,1],[520,700,1],[608,700,1],[609,700,1],[610,700,1],[1024,768,1],[1024,768,1.25],[1440,900,1],[1024,768,2]]) {
        window.setContentSize(width, height); contents.setZoomFactor(zoom);
        await waitFor(() => {
          const [nativeWidth, nativeHeight] = window.getContentSize();
          return `Math.abs(innerWidth * ${zoom} - ${nativeWidth}) < 2 && Math.abs(innerHeight * ${zoom} - ${nativeHeight}) < 2`;
        });
        const snapshot = await evaluate(`(() => {
          const rect = node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
          return {innerWidth,innerHeight,bodyOverflow:document.documentElement.scrollWidth-innerWidth,contentOverflow:document.querySelector('.content').scrollWidth-document.querySelector('.content').clientWidth,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
            rail:rect(document.querySelector('.sidebar')),
            labels:[...document.querySelectorAll('.nav')].map(button => {
              const label=button.querySelector('.nav-label'), style=getComputedStyle(label), text=label.textContent;
              const lines=new Map(), glyphs=[];
              if (style.display !== 'none') {
                let offset=0;
                for (const character of text) {
                  const range=document.createRange(); range.setStart(label.firstChild,offset); offset+=character.length; range.setEnd(label.firstChild,offset);
                  const r=range.getBoundingClientRect();
                  if (r.width > 0) { const top=Math.round(r.top*64)/64; lines.set(top,(lines.get(top)||'')+character); glyphs.push({character,top,left:r.left,right:r.right}); }
                }
              }
              return {page:button.dataset.page,text,title:button.title,display:style.display,fontSize:parseFloat(style.fontSize),
                button:rect(button),label:rect(label),lines:[...lines.values()].map(line=>line.trim()),glyphs};
            })};
        })()`);
        const name = `${language}/${width}/${zoom}`;
        check(snapshot.bodyOverflow <= 0 && snapshot.contentOverflow <= 0, `${name}: horizontal overflow`);
        check(Math.round(snapshot.rail.width * 64) === (snapshot.innerWidth <= 519 ? 64 : 72) * 64, `${name}: rail width changed`);
        for (const label of snapshot.labels) {
          const labelName = `${name}/${label.page}`;
          check(label.title.length > 0, `${labelName}: accessible title missing`);
          check(label.button.width >= 48 && label.button.height >= 54, `${labelName}: navigation target shrank`);
          if (snapshot.innerWidth <= 519) {
            check(label.display === 'none', `${labelName}: icon-only label visible`);
            continue;
          }
          check(label.display !== 'none' && label.fontSize >= 10.5, `${labelName}: label hidden or font shrank`);
          check(label.glyphs.every(r=>r.left>=label.button.left-0.5 && r.right<=label.button.right+0.5), `${labelName}: text outside button`);
          if (language === 'en') {
            for (const word of label.text.split(/\s+/u)) check(label.lines.some(line=>line.includes(word)), `${labelName}: split word ${word}`);
          } else if (label.lines.length > 1) {
            check(label.lines.every(line=>[...line].length>=2), `${labelName}: single-character tail`);
          }
        }
        // Exercise the real navigation listener using native keyboard input.
        await evaluate("document.querySelector('.nav[data-page=connect]').focus()");
        contents.sendInputEvent({type:'keyDown',keyCode:'Tab'}); contents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
        await waitFor("document.activeElement === document.querySelector('.nav[data-page=browser]')");
        contents.sendInputEvent({type:'keyDown',keyCode:'Return'}); contents.sendInputEvent({type:'char',keyCode:'\r'}); contents.sendInputEvent({type:'keyUp',keyCode:'Return'});
        await waitFor("document.querySelector('.page.active').dataset.page === 'browser'");
        if (snapshot.innerWidth <= 519) await waitFor("parseFloat(getComputedStyle(document.activeElement,'::after').opacity) >= 0.99");
        const active = await evaluate(`(() => {
          const button=document.querySelector('.nav.active'), r=button.getBoundingClientRect(), s=getComputedStyle(button), marker=getComputedStyle(button,'::before'), tooltip=getComputedStyle(button,'::after');
          return {focus:button===document.activeElement,focusVisible:button.matches(':focus-visible'),outline:s.outlineStyle,
            markerLeft:r.left+parseFloat(marker.left),markerRight:r.left+parseFloat(marker.left)+parseFloat(marker.width),
            outlineLeft:r.left-parseFloat(s.outlineWidth)-parseFloat(s.outlineOffset),outlineRight:r.right+parseFloat(s.outlineWidth)+parseFloat(s.outlineOffset),
            tooltip:tooltip.content,tooltipOpacity:parseFloat(tooltip.opacity),title:button.title};
        })()`);
        check(active.focus && active.focusVisible && active.outline !== 'none', `${name}: keyboard focus lost`);
        check(active.outlineLeft >= snapshot.rail.left-0.5 && active.outlineRight <= snapshot.rail.right+0.5, `${name}: focus outline clipped`);
        check(active.markerLeft >= snapshot.rail.left - 0.5 && active.markerRight <= snapshot.rail.right, `${name}: active indicator clipped`);
        if (snapshot.innerWidth <= 519) check(active.tooltip === JSON.stringify(active.title) && active.tooltipOpacity >= 0.99, `${name}: narrow tooltip lost`);
        const workspace = [];
        for (const panel of ['Official','Personal']) {
          await evaluate(`document.getElementById('serviceTab${panel}').click(); document.querySelector('.nav[data-page=browser]').focus()`);
          await frame();
          const view = await evaluate(`({hidden:document.getElementById('service${panel}View').hidden,
            bodyOverflow:document.documentElement.scrollWidth-innerWidth,
            contentOverflow:document.querySelector('.content').scrollWidth-document.querySelector('.content').clientWidth,
            panelOverflow:document.getElementById('service${panel}View').scrollWidth-document.getElementById('service${panel}View').clientWidth})`);
          check(!view.hidden && view.bodyOverflow<=0 && view.contentOverflow<=0 && view.panelOverflow<=0, `${name}: ${panel} workspace overflow`);
          workspace.push({panel,...view});
          if (output) fs.writeFileSync(path.join(output, `${language}-${width}-${zoom}-${panel}.png`), (await contents.capturePage()).toPNG());
        }
        rows.push({language,width,height,zoom,contentSize:window.getContentSize(),...snapshot,active,workspace});
        await evaluate("document.querySelector('.nav[data-page=settings]').click(); document.getElementById('openNotificationDrawer').focus(); document.getElementById('openNotificationDrawer').click()");
        await waitFor("!document.getElementById('notificationDrawer').hidden && Math.abs(document.getElementById('notificationDrawer').getBoundingClientRect().right-innerWidth)<0.5");
        const notification = await evaluate(`(() => {
          const drawer=document.getElementById('notificationDrawer'), backdrop=document.getElementById('notificationBackdrop'), r=drawer.getBoundingClientRect(), b=backdrop.getBoundingClientRect();
          return {left:r.left,right:r.right,backdropLeft:b.left,backdropRight:b.right,focusedClose:document.activeElement.id==='closeNotificationDrawer'};
        })()`);
        check(Math.abs(notification.backdropLeft-snapshot.rail.right)<0.5 && Math.abs(notification.backdropRight-snapshot.innerWidth)<0.5, `${name}: notification backdrop misaligned`);
        check(notification.left>=snapshot.rail.right-0.5 && Math.abs(notification.right-snapshot.innerWidth)<0.5, `${name}: notification drawer outside content`);
        if (snapshot.innerWidth<=609) check(Math.abs(notification.left-snapshot.rail.right)<0.5, `${name}: compact notification drawer misaligned`);
        check(notification.focusedClose, `${name}: notification close focus lost`);
        contents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); contents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
        await waitFor("document.getElementById('notificationDrawer').hidden && document.activeElement.id==='openNotificationDrawer'");
        rows[rows.length-1].notification=notification;

      }
    }
  } finally {
    contents.setZoomFactor(initialZoom); window.setContentSize(...initialSize);
    await evaluate(`(async () => { await window.api.save({language:'${initialLocale.startsWith('zh') ? 'zh' : 'en'}'}); document.dispatchEvent(new Event('visibilitychange')); })()`);
    await frame();
  }
  for (const language of ['en','zh']) {
    const widths = rows.filter(row=>row.language===language).map(row=>row.innerWidth);
    check(widths.some(width=>width<=519), `${language}: icon-only breakpoint not exercised`);
    check(widths.some(width=>width>519 && width<=609), `${language}: compact label breakpoint not exercised`);
    check(widths.some(width=>width>609), `${language}: standard label breakpoint not exercised`);
  }
  if (output) fs.writeFileSync(path.join(output,'measurements.json'), JSON.stringify({rows,failures},null,2));
  console.log(JSON.stringify({kind:'sidebar-label-layout',platform:process.platform,rows:rows.length,failures}));
  assert.deepEqual(failures, [], 'Sidebar label geometry');
};
