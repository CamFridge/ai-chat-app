/* 主动消息 E2E（无头 Chrome，浏览器 mock）
   验证 v1.2.0「角色主动消息」：
   - 设置读取：proactive_enabled / proactive_interval_min 生效
   - checkNow：空闲超时 + 当日未超 3 条 → 生成一条 assistant 消息、会话 unread+1、事件广播、当日计数+1
   - 节流：刚发过（proactive_last_at 新）时不再发
   - 每日上限：当日已 3 条时不再发
   - 关闭开关后不触发
   - 切后台/回前台：通过 notify.schedule / notify.cancel 桥调用（浏览器 mock 记录）
   用法：node scripts/e2e-proactive.js 9222 http://127.0.0.1:8321 */
'use strict';
const path = require('path');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9222);
const APP_URL = process.argv[3] || 'http://127.0.0.1:8321';
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
const ORIGIN = new URL(APP_URL).origin;

const problems = [];
const ok = (m) => console.log('  \u2713 ' + m);
const bad = (m) => { problems.push(m); console.log('  \u2717 ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OLD = 'Date.now() - 30 * 60 * 1000';

const SEED = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(window.App && App.DB && App.Router); i++) await wait(50);
  await App.DB.ready;
  const now = Date.now();
  const oldAt = now - 30 * 60 * 1000;
  await App.DB.put('providers', { id: 'prov_guide', name: '示例引导 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o-mini', role: 'guide', createdAt: now, updatedAt: now });
  await App.DB.put('providers', { id: 'prov_chat', name: '示例聊天 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', role: 'chat', createdAt: now + 1, updatedAt: now + 1 });
  await App.Bridge.call('secure.set', { key: 'key:prov_guide', value: 'sk-demo-guide-123456' });
  await App.Bridge.call('secure.set', { key: 'key:prov_chat', value: 'sk-demo-chat-123456' });
  await App.DB.put('characters', {
    id: 'char_p', type: 'companion', name: '林夏', avatar: '', worldviewId: 'wv-modern',
    personality: '开朗直率', habits: '爱聊吃的', background: '', speechStyle: '', catchphrases: '',
    scenario: '', firstMessage: '外面雨好大，先进来躲一下吧。要喝点热的吗？',
    alternateGreetings: ['备选问候一：今天也来找我啦？', '备选问候二：我刚泡好茶。'],
    exampleDialogues: [], systemPrompt: '', fieldOrigin: {}, generatedAt: now, createdAt: now, updatedAt: now
  });
  await App.DB.put('sessions', { id: 'sess_p', title: '林夏', characterId: 'char_p', personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_chat', pinned: false, unread: 0, greetingIndex: 0, updatedAt: oldAt, createdAt: oldAt });
  await App.DB.put('messages', { id: 'mp1', sessionId: 'sess_p', role: 'assistant', content: '外面雨好大，先进来躲一下吧。要喝点热的吗？', variantIndex: 0, isActive: true, status: 'ok', createdAt: oldAt });
  await App.DB.put('messages', { id: 'mp2', sessionId: 'sess_p', role: 'user', content: '好啊，来杯热的。', variantIndex: 0, isActive: true, status: 'ok', createdAt: oldAt + 1 });
  await App.DB.put('messages', { id: 'mp3', sessionId: 'sess_p', role: 'assistant', content: '给你，小心烫。', variantIndex: 0, isActive: true, status: 'ok', createdAt: oldAt + 2 });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('last_tab', 'chatList');
  await App.DB.settings.set('theme', 'light');
  await App.DB.settings.set('proactive_enabled', true);
  await App.DB.settings.set('proactive_interval_min', 15);
  await App.DB.settings.set('proactive_last_at', 0);
  await App.DB.settings.set('proactive_day', '');
  await App.DB.settings.set('proactive_day_count', 0);
  return { ok: true };
})()`;

const MOCK_CHAT_ONCE = `(() => {
  window.__PROACTIVE_REPLY__ = '*伸了个懒腰，把杯子往你那边推了推* 你终于来啦，我刚才还在想你呢。';
  window.__PROACTIVE_EVENTS__ = [];
  document.addEventListener('aichat:session-updated', (e) => { window.__PROACTIVE_EVENTS__.push(e.detail || {}); });
  App.API.chatOnce = function () {
    return Promise.resolve({ ok: true, text: window.__PROACTIVE_REPLY__, usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }, error: null });
  };
  return 'ok';
})()`;

const STATE = `(async () => {
  const msgs = await App.DB.byIndex('messages', 'sessionId', 'sess_p');
  msgs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const sess = await App.DB.get('sessions', 'sess_p');
  const enabled = await App.DB.settings.get('proactive_enabled', false);
  const lastAt = await App.DB.settings.get('proactive_last_at', 0);
  const dayCount = await App.DB.settings.get('proactive_day_count', 0);
  const day = await App.DB.settings.get('proactive_day', '');
  const proactive = App.Proactive.status();
  return {
    msgCount: msgs.length,
    lastRole: msgs.length ? msgs[msgs.length - 1].role : '',
    lastContent: msgs.length ? String(msgs[msgs.length - 1].content || '') : '',
    unread: sess.unread || 0,
    lastText: sess.lastText || '',
    enabled: !!enabled,
    lastAt: Number(lastAt || 0),
    dayCount: Number(dayCount || 0),
    day: day,
    statusText: App.Proactive.statusText(),
    pEnabled: !!proactive.enabled,
    pInterval: proactive.intervalMin,
    events: window.__PROACTIVE_EVENTS__ || [],
    notifyCalls: window.__AICHAT_NOTIFY_CALLS__ || []
  };
})()`;

const todayKey = `(() => { const d = new Date(); const m = d.getMonth() + 1; const day = d.getDate(); return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day); })()`;

async function waitFor(page, expr, timeoutMs = 10000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await page.eval(expr)) return true; } catch (e) {}
    await sleep(intervalMs);
  }
  return false;
}

(async () => {
  const page = await CdpPage.connect(PORT);
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });

  console.log('[E2E] 主动消息');

  await page.navigate('about:blank', 300);
  await page.clearStorage(ORIGIN);
  await page.navigate(APP_URL + '/index.html', 900);
  await waitFor(page, `(() => !!(window.App && App.DB && App.Router && App.Router.current()))()`, 8000);
  await page.eval(`(async () => { try { await App.DB.clearAll(); } catch (e) {} try { localStorage.clear(); } catch (e) {} return true; })()`);
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 900);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);
  await sleep(300);
  const seeded = await page.eval(SEED);
  if (!seeded || !seeded.ok) bad('种子数据写入失败');
  await page.navigate(APP_URL + '/index.html?seed=' + Date.now(), 1800);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);
  await page.eval(`(() => { window.__PROACTIVE_EVENTS__ = []; document.addEventListener('aichat:session-updated', (e) => { window.__PROACTIVE_EVENTS__.push(e.detail || {}); }); return 'ok'; })()`);

  // ---------- 1. 设置与状态 ----------
  let st = await page.eval(STATE);
  if (st.pEnabled === true) ok('主动消息开关已开启（App.Proactive.status.enabled=true）');
  else bad('主动消息开关未生效：' + JSON.stringify(st.pEnabled));
  if (st.pInterval === 15) ok('间隔读取正确（15 分钟）');
  else bad('间隔读取异常：' + st.pInterval);
  if (/15 分钟/.test(st.statusText)) ok('状态文案正确：' + st.statusText);
  else bad('状态文案异常：' + st.statusText);

  // ---------- 2. checkNow 触发主动消息 ----------
  await page.eval(MOCK_CHAT_ONCE);
  const before = st;
  await page.eval(`(async () => { await App.Proactive.checkNow(); return true; })()`);
  await waitFor(page, `(async () => { const msgs = await App.DB.byIndex('messages','sessionId','sess_p'); return msgs.length >= 4 && msgs[msgs.length-1].role === 'assistant'; })()`, 8000);
  await sleep(400);
  st = await page.eval(STATE);
  if (st.msgCount >= before.msgCount + 1) ok('主动消息已生成并落库（消息数 ' + before.msgCount + '→' + st.msgCount + '）');
  else bad('主动消息没有落库：' + before.msgCount + '→' + st.msgCount);
  if (st.lastRole === 'assistant' && /你终于来啦/.test(st.lastContent)) ok('最后一条是主动消息：' + st.lastContent.slice(0, 30));
  else bad('最后一条消息异常：' + st.lastRole + ' / ' + st.lastContent.slice(0, 30));
  if (st.unread >= 1) ok('会话未读 +1（unread=' + st.unread + '）');
  else bad('会话未读没有增加：' + st.unread);
  if (st.lastText && st.lastText.length > 0) ok('会话摘要已更新：' + st.lastText.slice(0, 24));
  else bad('会话摘要未更新');
  if (st.dayCount >= 1 && st.day === (await page.eval(todayKey))) ok('当日计数 +1（' + st.day + ' / ' + st.dayCount + '）');
  else bad('当日计数异常：' + st.day + ' / ' + st.dayCount);
  if (st.events.some((e) => e && e.reason === 'proactive')) ok('广播了 aichat:session-updated（reason=proactive）');
  else bad('没有收到刷新事件');
  if (st.lastAt > 0) ok('记录 proactive_last_at');
  else bad('proactive_last_at 未记录');
  await page.screenshot(path.join(SHOTS, '90-proactive-list.png'));

  // ---------- 3. 节流：立即再检查不应重复发 ----------
  const n1 = st.msgCount;
  await page.eval(`(async () => { await App.Proactive.checkNow(); return true; })()`);
  await sleep(1200);
  st = await page.eval(STATE);
  if (st.msgCount === n1) ok('间隔未到时不重复发送（仍 ' + st.msgCount + ' 条）');
  else bad('间隔内被重复发送：' + n1 + '→' + st.msgCount);

  // ---------- 4. 每日上限 ----------
  await page.eval(`(async () => {
    const d = new Date(); const m = d.getMonth() + 1; const day = d.getDate();
    const key = d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
    await App.DB.settings.set('proactive_day', key);
    await App.DB.settings.set('proactive_day_count', 3);
    await App.DB.settings.set('proactive_last_at', 0);
    return true;
  })()`);
  const n2 = st.msgCount;
  await page.eval(`(async () => { await App.Proactive.checkNow(); return true; })()`);
  await sleep(1200);
  st = await page.eval(STATE);
  if (st.msgCount === n2) ok('当日已达 3 条上限，不再发送');
  else bad('超过每日上限仍发送：' + n2 + '→' + st.msgCount);

  // ---------- 5. 关闭开关 ----------
  await page.eval(`(async () => { await App.Proactive.setEnabled(false); return true; })()`);
  const n3 = st.msgCount;
  await page.eval(`(async () => { await App.DB.settings.set('proactive_last_at', 0); await App.Proactive.checkNow(); return true; })()`);
  await sleep(900);
  st = await page.eval(STATE);
  if (st.pEnabled === false) ok('关闭开关后 App.Proactive.status.enabled=false');
  else bad('关闭开关未生效');
  if (st.msgCount === n3) ok('关闭后不再主动发送');
  else bad('关闭后仍发送：' + n3 + '→' + st.msgCount);

  // ---------- 6. 后台通知桥调用 ----------
  await page.eval(`(async () => { await App.Proactive.setEnabled(true); window.__AICHAT_NOTIFY_CALLS__ = []; return true; })()`);
  await page.eval(`(() => { try { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); } catch (e) {} document.dispatchEvent(new Event('visibilitychange')); return 'ok'; })()`);
  await sleep(700);
  st = await page.eval(STATE);
  if (st.notifyCalls.some((c) => c.method === 'notify.schedule')) ok('切后台调用 notify.schedule 排期通知');
  else bad('切后台没有调用 notify.schedule：' + JSON.stringify(st.notifyCalls));
  const sched = st.notifyCalls.filter((c) => c.method === 'notify.schedule').pop();
  if (sched && sched.args && Number(sched.args.delayMs) >= 15 * 60000) ok('排期时长与间隔一致（' + Math.round(Number(sched.args.delayMs) / 60000) + ' 分钟）');
  else bad('排期时长异常：' + (sched && sched.args && sched.args.delayMs));
  await page.eval(`(() => { try { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); } catch (e) {} document.dispatchEvent(new Event('visibilitychange')); return 'ok'; })()`);
  await sleep(700);
  st = await page.eval(STATE);
  if (st.notifyCalls.some((c) => c.method === 'notify.cancel')) ok('回前台调用 notify.cancel 取消排期');
  else bad('回前台没有调用 notify.cancel：' + JSON.stringify(st.notifyCalls));

  // ---------- 7. 设置页开关联动（可选，页面已在则点一下） ----------
  const switchOk = await page.eval(`(async () => {
    await App.Router.tab('settings');
    await new Promise(r => setTimeout(r, 800));
    const row = document.querySelector('[data-guide-focus="proactive"]');
    if (!row) return 'norow';
    const sw = row.querySelector('.cfg-switch, .switch');
    if (!sw) return 'noswitch';
    const before = sw.classList.contains('on');
    sw.click();
    await new Promise(r => setTimeout(r, 500));
    const val = await App.DB.settings.get('proactive_enabled', null);
    const after = sw.classList.contains('on');
    sw.click();
    await new Promise(r => setTimeout(r, 400));
    return JSON.stringify({ found: true, before, after, val });
  })()`);
  let sw = null;
  try { sw = JSON.parse(switchOk); } catch (e) { /* 不是 JSON */ }
  if (switchOk === 'norow') bad('设置页没有「主动消息」分组/行');
  else if (switchOk === 'noswitch') bad('设置页「主动消息」行没有开关控件');
  else if (sw && sw.found) {
    if (sw.after !== sw.before && sw.val === sw.after) ok('设置页开关可切换并写入 proactive_enabled');
    else bad('设置页开关写入异常：' + switchOk);
  } else bad('设置页开关测试返回异常：' + switchOk);

  console.log('\n========== 主动消息 E2E 结果 ==========');
  if (problems.length) {
    console.log('失败 ' + problems.length + ' 项：');
    problems.forEach((p) => console.log('  - ' + p));
    process.exit(1);
  } else {
    console.log('全部通过');
  }
  process.exit(0);
})().catch((e) => {
  console.error('[E2E] 异常', e && (e.stack || e.message || e));
  process.exit(1);
});
