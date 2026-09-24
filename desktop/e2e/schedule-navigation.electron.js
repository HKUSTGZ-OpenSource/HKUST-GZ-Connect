'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-week-fixture-'));
app.setPath('userData', path.join(root, 'profile'));
// An installed ASAR can be checked with synthetic data, without its user profile or school API.
const renderer = process.env.HKUSTGZ_SCHEDULE_RENDERER
  ? path.resolve(process.env.HKUSTGZ_SCHEDULE_RENDERER) : path.join(__dirname, '..', 'renderer');
const uri = name => pathToFileURL(path.join(renderer, name)).href;
if (process.env.HKUSTGZ_CALENDAR_CSS_BASELINE) {
  fs.copyFileSync(path.resolve(process.env.HKUSTGZ_CALENDAR_CSS_BASELINE), path.join(root, 'baseline.css'));
}
fs.writeFileSync(path.join(root, 'index.html'), `<!doctype html><html lang="zh-CN"><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; script-src 'self'">
<link rel="stylesheet" href="${uri('design-tokens.css')}"><link id="shared-css" rel="stylesheet" href="${uri('styles.css')}"><link id="calendar-css" rel="stylesheet" href="${uri('features/campus-data/view.css')}"><link rel="stylesheet" href="fixture.css">
</head><body><main><section class="module module-schedule" id="moduleSchedule"><div class="module-head"><h3>我的周课表</h3>
<div class="module-head-actions"><span class="module-source">myPortal</span><button id="scheduleRefresh" class="module-refresh">刷新</button></div></div><div id="scheduleBody"></div></section></main>
<div id="outside-schedule" class="week-summary">Sibling sentinel</div></body></html>`);
fs.writeFileSync(path.join(root, 'fixture.css'), 'body { display:block; overflow:auto; padding:20px; } main { min-width:0; } .module { padding:16px; }');

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ width: 960, height: 850, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, reply) => reply({ cancel: true }));
  try {
    await window.loadFile(path.join(root, 'index.html'));
    assert.equal(await window.webContents.executeJavaScript(`getComputedStyle(document.getElementById('outside-schedule')).display`),
      'block', 'calendar styling must not leak outside its feature root');
    const compareBaseline = async label => {
      if (!process.env.HKUSTGZ_CALENDAR_CSS_BASELINE) return;
      const snapshot = () => window.webContents.executeJavaScript(`(() => {
        // Compare identical animation phases rather than two wall-clock instants of the loading pulse.
        for (const animation of document.getElementById('moduleSchedule').getAnimations({subtree:true})) {
          animation.pause(); animation.currentTime = 0;
        }
        return [...document.querySelectorAll('#moduleSchedule, #moduleSchedule *')].map(el => {
          const style=getComputedStyle(el), rect=el.getBoundingClientRect();
          return { tag:el.tagName, class:el.className,
            bounds:[rect.x,rect.y,rect.width,rect.height],
            styles:Object.fromEntries([...style].map(key=>[key,style.getPropertyValue(key)])) };
        });
      })()`);
      const switchStyles = async baseline => {
        await window.webContents.executeJavaScript(`new Promise((resolve,reject) => {
          const shared=document.getElementById('shared-css');
          shared.onload=()=>requestAnimationFrame(()=>requestAnimationFrame(resolve));
          shared.onerror=()=>reject(new Error('baseline stylesheet failed to load'));
          document.getElementById('calendar-css').disabled=${baseline};
          shared.href=${JSON.stringify(baseline ? pathToFileURL(path.join(root, 'baseline.css')).href : uri('styles.css'))};
        })`);
      };
      const current = await snapshot();
      try {
        await switchStyles(true);
        assert.deepEqual(await snapshot(), current, `computed styles and geometry match before extraction: ${label}`);
      } finally {
        await switchStyles(false);
        await window.webContents.executeJavaScript(`
          document.getElementById('moduleSchedule').getAnimations({subtree:true}).forEach(animation=>animation.play())
        `);
      }
    };
    await window.webContents.executeJavaScript(`(async () => {
      const campusData = await import(${JSON.stringify(uri('features/campus-data/index.mjs'))});
      window.fixtureCalls = [];
      const snapshot = items => ({ sessionState: 'authenticated', modules: {
        schedule: { state: items.length ? 'ready' : 'empty', source: 'myportal-calendar', fetchedAt: Date.now(), items }
      }});
      const labels = { 'workspace.scheduleChooseWeek':'选择日期', 'workspace.schedulePrevious':'上一周',
        'workspace.scheduleNext':'下一周', 'workspace.scheduleToday':'本周', 'workspace.scheduleClose':'关闭',
        'workspace.scheduleTime':'时间', 'workspace.scheduleWeekTable':'周课表', 'workspace.scheduleRefresh':'刷新',
        'workspace.scheduleSource':'打开 myPortal →', 'workspace.scheduleDetails':'安排详情',
        'workspace.scheduleLoadingWeek':'正在同步所选周…', 'workspace.scheduleRefreshing':'刷新中…' };
      const feature = campusData.create({ document,
        api: { getCampusData: async () => {
          await new Promise(resolve => { window.fixtureInitialResolve = resolve; });
          return snapshot([]);
        }, refreshCampusSchedule: async () => snapshot([]),
          getCampusScheduleWeek: async query => {
            window.fixtureCalls.push(query);
            if(window.fixtureHold) await new Promise((resolve,reject)=>{window.fixtureResolve=resolve;window.fixtureReject=reject;});
            if(window.fixtureExpired) return {sessionState:'authenticated',modules:{schedule:{state:'session-expired',source:'myportal-calendar',fetchedAt:Date.now(),items:[]}}};
            const monday = campusData.weekRange(Date.parse(query.date+'T12:00:00+08:00'), true).start;
            return snapshot([
              { id:'a', title:'Synthetic Research Group Meeting', startsAt:monday+15*3600000, endsAt:monday+16.5*3600000, location:'Room A' },
              { id:'b', title:'Project-driven Collaborative Design — Full Long Course Name', startsAt:monday+16.5*3600000, endsAt:monday+(18+20/60)*3600000, location:'Room B' },
              { id:'c', title:'Concurrent Seminar', startsAt:monday+16.75*3600000, endsAt:monday+17.5*3600000, location:'Room C' },
              { id:'d', title:'Short appointment', startsAt:monday+18.5*3600000, endsAt:monday+19*3600000, location:'Room D' },
              { id:'e', title:'Third concurrent course', startsAt:monday+16.5*3600000, endsAt:monday+(18+20/60)*3600000, location:'Room E' },
            ]);
          } },
        translate: (key, values) => key === 'workspace.scheduleWeekRange' ? values.start+'–'+values.end
          : key === 'workspace.scheduleGroupedCompact' ? values.count+'项'
            : key === 'workspace.scheduleWeekCount' || key === 'workspace.scheduleGrouped' ? values.count+' 项安排' : (labels[key] || key),
        escapeHtml: text => String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
        openDeepLink: () => {},
      });
      feature.start(); const initialLoad = feature.load();
      window.fixtureInitialLoad = initialLoad;
    })()`);
    const initial = await window.webContents.executeJavaScript(`({
      days:document.querySelectorAll('.week-day-head').length,
      busy:document.querySelector('.week-table')?.getAttribute('aria-busy'),
      oldLoading:!!document.querySelector('.module-state.is-loading'),
      events:document.querySelectorAll('.week-event').length
    })`);
    assert.deepEqual(initial,{days:7,busy:'true',oldLoading:false,events:0},
      'first load must retain a seven-day grid, not the old loading placeholder');
    await window.webContents.executeJavaScript(`(async () => {
      window.fixtureInitialResolve(); await window.fixtureInitialLoad;
      const input=document.getElementById('scheduleDate'); input.value='2027-01-13';
      input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    const settle = async () => {
      for (let i=0;i<100;i++) {
        if (await window.webContents.executeJavaScript(`['ready','empty'].includes(document.getElementById('moduleSchedule').dataset.state) && !document.getElementById('scheduleRefresh').disabled`)) return;
        await new Promise(r=>setTimeout(r,20));
      }
      throw new Error('calendar did not become ready');
    };
    await settle();
    assert.equal(await window.webContents.executeJavaScript('fixtureCalls.at(-1).date'), '2027-01-13');
    for (const [width, zoom] of [[360,1], [440,1], [960,1], [1440,1], [960,1.5]]) {
      window.setSize(width,850); window.webContents.setZoomFactor(zoom);
      let stable = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const contentWidth = window.getContentSize()[0];
        const correct = window.getSize()[0] === width && await window.webContents.executeJavaScript(`(() => {
          const body=document.getElementById('scheduleBody');
          return Math.abs(innerWidth * ${zoom} - ${contentWidth}) < 2 &&
            document.querySelector('.week-table').classList.contains('is-mini') === (body.clientWidth < 620);
        })()`);
        if (correct) { stable = true; break; }
        await new Promise(r=>setTimeout(r,20));
      }
      assert.ok(stable, 'responsive layout settles before geometry comparison');
      await new Promise(r=>setTimeout(r,80));
      const result = await window.webContents.executeJavaScript(`(() => {
        const rect = el => { const r=el.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}; };
        return { overflow:document.documentElement.scrollWidth-innerWidth,
          miniature:document.querySelector('.week-table').classList.contains('is-mini'),
          bodyHeight:Number(document.querySelector('.week-body').dataset.height),
          horizontalOverflow:document.querySelector('.week-scroll').scrollWidth-document.querySelector('.week-scroll').clientWidth,
          weekBounds:rect(document.querySelector('.week-scroll')),
          dayHeads:[...document.querySelectorAll('.week-day-head')].map(rect),
          verticalOverflow:document.querySelector('.week-scroll').scrollHeight-document.querySelector('.week-scroll').clientHeight,
          cards:[...document.querySelectorAll('.week-event')].map(el=>({rect:rect(el), title:rect(el.querySelector('strong')),
            inline:getComputedStyle(el).flexDirection==='row', count:Number(el.dataset.count),
            time:getComputedStyle(el.querySelector('time')).display==='none'?null:rect(el.querySelector('time')),
            location:el.querySelector('small') && getComputedStyle(el.querySelector('small')).display!=='none'?rect(el.querySelector('small')):null,
            offset:parseFloat(el.style.top), height:parseFloat(el.style.height)})) };
      })()`);
      assert.ok(result.overflow<=1, `no page overflow at ${width}/${zoom}`);
      assert.ok(result.bodyHeight <= (result.miniature ? 180 : 300), 'small windows use a smaller timetable');
      assert.ok(result.horizontalOverflow<=1, 'no horizontal scroll, rather than just a hidden scrollbar');
      assert.equal(result.dayHeads.length,7);
      assert.ok(result.dayHeads.every(day=>day.left>=result.weekBounds.left && day.right<=result.weekBounds.right+1), 'all seven days fit inside the card');
      assert.ok(result.dayHeads.every(day=>day.right-day.left>(result.weekBounds.right-result.weekBounds.left)/9), 'no weekday is collapsed into the hidden time-axis column');
      assert.ok(result.cards.every(card=>card.rect.left>=result.dayHeads[0].left && card.rect.right<=result.dayHeads[0].right), 'Monday events remain below Monday, not Tuesday');
      assert.ok(result.verticalOverflow<=1, 'week must not have a nested vertical scrollbar');
      assert.ok(Math.abs(result.cards[0].offset-(60*result.bodyHeight/360+2))<.01, '15:00 retains its relative time position');
      assert.ok(Math.abs(result.cards[1].offset-(150*result.bodyHeight/360+2))<.01);
      assert.deepEqual(result.cards.map(card=>card.count),[1,3,1]);
      for (let i=0;i<result.cards.length;i++) {
        const card=result.cards[i];
        assert.ok(card.title.bottom<=card.rect.bottom+1, 'title is not cut off by card bottom');
        if(card.time) assert.ok(card.inline ? card.time.right<=card.title.left+1 : card.time.bottom<=card.title.top+1, 'time and title do not overlap');
        if(card.location) assert.ok(card.title.bottom<=card.location.top+1 && card.location.bottom<=card.rect.bottom+1);
        for(let j=i+1;j<result.cards.length;j++) {
          const a=card.rect,b=result.cards[j].rect;
          assert.ok(a.bottom<=b.top || b.bottom<=a.top || a.right<=b.left || b.right<=a.left, 'event cards never cover each other');
        }
      }
      if (process.env.HKUSTGZ_SCHEDULE_SCREENSHOTS) {
        const output=path.resolve(process.env.HKUSTGZ_SCHEDULE_SCREENSHOTS); fs.mkdirSync(output,{recursive:true});
        await new Promise(r=>setTimeout(r,80));
        fs.writeFileSync(path.join(output,`schedule-${width}-${zoom}.png`),(await window.webContents.capturePage()).toPNG());
      }
      await compareBaseline(`week ${width}/${zoom}`);
    }
    assert.equal(await window.webContents.executeJavaScript('fixtureCalls.length'),1,'resizing only changes presentation, not remote queries');
    await window.webContents.executeJavaScript(`document.querySelector('[data-week-move="1"]').click()`); await settle();
    assert.equal(await window.webContents.executeJavaScript('fixtureCalls.at(-1).date'),'2027-01-20');
    await window.webContents.executeJavaScript(`document.querySelector('[data-week-move="-1"]').click()`); await settle();
    assert.equal(await window.webContents.executeJavaScript('fixtureCalls.length'),2,'cached week needs no new request');
    assert.equal(await window.webContents.executeJavaScript(`document.getElementById('scheduleDate').value`),'2027-01-13');
    await window.webContents.executeJavaScript(`window.fixtureHold=true;window.fixtureTable=document.querySelector('.week-table');document.getElementById('scheduleRefresh').click()`);
    await new Promise(r=>setTimeout(r,80));
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.week-table')===window.fixtureTable`),true,'refresh leaves the existing timetable in place');
    await compareBaseline('refreshing cached week');
    await window.webContents.executeJavaScript(`window.fixtureHold=false;window.fixtureReject(new Error('synthetic offline'))`);await settle();
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.week-event').length`),3);
    assert.ok(await window.webContents.executeJavaScript(`!!document.querySelector('.week-refresh-notice')`));
    await compareBaseline('failed refresh notice');
    await window.webContents.executeJavaScript(`document.getElementById('scheduleRefresh').click()`);await settle();
    assert.equal(await window.webContents.executeJavaScript('fixtureCalls.at(-1).force'),true);
    await window.webContents.executeJavaScript(`document.querySelectorAll('.week-event')[1].click()`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('dialog').open`),true);
    assert.match(await window.webContents.executeJavaScript(`document.querySelector('dialog').textContent`),/Full Long Course Name/);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.week-detail-item').length`),3);
    assert.match(await window.webContents.executeJavaScript(`document.querySelector('dialog').textContent`),/Third concurrent course/);
    const detailBounds = await window.webContents.executeJavaScript(`(()=>{
      const r=document.querySelector('dialog').getBoundingClientRect();
      return {cx:r.x+r.width/2,cy:r.y+r.height/2,vw:innerWidth,vh:innerHeight,left:r.left,top:r.top,right:r.right,bottom:r.bottom};
    })()`);
    assert.ok(Math.abs(detailBounds.cx-detailBounds.vw/2)<2,'detail dialog must be horizontally centered');
    assert.ok(Math.abs(detailBounds.cy-detailBounds.vh/2)<2,'detail dialog must be vertically centered');
    assert.ok(detailBounds.left>=16 && detailBounds.right<=detailBounds.vw-16 && detailBounds.top>=16 && detailBounds.bottom<=detailBounds.vh-16,'detail dialog retains viewport margins');
    for (const width of [360, 440, 960, 1440]) {
      await window.webContents.executeJavaScript(`document.querySelector('dialog').close()`);
      window.webContents.setZoomFactor(1); window.setSize(width,740);
      await new Promise(r=>setTimeout(r,120));
      await window.webContents.executeJavaScript(`document.querySelectorAll('.week-event')[1].click()`);
      const centered = await window.webContents.executeJavaScript(`(()=>{
        const dialog=document.querySelector('dialog');
        if(innerWidth===440) for(const title of dialog.querySelectorAll('h4')) title.textContent=title.textContent.repeat(8);
        const r=dialog.getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,h:innerHeight,left:r.left,right:r.right,top:r.top,bottom:r.bottom};
      })()`);
      assert.ok(Math.abs(centered.x-centered.w/2)<2 && Math.abs(centered.y-centered.h/2)<2, `detail centered at width ${width}`);
      assert.ok(centered.left>=16 && centered.right<=centered.w-16 && centered.top>=16 && centered.bottom<=centered.h-16,'long details stay inside viewport');
      await compareBaseline(`dialog ${width}`);
    }
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await new Promise(r=>setTimeout(r,80));
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('dialog').open`),false);
    await window.webContents.executeJavaScript(`document.querySelector('[data-week-today]').click()`); await settle();
    assert.equal(await window.webContents.executeJavaScript(`document.getElementById('scheduleDate').value`), new Date(Date.now()+28800000).toISOString().slice(0,10));
    await window.webContents.executeJavaScript(`window.fixtureHold=true;document.querySelector('[data-week-move="1"]').click()`);
    await new Promise(r=>setTimeout(r,80));
    const loading=await window.webContents.executeJavaScript(`({height:document.getElementById('moduleSchedule').getBoundingClientRect().height,events:document.querySelectorAll('.week-event').length,
      days:document.querySelectorAll('.week-day-head').length,busy:document.querySelector('.week-table')?.getAttribute('aria-busy'),
      oldLoading:!!document.querySelector('.module-state.is-loading'),empty:!!document.querySelector('.week-empty'),
      overflow:document.querySelector('.week-scroll').scrollWidth-document.querySelector('.week-scroll').clientWidth})`);
    if(process.env.HKUSTGZ_SCHEDULE_SCREENSHOTS) fs.writeFileSync(path.join(path.resolve(process.env.HKUSTGZ_SCHEDULE_SCREENSHOTS),'schedule-pending.png'),(await window.webContents.capturePage()).toPNG());
    assert.ok(loading.height<500,`pending calendar stays compact: ${JSON.stringify(loading)}`);assert.equal(loading.events,0);
    assert.equal(loading.days,7);assert.equal(loading.busy,'true');assert.equal(loading.oldLoading,false);
    assert.equal(loading.empty,false,'pending is not an empty result');assert.ok(loading.overflow<=1);
    if(process.env.HKUSTGZ_SCHEDULE_SCREENSHOTS) fs.writeFileSync(path.join(path.resolve(process.env.HKUSTGZ_SCHEDULE_SCREENSHOTS),'schedule-pending.png'),(await window.webContents.capturePage()).toPNG());
    await compareBaseline('uncached week loading');
    await window.webContents.executeJavaScript(`window.fixtureHold=false;window.fixtureResolve()`);await settle();
    if (process.env.HKUSTGZ_CALENDAR_CSS_BASELINE) process.stdout.write('calendar CSS baseline: PASS (all computed styles and geometry, 5 week layouts, 4 dialogs, 3 refresh/loading states)\n');
    await window.webContents.executeJavaScript(`window.fixtureExpired=true;document.getElementById('scheduleRefresh').click()`);
    for(let i=0;i<100;i++) {
      if(await window.webContents.executeJavaScript(`document.getElementById('moduleSchedule').dataset.state==='session-expired' && !document.getElementById('scheduleRefresh').disabled`)) break;
      await new Promise(r=>setTimeout(r,20));
    }
    assert.equal(await window.webContents.executeJavaScript(`document.getElementById('moduleSchedule').dataset.state`),'session-expired');
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.week-event').length`),0,'explicit expiry removes prior events');
    await window.webContents.executeJavaScript(`window.fixtureExpired=false;document.getElementById('scheduleRefresh').click()`);await settle();
    process.stdout.write('schedule navigation: PASS (date, adjacent weeks, today, refresh, detail, keyboard, minute geometry, overlap, narrow/wide/zoom, expiry recovery)\n');
  } finally { window.destroy(); }
}
run().then(()=>app.quit(),error=>{ process.stderr.write(`${error.stack}\n`); app.exit(1); });
