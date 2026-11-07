/* E2E: 角色场景（多条 / 可为空 / 会话选场景 / 切换场景）v1.3.2
 * 用法：node scripts/e2e-scenes.js 9222 http://127.0.0.1:8321
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { CdpPage } = require('./cdp.js');

const CDP_PORT = Number(process.argv[2] || 9222);
const APP_URL = (process.argv[3] || 'http://127.0.0.1:8321').replace(/\/$/, '');
const ORIGIN = new URL(APP_URL).origin;
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
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
    } catch (e) { last = String((e && e.message) || e); }
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
async function clickText(selector, text) {
  return page.eval(`(() => {
    const list = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const el = list.filter(e => ((e.textContent || '').trim()).indexOf(${JSON.stringify(text)}) >= 0)[0];
    if (!el) return false;
    el.click();
    return true;
  })()`);
}
async function sheetItems() {
  return evalJSON(`Array.from(document.querySelectorAll('.sheet-item')).map(e => (e.textContent || '').trim())`);
}

const SEED = `
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await App.DB.clearAll(); localStorage.clear();
  await wait(120);
  const now = Date.now();
  await App.DB.put('providers', { id:'prov_guide', name:'示例引导 API', baseUrl:'https://api.example.com/v1', defaultModel:'gpt-4o-mini', role:'guide', isDefault:false, createdAt: now });
  await App.DB.put('providers', { id:'prov_chat', name:'我的聊天 API', baseUrl:'https://api.example.com/v1', defaultModel:'gpt-4o', role:'chat', isDefault:true, createdAt: now });
  await App.DB.put('characters', { id:'char_scene', name:'林夏', type:'companion', gender:'female', personality:'开朗直率', habits:'爱聊吃的', background:'旧书店店员', worldviewId:'', firstMessage:'今天也来啦？', alternateGreetings:[], scenarios:['雨夜的书店，只开了柜台一盏灯','清晨的厨房，水壶刚响'], scenario:'雨夜的书店，只开了柜台一盏灯', systemPrompt:'', avatar:'', fieldOrigin:{}, createdAt: now, updatedAt: now });
  await App.DB.put('characters', { id:'char_plain', name:'阿澄', type:'companion', gender:'male', personality:'安静', habits:'', background:'', worldviewId:'', firstMessage:'在呢。', alternateGreetings:[], scenarios:[], scenario:'', systemPrompt:'', avatar:'', fieldOrigin:{}, createdAt: now, updatedAt: now });
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
  await page.navigate('about:blank', 200);
  try { await page.clearStorage(ORIGIN); } catch (e) {}
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 2600);
  await page.eval(SEED);
  await page.navigate(APP_URL + '/index.html?seed=' + Date.now(), 3400);
  await waitFor(`!!(window.App && App.ChatKit && App.DB)`, 12000);

  console.log('\n[E2E] 角色场景');

  /* 1. 有场景的角色：新建会话先选场景 */
  await page.eval(`(() => {
    const btns = Array.from(document.querySelectorAll('.nav-action'));
    const plus = btns[btns.length - 1];
    if (plus) plus.click();
    return true;
  })()`);
  const pickerOpened = await waitFor(`!!document.querySelector('.char-picker-item')`, 6000);
  if (pickerOpened) ok('打开新建会话角色选择器');
  else bad('角色选择器没有打开');
  await page.eval(`(() => {
    const row = Array.from(document.querySelectorAll('.char-picker-item')).filter(e => ((e.textContent||'').indexOf('林夏')) >= 0)[0];
    if (row) row.click();
    return !!row;
  })()`);
  const sceneSheet = await waitFor(`!!document.querySelector('.sheet-item')`, 6000);
  if (sceneSheet) ok('有场景的角色会先弹出场景选择');
  else bad('没有弹出场景选择');
  const items = await sheetItems();
  const hasAuto = Array.isArray(items) && items.some(t => t.indexOf('由上下文自由判断') >= 0);
  const hasScene1 = Array.isArray(items) && items.some(t => t.indexOf('场景 1') >= 0);
  if (hasAuto) ok('场景面板包含「由上下文自由判断」');
  else bad('场景面板缺少自动选项', JSON.stringify(items));
  if (hasScene1) ok('场景面板列出角色保存的场景');
  else bad('场景面板没有场景项', JSON.stringify(items));
  await page.screenshot(path.join(SHOTS, '114-scene-sheet.png'));
  await clickText('.sheet-item', '场景 1');
  const chatOpened = await waitFor(`!!(App.Router.current() && App.Router.current().name === 'chat')`, 8000);
  if (chatOpened) ok('选择场景后进入聊天页');
  else bad('选择场景后没有进入聊天页');

  /* 2. 会话写入 scene */
  const sess = await evalJSON(`(async () => {
    const list = await App.DB.all('sessions');
    const s = list.sort((a,b)=>b.createdAt-a.createdAt)[0];
    return { id:s.id, scene:s.scene, count:list.length };
  })()`);
  if (sess && sess.scene === '雨夜的书店，只开了柜台一盏灯') ok('会话记录选择了第一个场景', JSON.stringify(sess));
  else bad('会话 scene 不正确', JSON.stringify(sess));

  /* 3. buildContext 注入当前场景 */
  const promptScene = await evalJSON(`(async () => {
    const ch = await App.DB.get('characters','char_scene');
    const ctx = App.ChatKit.buildContext({ character: ch, persona: null, preset: null, messages: [], scene: '雨夜的书店，只开了柜台一盏灯', scenarios: ch.scenarios });
    const sys = (ctx.messages||[]).filter(m=>m.role==='system').map(m=>String(m.content||'')).join(' ');
    return { hasCurrent: sys.indexOf('当前场景') >= 0, hasText: sys.indexOf('雨夜的书店') >= 0, hasAuto: sys.indexOf('可选场景') >= 0 };
  })()`);
  if (promptScene && promptScene.hasCurrent && promptScene.hasText && !promptScene.hasAuto) ok('system prompt 注入「当前场景」', JSON.stringify(promptScene));
  else bad('当前场景注入异常', JSON.stringify(promptScene));

  /* 4. 会话菜单切换场景为自动 */
  await page.eval(`(() => { const b = document.querySelector('.nav-action'); if (b) b.click(); return true; })()`);
  await waitFor(`!!document.querySelector('.sheet-item')`, 5000);
  await clickText('.sheet-item', '切换场景');
  await sleep(500);
  const sceneSheet2 = await waitFor(`!!document.querySelector('.sheet-wrap.show .sheet-item')`, 5000);
  if (sceneSheet2) ok('会话菜单可切换场景');
  else bad('切换场景面板没有打开');
  await page.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('.sheet-wrap.show .sheet-item'));
    const row = rows.filter(e => ((e.textContent||'').indexOf('由上下文自由判断')) >= 0)[0];
    if (row) row.click();
    return !!row;
  })()`);
  const autoSwitched = await waitFor(`App.DB.all('sessions').then(l => l.sort((a,b)=>b.createdAt-a.createdAt)[0].scene === '')`, 5000);
  const sessAuto = await evalJSON(`App.DB.all('sessions').then(l => l.sort((a,b)=>b.createdAt-a.createdAt)[0].scene)`);
  if (sessAuto === '') ok('切换为自动后 session.scene 为空');
  else bad('切换自动失败', String(sessAuto));
  const promptAuto = await evalJSON(`(async () => {
    const ch = await App.DB.get('characters','char_scene');
    const ctx = App.ChatKit.buildContext({ character: ch, persona: null, preset: null, messages: [], scene: '', scenarios: ch.scenarios });
    const sys = (ctx.messages||[]).filter(m=>m.role==='system').map(m=>String(m.content||'')).join(' ');
    return { hasAuto: sys.indexOf('可选场景') >= 0, hasCurrent: sys.indexOf('当前场景') >= 0 };
  })()`);
  if (promptAuto && promptAuto.hasAuto && !promptAuto.hasCurrent) ok('自动模式下 prompt 注入「可选场景」', JSON.stringify(promptAuto));
  else bad('自动模式 prompt 异常', JSON.stringify(promptAuto));

  /* 5. 无场景的角色：新建会话不弹场景选择 */
  await page.eval(`App.Router.tab('chatList')`);
  await sleep(800);
  await page.eval(`(() => {
    const btns = Array.from(document.querySelectorAll('.nav-action'));
    const plus = btns[btns.length - 1];
    if (plus) plus.click();
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.char-picker-item')`, 6000);
  await page.eval(`(() => {
    const row = Array.from(document.querySelectorAll('.char-picker-item')).filter(e => ((e.textContent||'').indexOf('阿澄')) >= 0)[0];
    if (row) row.click();
    return !!row;
  })()`);
  await sleep(900);
  await sleep(400);
  const noSheet = await page.eval(`document.querySelectorAll('.sheet-wrap.show').length === 0`);
  const plainSess = await evalJSON(`App.DB.all('sessions').then(l => l.sort((a,b)=>b.createdAt-a.createdAt)[0]).then(s => ({ scene:s.scene, charId:s.characterId }))`);
  if (noSheet) ok('无场景角色不弹场景选择');
  else bad('无场景角色仍弹出场景选择');
  if (plainSess && plainSess.scene === '' && plainSess.charId === 'char_plain') ok('无场景角色新会话 scene 为空', JSON.stringify(plainSess));
  else bad('无场景角色会话异常', JSON.stringify(plainSess));

  /* 6. 角色编辑页：场景行 + 添加/保存 */
  await page.eval(`App.Router.push('characterEdit', { id: 'char_scene' })`);
  await waitFor(`!!document.querySelector('[data-guide-focus="characterScenarios"]')`, 8000);
  const rowText = await page.eval(`(document.querySelector('[data-guide-focus="characterScenarios"]') || {}).textContent || ''`);
  if (rowText.indexOf('2 条') >= 0) ok('编辑页场景行显示条数', rowText.replace(/\s+/g, ' ').trim());
  else bad('编辑页场景行文本异常', rowText);
  await page.eval(`document.querySelector('[data-guide-focus="characterScenarios"]').click()`);
  await waitFor(`!!document.querySelector('.ck-scene-modal')`, 5000);
  await clickText('.ck-scene-modal button', '添加场景');
  await sleep(300);
  await page.eval(`(() => {
    const tas = document.querySelectorAll('.ck-scene-modal textarea');
    const ta = tas[tas.length - 1];
    if (!ta) return false;
    ta.value = '深夜的便利店里，只有我们两个客人';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  await clickText('.modal button', '保存');
  await sleep(400);
  await page.eval(`(() => { const b = document.querySelector('#ck-edit-save'); if (b) b.click(); return !!b; })()`);
  await waitFor(`App.DB.get('characters','char_scene').then(c => Array.isArray(c.scenarios) && c.scenarios.length === 3)`, 6000);
  const savedScenes = await evalJSON(`App.DB.get('characters','char_scene').then(c => ({ scenarios: c.scenarios, scenario: c.scenario }))`);
  if (savedScenes && Array.isArray(savedScenes.scenarios) && savedScenes.scenarios.length === 3 && savedScenes.scenario === '雨夜的书店，只开了柜台一盏灯') ok('编辑页保存后场景落库（3 条，主场景为第一条）', JSON.stringify(savedScenes));
  else bad('场景保存异常', JSON.stringify(savedScenes));

  /* 7. 截图聊天页（带场景） */
  await page.eval(`App.Router.push('chat', { sessionId: '${sess && sess.id}' })`);
  await sleep(1200);
  await page.screenshot(path.join(SHOTS, '115-scene-chat.png'));

  console.log('\n========== 场景 E2E 结果 ==========');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  if (fail) { console.log('失败项：'); problems.forEach(p => console.log(' - ' + p)); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
})().catch(err => {
  console.error('E2E 运行失败：', err && err.stack || err);
  process.exit(1);
});
