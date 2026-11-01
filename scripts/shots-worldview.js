#!/usr/bin/env node
/**
 * 世界观「AI 补全」生成态截图/交互验证（浏览器 + CDP）。
 * 用法: node scripts/shots-worldview.js [cdpPort] [appUrl]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9222);
const APP_URL = process.argv[3] || 'http://127.0.0.1:8321';
const SHOTS = path.join(__dirname, '..', 'build', 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const W = {
  name: '永夜海国',
  summary: '被永夜笼罩的海上城邦，靠捕捞发光的鱼维持照明。',
  details: {
    era: '蒸汽与前夜并存的年代',
    place: '灯塔区、渔市、沉船墓场',
    rules: '光来自发光鱼，离城三日灯会熄灭',
    society: '潮神祭司掌权，渔民行会与之抗衡',
    taboos: '夜里不许叫出溺亡者的名字',
    elements: ['发光鱼', '灯塔', '潮神祭'],
    characterHints: '沉默的灯塔看守人、狂热祭司、走私渔夫'
  },
  fieldOrigin: { name: 'user', summary: 'ai', details: 'ai', characterHints: 'ai' }
};

function jsFill(sel, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'no-el';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`;
}

function jsClick(sel, text) {
  return `(() => {
    const list = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
    const b = ${text ? `list.find(x => (x.innerText || x.textContent || '').indexOf(${JSON.stringify(text)}) >= 0)` : 'list[0]'};
    if (!b) return 'no-btn:' + list.map(x => (x.innerText || '').trim()).join('|');
    b.click();
    return 'ok';
  })()`;
}

async function waitFor(page, expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await page.eval(expr)) return true; } catch (e) { /* ignore */ }
    await sleep(120);
  }
  return false;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const page = await CdpPage.connect(PORT);
  await page.init();

  await page.navigate('about:blank', 300);
  await page.clearStorage(APP_URL);
  await page.navigate(APP_URL, 1200);
  await page.eval(`(async () => { await App.DB.clearAll(); localStorage.clear(); return true; })()`);
  await page.navigate(APP_URL + '/?fresh=' + Date.now(), 1600);

  // 种子：引导 API + 已完成引导
  await page.eval(`(async () => {
    const now = Date.now();
    await App.DB.put('providers', { id: 'prov_guide', name: '示例引导 API', baseUrl: 'https://api.example.com/v1', apiKey: '', defaultModel: 'gpt-4o-mini', role: 'guide', isDefault: false, createdAt: now, updatedAt: now });
    await App.API.setKey('prov_guide', 'sk-guide-123456');
    await App.DB.settings.set('onboarding_completed', true);
    await App.DB.settings.set('guide_provider_id', 'prov_guide');
    await App.DB.settings.set('last_tab', 'characters');
    return true;
  })()`);
  await page.navigate(APP_URL + '/?fresh=' + Date.now(), 1600);

  await page.eval(`(async () => { await App.Router.tab('characters'); return true; })()`);
  await sleep(500);
  const opened = await page.eval(`(async () => {
    try { await App.Router.push('worldviews', {}, {}); } catch (e) { return 'err:' + e.message; }
    return 'ok';
  })()`);
  console.log('[1] 打开世界观页:', opened);
  await waitFor(page, `(() => !!document.querySelector('.ck-wv-summary, .ck-empty-wrap'))()`);

  let r = await page.eval(jsClick('button', '新建世界观'));
  console.log('[2] 新建世界观:', r);
  await sleep(400);

  r = await page.eval(jsFill('#ck-wv-name', W.name));
  if (r !== 'ok') { console.log('名称输入失败', r); process.exit(1); }
  r = await page.eval(jsFill('textarea[data-guide-focus="rawInput"]', '永夜海国，一座被永夜笼罩的海上城邦；靠捕捞发光的鱼维持照明，城里有灯塔区、渔市和沉船墓场。'));
  if (r !== 'ok') { console.log('描述输入失败', r); process.exit(1); }
  await sleep(200);

  // mock 流式补全：慢速逐段吐 JSON
  await page.eval(`(() => {
    var OBJ = ${JSON.stringify(W)};
    var text = JSON.stringify(OBJ);
    window.__wvChunks = 0;
    App.API.chatStream = function (opts) {
      var i = 0, aborted = false, timer = null;
      function step() {
        if (aborted) return;
        var piece = text.slice(i, i + 16);
        i += 16;
        if (piece) { window.__wvChunks++; opts.onDelta(piece); }
        if (i >= text.length) { opts.onDone({ text: text }); return; }
        timer = setTimeout(step, 45);
      }
      timer = setTimeout(step, 120);
      return { abort: function () { aborted = true; if (timer) clearTimeout(timer); opts.onError({ code: 'cancel', message: '已取消' }); } };
    };
    return true;
  })()`);

  r = await page.eval(jsClick('.ck-action-row button', 'AI 补全'));
  console.log('[3] 开始 AI 补全:', r);
  const live = await waitFor(page, `(() => {
    var p = document.querySelector('.ck-gen-preview');
    var e = document.querySelector('.ck-gen-elapsed');
    return !!(p && (p.innerText || '').length > 20 && e && /\\d+\\.\\d+s/.test(e.innerText));
  })()`, 6000);
  console.log('   实时输出:', live);
  await page.screenshot(path.join(SHOTS, '70-wv-gen-live.png'));

  // 停止生成
  r = await page.eval(jsClick('.ck-action-row button', '停止生成'));
  console.log('[4] 停止生成:', r);
  const stopped = await waitFor(page, `(() => (document.body.innerText || '').indexOf('已停止生成') >= 0)()`, 5000);
  console.log('   已停止:', stopped);
  await sleep(300);
  await page.screenshot(path.join(SHOTS, '71-wv-gen-stopped.png'));

  // 继续生成 → 让它跑完
  r = await page.eval(jsClick('button', '继续生成'));
  console.log('[5] 继续生成:', r);
  const done = await waitFor(page, `(() => !!document.querySelector('.ck-preview-name'))()`, 12000);
  console.log('   补全完成进入预览:', done);
  await page.screenshot(path.join(SHOTS, '72-wv-gen-done.png'));

  // 校验解析字段
  const info = await page.eval(`(() => {
    var body = (document.querySelector('.ck-wizard-body') || {}).innerText || '';
    return { body: body.slice(0, 120), chunks: window.__wvChunks || 0 };
  })()`);
  console.log('   流式分片数:', info.chunks);

  // 黑暗模式看生成态
  await page.eval(`(async () => { await App.UI.setTheme('dark'); return true; })()`);
  await sleep(400);
  await page.screenshot(path.join(SHOTS, '73-wv-gen-dark.png'));

  await page.eval(`(async () => { await App.UI.setTheme('light'); return true; })()`);
  console.log('截图目录:', SHOTS);
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });

