/* 聊天页 E2E（无头 Chrome，浏览器 mock 流式）
   验证：
   - 打开会话：历史消息渲染、发送按钮可用
   - 发送消息 → 流式逐字输出 → 生成中按钮变「停止」→ 结束后落库（assistant 内容非空）
   - 生成中点「停止」→ 保留已生成内容、按钮恢复
   - 消息操作 → 重新生成 → variants 增加
   用法：node scripts/e2e-chat.js 9222 http://127.0.0.1:8321 */
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

const SEED = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(window.App && App.DB && App.Router); i++) await wait(50);
  await App.DB.ready;
  const now = Date.now();
  await App.DB.put('providers', { id: 'prov_guide', name: '示例引导 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o-mini', role: 'guide', createdAt: now, updatedAt: now });
  await App.DB.put('providers', { id: 'prov_chat', name: '示例聊天 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', role: 'chat', createdAt: now + 1, updatedAt: now + 1 });
  await App.Bridge.call('secure.set', { key: 'key:prov_guide', value: 'sk-demo-guide-123456' });
  await App.Bridge.call('secure.set', { key: 'key:prov_chat', value: 'sk-demo-chat-123456' });
  const char = {
    id: 'char_1', type: 'companion', name: '林夏', avatar: '', worldviewId: 'wv-modern',
    personality: '开朗直率', habits: '爱聊吃的', background: '', speechStyle: '', catchphrases: '',
    scenario: '', firstMessage: '外面雨好大，先进来躲一下吧。要喝点热的吗？', exampleDialogues: [],
    systemPrompt: '', domain: '', specialty: [], duties: [], answerStyle: '', knowledgeBoundary: '', refusalPolicy: '',
    draft: {}, fieldOrigin: {}, generatedAt: now, createdAt: now, updatedAt: now
  };
  await App.DB.put('characters', char);
  await App.DB.put('sessions', { id: 'sess_1', title: '林夏', characterId: 'char_1', personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_chat', pinned: false, updatedAt: now, createdAt: now });
  await App.DB.put('messages', { id: 'm1', sessionId: 'sess_1', role: 'assistant', content: char.firstMessage, variantIndex: 0, isActive: true, status: 'ok', errorText: '', tokensIn: 0, tokensOut: 0, createdAt: now + 1 });
  await App.DB.put('messages', { id: 'm2', sessionId: 'sess_1', role: 'user', content: '好啊，来杯热的。', variantIndex: 0, isActive: true, status: 'ok', errorText: '', tokensIn: 0, tokensOut: 0, createdAt: now + 2 });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('last_tab', 'chatList');
  await App.DB.settings.set('theme', 'light');
  return { ok: true };
})()`;

const jsFill = (sel, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return 'notfound';
  el.focus();
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`;

const jsClick = (sel, text) => `(() => {
  const list = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
  const t = ${text ? `list.find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}))` : 'list[0]'};
  if (!t) return 'notfound';
  t.click();
  return 'ok';
})()`;

const jsClickLast = (sel) => `(() => {
  const list = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
  if (!list.length) return 'notfound';
  list[list.length - 1].click();
  return 'ok';
})()`;

const jsChat = `(() => {
  const cur = App.Router.current();
  const send = document.querySelector('.composer-send');
  const bubbles = Array.from(document.querySelectorAll('.msg-bubble'));
  return {
    page: cur && cur.name,
    sendText: send ? (send.textContent || '').trim() : '',
    msgCount: document.querySelectorAll('.msg').length,
    lastBubble: bubbles.length ? bubbles[bubbles.length - 1].innerText : '',
    bodyText: (document.querySelector('.chat-msg-list') || {}).innerText || ''
  };
})()`;

async function waitFor(page, expr, timeoutMs = 10000, intervalMs = 150) {
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

  console.log('[E2E] 聊天页');

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

  // ---------- 1. 打开会话 ----------
  await page.eval(`(async () => { await App.Router.push('chat', { sessionId: 'sess_1' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  let st = await page.eval(jsChat);
  if (st.page === 'chat') ok('打开聊天页');
  else bad('未打开聊天页：' + st.page);
  if (st.msgCount >= 2) ok('历史消息已渲染（' + st.msgCount + ' 条）');
  else bad('历史消息渲染数量异常：' + st.msgCount);
  if (st.sendText === '发送') ok('发送按钮就绪');
  else bad('发送按钮文案异常：' + st.sendText);
  await page.screenshot(path.join(SHOTS, '40-chat-history.png'));

  // ---------- 2. 发送消息 → 流式 → 落库 ----------
  await page.eval(jsFill('.composer-input', '你好呀，今天过得怎么样？'));
  await sleep(150);
  if ((await page.eval(jsClick('.composer-send'))) !== 'ok') bad('点不到发送按钮');
  // 生成中：按钮应变「停止」
  const streaming = await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '停止'; })()`, 3000);
  if (streaming) ok('生成中按钮变为「停止」');
  else bad('生成中按钮未变为「停止」');
  await page.screenshot(path.join(SHOTS, '41-chat-streaming.png'));

  const done = await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '发送'; })()`, 15000);
  if (done) ok('流式生成结束，按钮恢复「发送」');
  else bad('流式生成没有结束（按钮未恢复）');
  await sleep(600);
  st = await page.eval(jsChat);
  if (/演示模式/.test(st.lastBubble)) ok('生成的回复显示在消息列表中');
  else bad('消息列表没有显示生成的回复');
  if (/林夏|你好呀/.test(st.bodyText)) ok('用户消息已上屏');
  else bad('用户消息未上屏');

  const saved = await page.eval(`(async () => {
    const rows = await App.DB.byIndex('messages', 'sessionId', 'sess_1');
    return rows.map(m => ({ role: m.role, status: m.status, content: String(m.content || '').slice(0, 40), variants: (m.variants || []).length }));
  })()`);
  const lastAssistant = [...saved].reverse().find((m) => m.role === 'assistant');
  if (saved.length >= 4) ok('消息已落库（' + saved.length + ' 条）');
  else bad('消息落库数量异常：' + saved.length);
  if (lastAssistant && lastAssistant.content && /演示模式/.test(lastAssistant.content)) ok('assistant 回复已落库：' + lastAssistant.content);
  else bad('assistant 回复未正确落库：' + JSON.stringify(lastAssistant));
  await page.screenshot(path.join(SHOTS, '42-chat-done.png'));

  // ---------- 3. 生成中停止 ----------
  await page.eval(jsFill('.composer-input', '再说一句试试'));
  await sleep(120);
  await page.eval(jsClick('.composer-send'));
  await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '停止'; })()`, 3000);
  await sleep(700);
  await page.eval(jsClick('.composer-send')); // 停止
  const stopped = await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '发送'; })()`, 5000);
  if (stopped) ok('停止后按钮恢复「发送」');
  else bad('停止后按钮未恢复');
  await sleep(500);
  const afterStop = await page.eval(`(async () => {
    const rows = await App.DB.byIndex('messages', 'sessionId', 'sess_1');
    const roles = rows.map(m => m.role);
    const last = rows[rows.length - 1] || {};
    return { count: rows.length, roles: roles, last: { role: last.role, status: last.status, len: String(last.content || '').length } };
  })()`);
  if (afterStop.last.role === 'assistant') ok('停止后保留了已生成的 assistant 消息（长度 ' + afterStop.last.len + '）');
  else bad('停止后最后一条不是 assistant：' + JSON.stringify(afterStop.last));
  if (afterStop.last.status !== 'streaming') ok('停止后没有残留 streaming 状态');
  else bad('停止后消息仍是 streaming 状态');
  st = await page.eval(jsChat);
  if (!st.bodyText.includes('生成中')) ok('界面没有卡在生成中');
  await page.screenshot(path.join(SHOTS, '43-chat-stopped.png'));

  // ---------- 4. 消息操作 → 重新生成（多版本） ----------
  const beforeVariants = await page.eval(`(async () => {
    const rows = (await App.DB.byIndex('messages', 'sessionId', 'sess_1')).filter(m => m.role === 'assistant');
    return (rows[rows.length - 1].variants || []).length;
  })()`);
  if ((await page.eval(jsClickLast('.msg-op'))) !== 'ok') bad('点不到消息操作按钮');
  await sleep(500);
  const sheetText = await page.eval(`(() => (document.querySelector('.sheet') || {}).innerText || '')()`);
  if (/重新生成/.test(sheetText)) ok('消息操作菜单含「重新生成」');
  else bad('消息操作菜单缺少「重新生成」：' + sheetText.slice(0, 80));
  if ((await page.eval(jsClick('.sheet button, .sheet .sheet-item', '重新生成'))) !== 'ok') bad('点不到「重新生成」');
  const regenStarted = await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '停止'; })()`, 5000);
  if (regenStarted) ok('重新生成已开始流式输出');
  else bad('重新生成没有进入生成态');
  await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '发送'; })()`, 15000);
  await sleep(800);
  const afterRegen = await page.eval(`(async () => {
    const rows = (await App.DB.byIndex('messages', 'sessionId', 'sess_1')).filter(m => m.role === 'assistant');
    const last = rows[rows.length - 1];
    return { variants: (last.variants || []).length, len: String(last.content || '').length };
  })()`);
  if (afterRegen.variants > beforeVariants) ok('重新生成产生新版本（variants ' + beforeVariants + ' → ' + afterRegen.variants + '）');
  else bad('重新生成未产生新版本：' + JSON.stringify(afterRegen));
  await page.screenshot(path.join(SHOTS, '44-chat-regenerated.png'));

  console.log('');
  if (problems.length) {
    console.log('结果：' + problems.length + ' 个问题');
    problems.forEach((p, i) => console.log('  ' + (i + 1) + ') ' + p));
    process.exit(1);
  }
  console.log('结果：全部通过');
  process.exit(0);
})().catch((e) => { console.error('E2E 崩溃：', e && e.stack || e); process.exit(2); });
