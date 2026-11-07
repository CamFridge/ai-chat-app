/* v1.3.5 布局适配 E2E：按钮等宽/不溢出 + 长图缩略卡与滚动预览
 * 用法：node scripts/e2e-layout.js 9222 http://127.0.0.1:8321
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { CdpPage } = require('./cdp.js');

const port = Number(process.argv[2] || 9222);
const APP = (process.argv[3] || 'http://127.0.0.1:8321').replace(/\/$/, '');
const ORIGIN = new URL(APP).origin;
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
const problems = [];
let pass = 0, fail = 0;

function ok(msg, d) { pass++; console.log('  ✓ ' + msg + (d !== undefined ? '  → ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); }
function bad(msg, d) { fail++; problems.push(msg + (d !== undefined ? ' :: ' + JSON.stringify(d) : '')); console.log('  ✗ ' + msg + (d !== undefined ? '  → ' + JSON.stringify(d) : '')); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(page, expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await page.eval(expr)) return true; } catch (e) {}
    await sleep(150);
  }
  return false;
}

const TALL_PNG = `(() => {
  var c = document.createElement('canvas');
  c.width = 480; c.height = 2400;
  var g = c.getContext('2d');
  var grd = g.createLinearGradient(0, 0, 0, 2400);
  grd.addColorStop(0, '#2b3a67'); grd.addColorStop(0.5, '#d98e73'); grd.addColorStop(1, '#1f6f78');
  g.fillStyle = grd; g.fillRect(0, 0, 480, 2400);
  g.fillStyle = 'rgba(255,255,255,.85)';
  for (var i = 0; i < 24; i++) g.fillRect(24, 40 + i * 94, 300 + (i % 5) * 24, 14);
  return c.toDataURL('image/jpeg', 0.9);
})()`;

const SEED = `(async () => {
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  await App.DB.clearAll(); localStorage.clear();
  await wait(120);
  var now = Date.now();
  await App.DB.put('providers', { id: 'prov_chat', name: '聊天 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', role: 'chat', isDefault: true, createdAt: now });
  await App.DB.put('providers', { id: 'prov_guide', name: '引导 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o-mini', role: 'guide', isDefault: false, createdAt: now });
  await App.DB.put('characters', { id: 'char_tall', name: '林夏', type: 'companion', gender: 'female', personality: '温柔', habits: '', background: '', firstMessage: '你回来啦。', alternateGreetings: [], scenarios: [], scenario: '', godMode: false, fieldOrigin: {}, createdAt: now, updatedAt: now });
  await App.DB.put('sessions', { id: 'sess_tall', characterId: 'char_tall', title: '林夏', providerId: 'prov_chat', model: 'gpt-4o', greetingIndex: 0, scene: '', unread: 0, lastText: '你回来啦。', lastRole: 'assistant', lastAt: now, createdAt: now, updatedAt: now });
  var tall = ${TALL_PNG};
  await App.DB.put('messages', { id: 'm_tall', sessionId: 'sess_tall', role: 'user', content: '给你看个长图', status: 'ok', attachments: [{ kind: 'image', name: 'long-chat.jpg', mime: 'image/jpeg', dataUri: tall }], createdAt: now, updatedAt: now, variants: [], variantIndex: 0 });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('last_tab', 'chatList');
  return { ok: true, tallLen: tall.length };
})()`;

(async () => {
  const page = await CdpPage.connect(port);
  await page.init();
  await page.navigate('about:blank', 200);
  try { await page.clearStorage(ORIGIN); } catch (e) {}
  await page.navigate(APP + '/index.html?fresh=' + Date.now(), 2600);
  const seeded = await page.eval(SEED);
  if (seeded && seeded.ok) ok('种子数据写入', '长图 ' + seeded.tallLen + ' 字节');
  else bad('种子写入失败', seeded);
  await page.navigate(APP + '/index.html?seed=' + Date.now(), 3200);
  await sleep(700);

  // ---------- A. 320px 宽：按钮等宽、页面不横向溢出 ----------
  for (const w of [320, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: w === 320 ? 700 : 800, deviceScaleFactor: 2, mobile: true });
    await sleep(300);

    const overflow = await page.eval(`(() => {
      var de = document.documentElement;
      return { sw: de.scrollWidth, iw: window.innerWidth };
    })()`);
    if (overflow && overflow.sw <= overflow.iw + 1) ok(w + 'px 页面无横向溢出');
    else bad(w + 'px 页面横向溢出', overflow);

    // 新建角色 Step1 底部按钮
    await page.eval(`App.Router.push('characterCreate', {}, {})`);
    await sleep(600);
    const w1 = await page.eval(`(() => {
      var btns = Array.from(document.querySelectorAll('.ck-wizard-foot .btn'));
      return btns.map(function (b) { return { t: (b.textContent || '').trim(), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }; });
    })()`);
    if (Array.isArray(w1) && w1.length && w1.every(x => Math.abs(x.w - w1[0].w) <= 2)) ok(w + 'px 创建页底部按钮等宽', w1);
    else bad(w + 'px 创建页底部按钮不等宽', w1);

    // 角色编辑页三个按钮
    await page.eval(`(async () => { App.Router.pop(); await new Promise(r => setTimeout(r, 200)); App.Router.push('characterEdit', { id: 'char_tall' }, {}); })()`);
    await sleep(800);
    const w2 = await page.eval(`(() => {
      var btns = Array.from(document.querySelectorAll('.ck-action-row .btn, .page-actions .btn, .ck-wizard-foot .btn'))
        .filter(function (b) { var r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && b.offsetParent !== null; });
      return btns.map(function (b) { return { t: (b.textContent || '').trim(), w: Math.round(b.getBoundingClientRect().width) }; });
    })()`);
    if (Array.isArray(w2) && w2.length >= 2 && w2.every(x => Math.abs(x.w - w2[0].w) <= 2)) ok(w + 'px 角色编辑底部按钮等宽', w2);
    else bad(w + 'px 角色编辑底部按钮不等宽', w2);
  }

  // ---------- A2. 页面可滚动 ----------
  await page.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true });
  await sleep(250);
  await page.eval(`App.Router.tab('settings')`);
  await sleep(700);
  const scrollSet = await page.eval(`(() => {
    var pages = Array.from(document.querySelectorAll('.page')).filter(function (p) { return p.offsetParent !== null; });
    var p = pages[pages.length - 1]; if (!p) return null;
    var before = p.scrollTop; p.scrollTop = 240;
    return { sh: p.scrollHeight, ch: p.clientHeight, before: before, after: p.scrollTop };
  })()`);
  if (scrollSet && scrollSet.sh > scrollSet.ch && scrollSet.after > 0) ok('设置页可滚动', scrollSet);
  else bad('设置页无法滚动', scrollSet);
  await page.eval(`App.Router.push('characterCreate', {}, {})`);
  await sleep(700);
  const wizardScroll = await page.eval(`(() => {
    var b = document.querySelector('.ck-wizard-body'); if (!b) return null;
    var before = b.scrollTop; b.scrollTop = 200;
    return { sh: b.scrollHeight, ch: b.clientHeight, before: before, after: b.scrollTop };
  })()`);
  if (wizardScroll && wizardScroll.sh > wizardScroll.ch && wizardScroll.after > 0) ok('创建向导内容区可滚动', wizardScroll);
  else bad('创建向导内容区无法滚动', wizardScroll);
  await page.eval(`App.Router.pop()`);
  await sleep(250);

  // ---------- B. 长图消息 ----------
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.eval(`App.Router.push('chat', { sessionId: 'sess_tall' }, {})`);
  await sleep(900);
  const tall = await waitFor(page, `!!document.querySelector('.msg-img-box.tall, .msg-image.tall')`, 6000);
  if (tall) ok('长图消息识别为长图卡片'); else bad('长图消息未标记为长图');
  const tag = await page.eval(`(() => { var t = document.querySelector('.msg-img-tag'); return t ? t.textContent : ''; })()`);
  if (String(tag).indexOf('长图') >= 0) ok('长图角标显示：' + tag); else bad('长图角标缺失', tag);
  const card = await page.eval(`(() => { var b = document.querySelector('.msg-img-box.tall .msg-attach-img, .msg-image.tall .msg-image-img'); if (!b) return null; var r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  if (card && card.h >= 240 && card.h <= 340) ok('长图缩略卡高度受控', card); else bad('长图缩略卡尺寸异常', card);
  await page.screenshot(path.join(SHOTS, '120-chat-tall.png'), { width: 390, height: 844 });

  await page.eval(`document.querySelector('.msg-img-box.tall .msg-attach-img, .msg-image.tall .msg-image-img').click()`);
  const viewer = await waitFor(page, `!!document.querySelector('.media-preview-scroll')`, 4000);
  if (viewer) ok('点击打开可滚动预览'); else bad('预览未使用滚动容器');
  const scrollInfo = await page.eval(`(() => {
    var s = document.querySelector('.media-preview-scroll');
    var i = s ? s.querySelector('img') : null;
    return s ? { sh: s.scrollHeight, ch: s.clientHeight, iw: i ? i.clientWidth : 0 } : null;
  })()`);
  if (scrollInfo && scrollInfo.sh >= scrollInfo.ch) ok('长图预览可纵向滚动', scrollInfo); else bad('长图预览不能滚动', scrollInfo);
  await page.screenshot(path.join(SHOTS, '121-tall-preview.png'), { width: 390, height: 844 });
  await page.eval(`App.UI.closeTopOverlay()`);

  await page.send('Emulation.clearDeviceMetricsOverride');
  console.log('\n========== 布局 E2E 结果 ==========');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  if (problems.length) { console.log('问题：'); problems.forEach(p => console.log(' - ' + p)); }
  await sleep(100);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
