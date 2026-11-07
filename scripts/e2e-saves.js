/* E2E: App.Saves 存档 / 读档 / 以存档开新对话（模块级 + 聊天页 UI）
 * 用法：node scripts/e2e-saves.js 9222 http://127.0.0.1:8321
 */
'use strict';
const path = require('path');
const { CdpPage } = require('./cdp.js');

const CDP_PORT = Number(process.argv[2] || 9222);
const APP_URL = (process.argv[3] || 'http://127.0.0.1:8321').replace(/\/$/, '');
const ORIGIN = new URL(APP_URL).origin;
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
const fs = require('fs');
if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });

let page;
let pass = 0, fail = 0;
const problems = [];
function ok(name, extra) { pass++; console.log('  ✓ ' + name + (extra ? '  → ' + extra : '')); }
function bad(name, extra) { fail++; problems.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(expr, timeout = 10000, interval = 120) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await page.eval(expr);
      last = v;
      if (v) return v;
    } catch (e) { last = String(e && e.message || e); }
    await sleep(interval);
  }
  return false;
}
async function evalJSON(expr) {
  const raw = await page.eval(`(async () => {
    try { return JSON.stringify(await (async () => (` + expr + `))()); }
    catch (e) { return JSON.stringify({ __error: String((e && e.message) || e) }); }
  })()`);
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

const SEED = `
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await App.DB.clearAll(); localStorage.clear();
  await wait(120);
  const now = Date.now();
  await App.DB.put('providers', { id:'prov_guide', name:'示例引导 API', baseUrl:'https://api.example.com/v1', defaultModel:'gpt-4o-mini', role:'guide', isDefault:false, createdAt: now });
  await App.DB.put('providers', { id:'prov_chat', name:'我的聊天 API', baseUrl:'https://api.example.com/v1', defaultModel:'gpt-4o', role:'chat', isDefault:true, createdAt: now });
  await App.DB.put('characters', { id:'char_save', name:'林夏', type:'companion', gender:'female', personality:'开朗直率', habits:'爱聊吃的', background:'书店店员', worldviewId:'', firstMessage:'首选问候：今天也来啦？', alternateGreetings:['备选一：我带了你的爱吃的那家。'], systemPrompt:'', avatar:'', fieldOrigin:{}, createdAt: now, updatedAt: now });
  await App.DB.put('sessions', { id:'sess_save', title:'林夏', characterId:'char_save', personaId:'', presetId:'', model:'gpt-4o', providerId:'prov_chat', pinned:false, unread:0, isGenerating:false, greetingIndex:0, lastText:'', lastRole:'', lastAt: now, createdAt: now, updatedAt: now });
  await App.DB.bulkPut('messages', [
    { id:'m1', sessionId:'sess_save', role:'assistant', content:'首选问候：今天也来啦？', variantIndex:0, isActive:true, status:'ok', createdAt: now - 3000 },
    { id:'m2', sessionId:'sess_save', role:'user', content:'嗯，来看看书。', variantIndex:0, isActive:true, status:'ok', createdAt: now - 2000 },
    { id:'m3', sessionId:'sess_save', role:'assistant', content:'今天进了一批旧唱片，要不要看看？', variantIndex:0, isActive:true, status:'ok', createdAt: now - 1000 }
  ]);
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('last_tab', 'chatList');
  return 'seeded';
})()
`;

(async () => {
  page = await CdpPage.connect(CDP_PORT);
  await page.init();
  page.on('console', () => {});
  console.log('\n[E2E] 存档 / 读档 / 新开对话');
  await page.navigate('about:blank', 200);
  try { await page.clearStorage(ORIGIN); } catch (e) {}
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 2600);
  await page.eval(SEED);
  await page.navigate(APP_URL + '/index.html?seed=' + Date.now(), 3200);
  await waitFor(`!!(window.App && App.Saves && App.DB)`, 10000);

  /* 1. 模块级：存档 */
  const snap = await evalJSON(`(async () => {
    const s = await App.Saves.snapshot('sess_save', { name: '书店存档' });
    const list = await App.Saves.list({ sessionId: 'sess_save' });
    return { id: s.id, name: s.name, count: s.messages.length, listLen: list.length, characterId: s.characterId };
  })()`);
  if (snap && snap.id && snap.count === 3 && snap.listLen === 1) ok('存档快照包含 3 条消息并可列出', JSON.stringify(snap));
  else bad('存档失败', JSON.stringify(snap));
  const saveId = snap && snap.id;

  /* 2. 再发两条消息后读档 */
  await page.eval(`(async () => {
    const now = Date.now();
    await App.DB.bulkPut('messages', [
      { id:'m4', sessionId:'sess_save', role:'user', content:'这条应该被回档丢掉', variantIndex:0, isActive:true, status:'ok', createdAt: now },
      { id:'m5', sessionId:'sess_save', role:'assistant', content:'这条也会被回档丢掉', variantIndex:0, isActive:true, status:'ok', createdAt: now + 10 }
    ]);
    return 'added';
  })()`);
  const beforeRestore = await evalJSON(`App.DB.byIndex('messages','sessionId','sess_save').then(a => a.length)`);
  if (beforeRestore === 5) ok('读档前会话有 5 条消息');
  else bad('读档前消息数异常', String(beforeRestore));

  const restored = await evalJSON(`(async () => {
    const r = await App.Saves.restore('${saveId}');
    const msgs = await App.DB.byIndex('messages','sessionId','sess_save');
    msgs.sort((a,b)=>a.createdAt-b.createdAt);
    const ses = await App.DB.get('sessions','sess_save');
    return { count: msgs.length, contents: msgs.map(m=>m.content), unread: ses.unread, lastText: ses.lastText };
  })()`);
  if (restored && restored.count === 3 && restored.contents[1] === '嗯，来看看书。') ok('读档后消息回到 3 条且内容一致');
  else bad('读档后消息不一致', JSON.stringify(restored));
  if (restored && restored.unread === 0) ok('读档后未读数清零');
  else bad('读档后未读数未清零', String(restored && restored.unread));

  /* 3. 以存档开新对话 */
  const newSess = await evalJSON(`(async () => {
    const s = await App.Saves.newFromSave('${saveId}');
    const msgs = await App.DB.byIndex('messages','sessionId',s.id);
    return { id: s.id, characterId: s.characterId, count: msgs.length, same: s.id === 'sess_save' };
  })()`);
  if (newSess && newSess.id && newSess.id !== 'sess_save' && newSess.count === 3 && newSess.characterId === 'char_save') {
    ok('以存档开新对话：新会话 + 3 条消息', JSON.stringify(newSess));
  } else bad('以存档开新对话失败', JSON.stringify(newSess));

  /* 4. 重命名 + 删除 */
  const renamed = await evalJSON(`(async () => {
    await App.Saves.rename('${saveId}', '改过的名字');
    const s = await App.Saves.get('${saveId}');
    return s.name;
  })()`);
  if (renamed === '改过的名字') ok('存档可重命名');
  else bad('重命名失败', String(renamed));

  /* 5. 聊天页 UI：菜单入口可见（存档 / 存档点） */
  await page.eval(`App.Router.push('chat', { sessionId: 'sess_save' })`);
  await waitFor(`!!document.querySelector('.msg-list .msg')`, 8000);
  const menuOk = await evalJSON(`(async () => {
    const btn = document.querySelector('.nav-action');
    if (!btn) return { ok:false, reason:'no .nav-action' };
    btn.click();
    await new Promise(r=>setTimeout(r, 400));
    const texts = Array.from(document.querySelectorAll('.sheet-item')).map(e => (e.textContent||'').trim());
    const all = texts.join(' | ');
    const hasSave = all.indexOf('存档') >= 0;
    const hasPoints = all.indexOf('存档点') >= 0;
    return { ok: hasSave && hasPoints, texts };
  })()`).catch(e => ({ ok: false, reason: String(e && e.message || e) }));
  if (menuOk && menuOk.ok) ok('会话菜单含「存档」与「存档点」');
  else bad('会话菜单缺少存档入口', JSON.stringify(menuOk));

  await page.screenshot(path.join(SHOTS, '99-saves-menu.png'));
  await page.eval(`App.UI.closeTopOverlay && App.UI.closeTopOverlay()`);

  console.log('\n========== 存档 E2E 结果 ==========');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  if (problems.length) { console.log('问题：'); problems.forEach(p => console.log(' - ' + p)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n[E2E] 崩溃：', e && e.stack || e); process.exit(2); });

