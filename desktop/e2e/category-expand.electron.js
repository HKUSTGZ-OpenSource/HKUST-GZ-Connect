'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'hkustgz-category-fixture-')));

async function resizeCategories(window, width) {
  window.setSize(width, 740);
  const deadline = Date.now() + 2000;
  let observed;
  while (Date.now() < deadline) {
    observed = await window.webContents.executeJavaScript(`(()=>{
      const host=document.querySelector('#campusResources .cb-board-host');
      return {width:innerWidth,columns:Number(host?.style.getPropertyValue('--cb-columns'))};
    })()`);
    if (observed.width === width && observed.columns === (width >= 980 ? 2 : 1)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`category resize did not settle: ${JSON.stringify({requestedWidth:width,...observed})}`);
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 740, show: true, webPreferences: {
    preload: path.join(__dirname,'resource-manager-layout-preload.js'), contextIsolation:true, nodeIntegration:false, backgroundThrottling:false,
  } });
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
  try {
    await window.loadFile(path.join(__dirname,'..','renderer','index.html'));
    for(let i=0;i<100;i++) {
      if(await window.webContents.executeJavaScript(`!document.getElementById('dash').hidden`))break;
      await new Promise(r=>setTimeout(r,30));
    }
    await window.webContents.executeJavaScript(`(async()=>{
      document.querySelector('.nav[data-page="browser"]').click(); document.getElementById('serviceTabPersonal').click();
      await new Promise(r=>setTimeout(r,100));
      window.campusCategoryStacks.render({
        resources:[1,2,3].map(id=>({id:'fixture-'+id,name:'Example Resource '+id,url:'https://example.invalid/'+id,favorite:true})),
        groups:[{id:'fixture-one',name:'学习资料',resourceIds:['fixture-1','fixture-2']},{id:'fixture-two',name:'常用网站',resourceIds:['fixture-3']}],
        translate:key=>({'workspace.more':'查看更多','resources.favorite':'收藏','resources.unfavorite':'取消收藏'}[key]||key),
        escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
      });
    })()`);
    await new Promise(r=>setTimeout(r,120));
    for(const width of [440,1000,1440,440,1000]) {
      await resizeCategories(window, width);
      const layout=await window.webContents.executeJavaScript(`(()=>{
        const host=document.querySelector('#campusResources .cb-board-host');
        return {front:host.querySelectorAll('.cb-card.is-front').length,back:host.querySelectorAll('.cb-card.is-back').length,
          columns:host.style.getPropertyValue('--cb-columns')};
      })()`);
      assert.equal(layout.front,width>=980?2:1,'wide personal categories spread into two cards');
      assert.equal(layout.back,width>=980?0:1,'narrow categories return to one shared deck');
      assert.equal(Number(layout.columns),width>=980?2:1);
      const expanded = await window.webContents.executeJavaScript(`(()=>{
        const card=document.querySelector('#campusResources .cb-card.is-front');
        const count=Number(card.querySelector('.cb-card-count').textContent);
        const expand=card.querySelector('[data-card-action="expand"]');
        if(!expand)throw new Error('small category has no expand control');
        expand.focus();expand.click();
        const dialog = document.querySelector('.cb-service-overlay');
        // Exercise delayed compositor start without changing the production motion.
        for (const animation of dialog.getAnimations()) animation.effect.updateTiming({ delay: 300, fill: 'backwards' });
        const focus = document.activeElement;
        window.campusCategoryStacks.activeController().render();
        return { count, connected: dialog.isConnected, open: dialog.open,
          focusRetained: document.activeElement === focus };
      })()`);
      const expected = expanded.count;
      assert.equal(expanded.connected, true, 'layout redraw detached the category dialog');
      assert.equal(expanded.open, true, 'layout redraw closed the category dialog');
      assert.equal(expanded.focusRetained, true, 'layout redraw moved focus out of the dialog');
      await window.webContents.executeJavaScript(`(async()=>{
        const dialog=document.querySelector('.cb-service-overlay');
        let timer;
        try {
          await Promise.race([
            Promise.all(dialog.getAnimations().map(animation=>animation.finished)),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('category animation did not finish')),1500);}),
          ]);
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        } finally { clearTimeout(timer); }
      })()`);
      const result=await window.webContents.executeJavaScript(`(()=>{
        const dialog=document.querySelector('.cb-service-overlay');
        return {open:dialog?.open,count:dialog?.querySelectorAll('.cb-site').length,width:dialog?.getBoundingClientRect().width,
          cx:dialog?.getBoundingClientRect().x+dialog?.getBoundingClientRect().width/2,
          cy:dialog?.getBoundingClientRect().y+dialog?.getBoundingClientRect().height/2,vw:innerWidth,vh:innerHeight,
          overflow:document.documentElement.scrollWidth-innerWidth};
      })()`);
      assert.equal(result.open,true);assert.equal(result.count,expected);assert.ok(expected<=2);
      assert.ok(result.width<=width);assert.ok(result.overflow<=1);
      assert.ok(Math.abs(result.cx-result.vw/2)<2 && Math.abs(result.cy-result.vh/2)<2,
        `category detail is centered: ${JSON.stringify({ requestedWidth: width, ...result })}`);
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      await new Promise(r=>setTimeout(r,80));
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.cb-service-overlay').open`),false);
    }
    await window.webContents.executeJavaScript(`(()=>{
      document.querySelector('#campusResources .cb-card.is-front [data-card-action="expand"]').click();
      window.resizeDetail = document.querySelector('.cb-service-overlay');
      window.resizeDetailFocus = document.activeElement;
    })()`);
    await resizeCategories(window, 440);
    assert.deepEqual(await window.webContents.executeJavaScript(`(()=>{
      const dialog=window.resizeDetail;
      const result={connected:dialog.isConnected,open:dialog.open,
        focus:document.activeElement===window.resizeDetailFocus};
      dialog.querySelector('.cb-overlay-close').click();
      return result;
    })()`),{connected:true,open:true,focus:true},'cross-breakpoint resize preserves the open modal and focus');
    const drawn = await window.webContents.executeJavaScript(`new Promise(resolve=>{
      const host=document.querySelector('#campusResources .cb-board-host');
      host.addEventListener('card-board-drawn',event=>resolve(event.detail),{once:true});
      host.querySelector('.cb-card.is-back [data-card-action="draw"]').click();
    })`);
    assert.ok(drawn.duration>=200 && drawn.duration<1000);
    const pageMotion=await window.webContents.executeJavaScript(`(()=>{
      const pager=document.getElementById('personalCategoryPager');
      pager.querySelector('button:not([aria-current])').click();
      return document.querySelector('#campusResources .cb-card.is-front').getAnimations().map(a=>a.effect.getTiming());
    })()`);
    assert.ok(pageMotion.some(t=>t.duration===240 && t.easing==='cubic-bezier(0.2, 0.8, 0.2, 1)'));
    await new Promise(r=>setTimeout(r,260));
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    const reduced=await window.webContents.executeJavaScript(`new Promise(resolve=>{
      const host=document.querySelector('#campusResources .cb-board-host');
      host.addEventListener('card-board-drawn',event=>resolve(event.detail),{once:true});
      host.querySelector('.cb-card.is-back [data-card-action="draw"]').click();
    })`);
    assert.ok(reduced.duration<100);
    await window.webContents.executeJavaScript(`(()=>{
      const groups=Array.from({length:6},(_,i)=>({id:'many-'+i,name:'Collection '+i,resourceIds:[]}));
      window.campusCategoryStacks.render({resources:[],groups,translate:key=>key,escapeHtml:String});
      const controller=window.campusCategoryStacks.activeController();
      controller.setDocument({schemaVersion:1,revision:0,placements:[],decks:[]});
      window.savedCategoryLayout=JSON.stringify(controller.snapshot());
    })()`);
    await resizeCategories(window, 1200);
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    assert.equal(await window.webContents.executeJavaScript(`window.campusCategoryStacks.focusCard('user-collection','many-5')`),true);
    assert.equal(await window.webContents.executeJavaScript(`
      document.querySelector('#campusResources .cb-card.is-front[data-card-ref-id="many-5"]') !== null
    `), true, 'focus must reveal the requested later-page category, not just report success');
    const widePager=await window.webContents.executeJavaScript(`(()=>{
      const pager=document.getElementById('personalCategoryPager');
      const count=pager.querySelectorAll('button').length;
      pager.querySelector('[data-card-page-index="0"]').click();
      return {count,focus:document.activeElement?.dataset.cardPageIndex,
        animations:document.querySelector('#campusResources .cb-card.is-front').getAnimations().map(a=>a.effect.getTiming().duration)};
    })()`);
    assert.equal(widePager.count,3,'six wide cards form three two-card pages');
    assert.equal(widePager.focus,'0','paging retains keyboard focus');
    assert.ok(widePager.animations.includes(240),'wide pagination uses service-style motion too');
    await window.webContents.executeJavaScript(`window.campusCategoryStacks.focusCard('user-collection','many-5')`);
    for(const width of [1200,440,1200]) {
      await resizeCategories(window, width);
      const selection=await window.webContents.executeJavaScript(`(()=>{
        const host=document.querySelector('#campusResources .cb-board-host');
        return {ids:[...host.querySelectorAll('.cb-card.is-front')].map(card=>card.dataset.cardRefId),
          stable:window.savedCategoryLayout===JSON.stringify(window.campusCategoryStacks.activeController().snapshot())};
      })()`);
      assert.ok(selection.ids.includes('many-5'),'selected category stays visible across paging and resize');
      assert.equal(selection.stable,true,'responsive projection must not mutate persisted layout');
    }
    await window.webContents.executeJavaScript(`(()=>{
      const controller=window.campusCategoryStacks.activeController();
      const before=controller.snapshot();
      const ids=['many-0','many-1'].map(id=>before.placements.find(p=>p.card.id===id).placementId);
      const manual=window.cardBoardModel.applyDraftOperation(before,{type:'create-deck',boardId:'browser-personal',placementIds:ids,index:0});
      window.manualDeckId=manual.decks.find(deck=>deck.deckId.startsWith('deck_')).deckId;
      controller.setDocument(manual);controller.focusCard('user-collection','many-1');
      window.savedCategoryLayout=JSON.stringify(controller.snapshot());
    })()`);
    for(const width of [1200,440,1200]) {
      await resizeCategories(window, width);
      const manual=await window.webContents.executeJavaScript(`(()=>{
        const slot=[...document.querySelectorAll('#campusResources .cb-deck')].find(el=>el.dataset.cardDeckId===window.manualDeckId);
        return {count:slot?.querySelectorAll('.cb-card').length,
          stable:window.savedCategoryLayout===JSON.stringify(window.campusCategoryStacks.activeController().snapshot())};
      })()`);
      assert.equal(manual.count,2,'a user-created deck is never automatically unstacked');
      assert.equal(manual.stable,true);
    }
    assert.deepEqual(await window.webContents.executeJavaScript(`(()=>{
      const controller=window.campusCategoryStacks.activeController();
      controller.setData({categories:[{kind:'user-collection',id:'many-1',name:'Detail retirement',
        items:[{id:'retirement-site',name:'Synthetic site',url:'https://example.invalid/retire',favorite:true}]}]});
      controller.focusCard('user-collection','many-1');
      document.querySelector('#campusResources .cb-card.is-front [data-card-action="expand"]').click();
      const dialog=document.querySelector('.cb-service-overlay');
      const wasOpen=dialog.open;
      controller.setDocument(controller.snapshot());
      const layoutRetired=!dialog.isConnected && !dialog.open;
      document.querySelector('#campusResources .cb-card.is-front [data-card-action="expand"]').click();
      const replacement=document.querySelector('.cb-service-overlay');
      controller.setData({categories:[]});
      return { wasOpen, layoutRetired, retired: !replacement.isConnected && !replacement.open,
        focused: controller.focusCard('user-collection','many-1') };
    })()`),{wasOpen:true,layoutRetired:true,retired:true,focused:false},'context changes retire detail actions and cannot report focus success');
    process.stdout.write('personal category: PASS (small-list expansion, all rows, Escape, narrow/wide, deck and pager shared motion, reduced motion)\n');
  } finally { if(window.webContents.debugger.isAttached())window.webContents.debugger.detach();window.destroy(); }
}
main().then(()=>app.quit(),error=>{process.stderr.write(`${error.stack}\n`);app.exit(1);});
