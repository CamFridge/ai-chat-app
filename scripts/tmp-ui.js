'use strict';
const { CdpPage } = require('./cdp');
const APP = 'http://127.0.0.1:8321';
(async () => {
  const page = await CdpPage.connect(9222);
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });
  const st = await page.eval(`(async () => {
    while (App.UI.closeTopOverlay()) { await new Promise(r => setTimeout(r, 200)); }
    await App.Router.push('characterEdit', { id: 'char_1' });
    await new Promise(r => setTimeout(r, 1400));
    const row = document.querySelector('[data-guide-focus="characterImages"]');
    if (!row) {
      const pages = Array.from(document.querySelectorAll('.page')).map(p => ({ cls: p.className, display: p.style.display, text: (p.innerText || '').slice(0, 120) }));
      const chars = await App.DB.all('characters');
      const html = (document.querySelector('.page:last-of-type') || {}).innerHTML || '';
      return { err: 'no row', page: (App.Router.current() || {}).name, depth: App.Router.depth ? App.Router.depth() : -1, pages: pages, chars: chars.map(c => c.id), hasImgHtml: html.indexOf('角色图片库') >= 0 };
    }
    row.click();
    await new Promise(r => setTimeout(r, 500));
    const wrap = document.querySelector('.modal-wrap');
    const box = document.querySelector('.modal');
    const root = document.getElementById('overlay-root');
    function info(el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { cls: el.className, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, display: cs.display, position: cs.position, z: cs.zIndex, vis: cs.visibility, op: cs.opacity, count: document.querySelectorAll('.modal').length };
    }
    return { wrap: info(wrap), box: info(box), root: info(root), modalCount: document.querySelectorAll('.modal').length, wrapParent: wrap && wrap.parentNode && wrap.parentNode.id, overlays: App.UI.hasOverlay() };
  })()`);
  console.log(JSON.stringify(st, null, 2));
  await page.screenshot(require('path').join(__dirname, '..', 'build', 'shots', 'tmp-modal.png'));
  process.exit(0);
})().catch(e => { console.error(e.stack || e); process.exit(2); });
