'use strict';
const { CdpPage } = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const page = await CdpPage.connect(Number(process.argv[2] || 9333));
  await page.init();
  // 重置首次提示并重载主界面
  await page.eval(`App.DB.settings.set('bubble_hint_shown', false).then(function(){return true})`);
  await page.navigate('https://app.local/index.html?hint=' + Date.now(), 2500);
  await sleep(3200);
  const info = await page.eval(`(function(){
    var h = document.querySelector('.bubble-hint');
    if (!h) return JSON.stringify({found:false});
    var r = h.getBoundingClientRect();
    var t = h.querySelector('.bubble-hint-text');
    var tr = t ? t.getBoundingClientRect() : null;
    var cs = getComputedStyle(h);
    return JSON.stringify({
      found:true, vw:window.innerWidth, vh:window.innerHeight, dpr:window.devicePixelRatio,
      hint:{x:r.left,y:r.top,w:r.width,h:r.height},
      text: tr ? {x:tr.left,y:tr.top,w:tr.width,h:tr.height, scrollW:t.scrollWidth, clientW:t.clientWidth} : null,
      styles:{maxWidth:cs.maxWidth,width:cs.width,padding:cs.padding,fontSize:cs.fontSize,whiteSpace:cs.whiteSpace,overflow:cs.overflow,transform:cs.transform,boxSizing:cs.boxSizing}
    });
  })()`);
  console.log(info);
  process.exit(0);
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(2); });
