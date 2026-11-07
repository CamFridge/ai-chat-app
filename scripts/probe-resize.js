/* 键盘/视口变化 + 图片异步加载 下的聊天页布局探针（v1.4.2）
 * 用法：node scripts/probe-resize.js [cdpPort] [appUrl]
 */
'use strict';
const path = require('path');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9222);
const APP = (process.argv[3] || 'http://127.0.0.1:8321').replace(/\/$/, '');
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `(() => {
  const pages = Array.from(document.querySelectorAll('.page')).filter((p) => getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().height > 0);
  const page = pages[pages.length - 1];
  const list = page && page.querySelector('.msg-list');
  const composer = page && page.querySelector('.composer');
  const topbar = page && page.querySelector('.chat-topbar');
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
  if (!list || !composer) return { err: 'no chat page', pages: pages.length };
  const listR = list.getBoundingClientRect();
  const vis = [];
  Array.from(list.querySelectorAll('.msg')).forEach((m) => {
    const r = m.getBoundingClientRect();
    // 只统计“真正可见”的部分（与列表可视区相交）
    const top = Math.max(r.top, listR.top), bottom = Math.min(r.bottom, listR.bottom);
    if (bottom - top > 2) vis.push({ id: m.dataset.id, top: Math.round(r.top), h: Math.round(r.height), visTop: Math.round(top), visBottom: Math.round(bottom) });
  });
  const overlaps = [];
  for (let i = 1; i < vis.length; i++) {
    if (vis[i].top < vis[i - 1].top + vis[i - 1].h - 1) overlaps.push({ prev: vis[i - 1].id, cur: vis[i].id, prevBottom: vis[i - 1].top + vis[i - 1].h, curTop: vis[i].top });
  }
  const cR = composer.getBoundingClientRect();
  const tR = topbar ? topbar.getBoundingClientRect() : null;
  const underComposer = vis.filter((v) => v.visBottom > cR.top + 1 && v.top < cR.top);
  const underTopbar = tR ? vis.filter((v) => v.top < tR.bottom && v.top + v.h > tR.top) : [];
  return {
    vh: window.innerHeight, vv: window.visualViewport ? Math.round(window.visualViewport.height) : null,
    list: R(list), composer: R(composer), topbar: R(topbar),
    pageH: R(page),
    scrollTop: Math.round(list.scrollTop), scrollH: list.scrollHeight, clientH: list.clientHeight,
    atBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 4,
    visible: vis.length,
    overlaps,
    underComposer: underComposer.map((v) => v.id),
    underTopbar: underTopbar.map((v) => v.id),
    lastVisible: vis.length ? vis[vis.length - 1].id : null
  };
})()`;

(async () => {
  const page = await CdpPage.connect(PORT);
  const collect = await page.init();
  const setSize = (w, h) => page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: h });

  await setSize(390, 844);
  await page.navigate('about:blank', 200);
  await page.navigate(APP + '/index.html?r=' + Date.now(), 1400);
  await sleep(700);
  await page.eval(`(async () => {
    for (let i = 0; i < 100 && !(window.App && App.DB && App.Router); i++) await new Promise(r => setTimeout(r, 50));
    await App.DB.ready;
    App.Router.tab('chatList');
    await new Promise(r => setTimeout(r, 300));
    App.Router.push('chat', { sessionId: 'sess_o' });
    await new Promise(r => setTimeout(r, 900));
    return 'ok';
  })()`);
  await sleep(500);

  const steps = [];
  async function step(name) {
    const m = await page.eval(MEASURE).catch((e) => ({ err: String(e) }));
    steps.push([name, m]);
    console.log(`\n### ${name}`);
    if (m.err) { console.log('  ✗ ' + m.err); return; }
    console.log(`  innerH=${m.vh} visualH=${m.vv} pageH=${JSON.stringify(m.pageH)} list=${JSON.stringify(m.list)} composer=${JSON.stringify(m.composer)}`);
    console.log(`  scroll ${m.scrollTop}/${m.scrollH - m.clientH}  atBottom=${m.atBottom} visible=${m.visible} last=${m.lastVisible}`);
    console.log('  ⚠ 相邻消息重叠: ' + (m.overlaps.length ? JSON.stringify(m.overlaps) : '无'));
    console.log('  ⚠ 消息被输入栏压住: ' + (m.underComposer.length ? JSON.stringify(m.underComposer) : '无'));
    console.log('  ⚠ 消息被顶栏压住: ' + (m.underTopbar.length ? JSON.stringify(m.underTopbar) : '无'));
  }

  await step('1 初始(844)');
  await setSize(390, 500);
  await sleep(600);
  await step('2 视口缩小到 500（模拟键盘弹出）');
  await setSize(390, 360);
  await sleep(600);
  await step('3 视口缩小到 360（键盘+候选栏）');
  await setSize(390, 844);
  await sleep(800);
  await step('4 视口恢复 844');

  // 输入多行文字让输入框长高
  await page.eval(`(() => { const t = document.querySelector('.composer-input'); if (!t) return 'no input'; t.value = Array.from({length: 8}, (_, i) => '第' + (i + 1) + '行内容').join('\\n'); t.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
  await sleep(500);
  await step('5 输入框长到最大高度(多行)');
  await page.eval(`(() => { const t = document.querySelector('.composer-input'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
  await sleep(300);

  // 在列表底部插入一张会异步加载的大图，观察图片加载后的滚动/重叠
  await page.eval(`(async () => {
    const l = document.querySelector('.chat-msg-list');
    l.scrollTop = l.scrollHeight;
    const wrap = document.createElement('div');
    wrap.className = 'msg me';
    wrap.setAttribute('data-id', 'async_img');
    wrap.innerHTML = '<div class="msg-avatar"></div><div class="msg-body"><div class="msg-bubble"><img class="msg-attach-img" style="display:block;width:200px" src="http://127.0.0.1:8321/../index.html"></div></div>';
    l.appendChild(wrap);
    await new Promise((r) => setTimeout(r, 1200));
    l.scrollTop = l.scrollHeight;
    return 'ok';
  })()`).catch((e) => console.log('async img err', e.message));
  await sleep(600);
  await step('6 异步大图插入后');

  await page.eval(`(async () => {
    const l = document.querySelector('.chat-msg-list');
    // 模拟流式：连续追加内容并每帧滚到底
    const m = l.querySelector('.msg:last-of-type .msg-bubble') || l.querySelector('.msg .msg-bubble');
    for (let i = 0; i < 40; i++) {
      if (m) m.textContent = '流式输出：' + '逐字追加的内容。'.repeat(i % 10 + 1);
      l.scrollTop = l.scrollHeight;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return 'ok';
  })()`).catch((e) => console.log('stream err', e.message));
  await sleep(500);
  await step('7 模拟流式追加后');

  console.log('\n汇总: ' + JSON.stringify(steps.map(([n, m]) => ({ step: n, overlap: (m.overlaps || []).length, underComposer: (m.underComposer || []).length, underTopbar: (m.underTopbar || []).length, atBottom: m.atBottom }))));
  process.exit(0);
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
