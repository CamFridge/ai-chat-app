/* E2E: v1.3.0 新功能（聊天外观 / 性别 / 角色级上帝模式 / 图片库独立入口）
 * 用法：node scripts/e2e-v130.js 9333 http://127.0.0.1:8321
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
const PNG = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-photo.png')).toString('base64');

let page;
let pass = 0, fail = 0;
const problems = [];
function ok(n, x) { pass++; console.log('  ✓ ' + n + (x ? '  → ' + x : '')); }
function bad(n, x) { fail++; problems.push(n + (x ? ' → ' + x : '')); console.log('  ✗ ' + n + (x ? '  → ' + x : '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(expr, timeout = 10000, interval = 120) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await page.eval(expr); if (v) return v; } catch (e) {}
    await sleep(interval);
  }
  return false;
}
async function evalJSON(expr) {
  const raw = await page.eval(`(async () => {
    try { return JSON.stringify(await (async () => (${expr}))()); }
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
  await App.DB.put('characters', { id:'char_v130', name:'林夏', type:'companion', gender:'female', godMode:false, personality:'开朗直率', habits:'爱聊吃的', background:'书店店员', worldviewId:'', firstMessage:'首选问候：今天也来啦？', alternateGreetings:['备选一：我带了你的爱吃的那家。'], systemPrompt:'', avatar:'', fieldOrigin:{}, createdAt: now, updatedAt: now });
  await App.DB.put('sessions', { id:'sess_v130', title:'林夏', characterId:'char_v130', personaId:'', presetId:'', model:'gpt-4o', providerId:'prov_chat', pinned:false, unread:0, isGenerating:false, greetingIndex:0, lastText:'', lastRole:'', lastAt: now, createdAt: now, updatedAt: now });
  await App.DB.bulkPut('messages', [
    { id:'v1', sessionId:'sess_v130', role:'assistant', content:'首选问候：今天也来啦？', variantIndex:0, isActive:true, status:'ok', createdAt: now - 3000 },
    { id:'v2', sessionId:'sess_v130', role:'user', content:'嗯，来看看书。', variantIndex:0, isActive:true, status:'ok', createdAt: now - 2000 },
    { id:'v3', sessionId:'sess_v130', role:'assistant', content:'*她低头笑了笑* 今天进了一批旧唱片，要不要看看？', variantIndex:0, isActive:true, status:'ok', createdAt: now - 1000 }
  ]);
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('last_tab', 'settings');
  return 'seeded';
})()
`;

const clickText = (sel, text) => `(() => {
  var list = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
  var el = list.filter(function(e){ return ((e.textContent||'').trim()).indexOf(${JSON.stringify(text)}) >= 0; })[0];
  if (!el) return 'miss';
  el.click();
  return 'ok';
})()`;

(async () => {
  page = await CdpPage.connect(CDP_PORT);
  await page.init();
  console.log('\n[E2E] v1.3.0 外观 / 性别 / 角色级上帝模式 / 图片库');
  await page.navigate('about:blank', 200);
  try { await page.clearStorage(ORIGIN); } catch (e) {}
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 2600);
  await page.eval(SEED);
  await page.navigate(APP_URL + '/index.html?seed=' + Date.now(), 3200);
  await waitFor(`!!(window.App && App.Style && App.Media && App.Saves)`, 12000);
  await page.eval(`window.__AICHAT_MOCK_IMAGE__ = ${JSON.stringify({ dataUri: PNG, name: '测试图.png' })}`);

  /* ---------- 1. 设置页「聊天界面」 ---------- */
  await page.eval(`App.Router.tab('settings')`);
  await waitFor(`document.body.textContent.indexOf('聊天界面样式') >= 0`, 8000);
  const rows = await evalJSON(`({
    style: !!document.querySelector('[data-guide-focus="chatStyle"]'),
    bg: !!document.querySelector('[data-guide-focus="chatBg"]'),
    avatar: !!document.querySelector('[data-guide-focus="userAvatar"]')
  })`);
  if (rows && rows.style && rows.bg && rows.avatar) ok('设置页出现「聊天界面」三行');
  else bad('设置页缺少聊天界面行', JSON.stringify(rows));

  /* 切换 iMessage */
  await page.eval(clickText('[data-guide-focus="chatStyle"]', '聊天界面样式'));
  await waitFor(`document.querySelectorAll('.sheet-item').length > 0`, 4000);
  const pickIm = await page.eval(clickText('.sheet-item', 'iMessage'));
  if (pickIm === 'ok') ok('样式面板选择 iMessage');
  else bad('点不到 iMessage 选项', String(pickIm));
  await sleep(600);
  const styleState = await evalJSON(`(async () => ({
    dataset: document.body.dataset.chatStyle || '',
    db: await App.DB.settings.get('chat_style', '')
  }))()`);
  if (styleState && styleState.dataset === 'imessage' && styleState.db === 'imessage') ok('iMessage 样式已生效并落库', JSON.stringify(styleState));
  else bad('iMessage 样式未生效', JSON.stringify(styleState));

  /* 背景 + 头像（mock 选图） */
  await page.eval(clickText('[data-guide-focus="chatBg"]', '聊天背景'));
  await waitFor(`document.querySelectorAll('.sheet-item').length > 0`, 4000);
  await page.eval(clickText('.sheet-item', '从相册选择'));
  const bgOn = await waitFor(`document.body.classList.contains('has-chat-bg')`, 6000);
  if (bgOn) ok('聊天背景已设置（body.has-chat-bg）');
  else bad('聊天背景没有生效');
  await sleep(500);
  var avaSheet = false;
  for (var avaTry = 0; avaTry < 3 && !avaSheet; avaTry++) {
    await page.eval(clickText('[data-guide-focus="userAvatar"]', '我的头像'));
    avaSheet = await waitFor(`document.querySelectorAll('.sheet-item').length > 0`, 2500);
    if (!avaSheet) await sleep(400);
  }
  if (avaSheet) {
    await page.eval(clickText('.sheet-item', '从相册选择'));
  } else {
    bad('头像设置面板没有打开');
  }
  const avatarOn = await waitFor(`document.body.classList.contains('has-user-avatar')`, 8000);
  if (avatarOn) ok('我的头像已设置（body.has-user-avatar）');
  else bad('我的头像没有生效');
  await page.screenshot(path.join(SHOTS, '100-settings-chatui.png'));

  /* ---------- 2. 聊天页外观 ---------- */
  await page.eval(`App.Router.push('chat', { sessionId: 'sess_v130' })`);
  await waitFor(`document.querySelectorAll('.msg-list .msg').length >= 3`, 8000);
  await sleep(700);
  const chatLook = await evalJSON(`(async () => {
    var me = document.querySelector('.msg.me .msg-bubble');
    var av = document.querySelector('.msg.me .msg-avatar');
    var pageEl = document.querySelector('.chat-page');
    var cs = me ? getComputedStyle(me) : null;
    return {
      bubbleBg: cs ? cs.backgroundColor : '',
      avatarImg: !!(av && av.querySelector('img')),
      avatarSrcOk: !!(av && av.querySelector('img') && (av.querySelector('img').src || '').indexOf('data:image') === 0),
      pageBg: pageEl ? getComputedStyle(pageEl).backgroundImage : ''
    };
  })()`);
  if (chatLook && chatLook.bubbleBg === 'rgb(11, 132, 254)') ok('iMessage 我的气泡为蓝色', chatLook.bubbleBg);
  else bad('iMessage 气泡颜色不对', chatLook && chatLook.bubbleBg);
  if (chatLook && chatLook.avatarImg && chatLook.avatarSrcOk) ok('我的头像渲染为图片');
  else bad('我的头像没有渲染成图片', JSON.stringify(chatLook));
  if (chatLook && chatLook.pageBg && chatLook.pageBg.indexOf('data:image') >= 0) ok('聊天页应用了自定义背景图');
  else bad('聊天页没有背景图', chatLook && chatLook.pageBg);
  await page.screenshot(path.join(SHOTS, '101-chat-imessage.png'));

  await page.eval(`(async () => { await App.Style.setStyle('wechat'); await new Promise(r => setTimeout(r, 600)); return true; })()`);
  const wechatLook = await evalJSON(`(() => {
    var me = document.querySelector('.msg.me .msg-avatar img');
    return { style: document.body.getAttribute('data-chat-style'), avatarImg: !!me, bg: getComputedStyle(document.querySelector('.chat-page')).backgroundImage.indexOf('data:image') >= 0 };
  })()`);
  if (wechatLook && wechatLook.style === 'wechat' && wechatLook.avatarImg && wechatLook.bg) ok('切回微信样式后背景与「我」的头像仍生效');
  else bad('微信样式下背景/头像异常', JSON.stringify(wechatLook));
  await page.screenshot(path.join(SHOTS, '102-chat-wechat-avatar.png'));

  /* ---------- 3. 角色性别 + 角色级上帝模式 ---------- */
  await page.eval(`App.Router.push('characterEdit', { id: 'char_v130' })`);
  await waitFor(`document.body.textContent.indexOf('角色图片库') >= 0`, 8000);
  await sleep(400);
  const before = await evalJSON(`App.DB.get('characters','char_v130').then(c => ({ gender: c.gender, godMode: !!c.godMode }))`);
  if (before && before.gender === 'female' && before.godMode === false) ok('初始性别/上帝模式正确', JSON.stringify(before));
  else bad('初始字段异常', JSON.stringify(before));
  await page.eval(`(() => {
    var nodes = Array.from(document.querySelectorAll('.cell, .form-row'));
    var row = nodes.filter(function (e) { return (e.textContent || '').indexOf('性别') >= 0; })[0];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await sleep(400);
  await page.screenshot(path.join(SHOTS, '103-character-gender-god.png'));

  // 性别行 → 选男
  const genderTap = await page.eval(clickText('.cell, .form-row, [data-guide-focus="gender"]', '性别'));
  await waitFor(`document.querySelectorAll('.sheet-item').length > 0 || !!document.querySelector('.modal')`, 4000);
  await page.eval(clickText('.sheet-item', '男'));
  await sleep(400);
  // 上帝模式开关
  const godTap = await page.eval(`(() => {
    var scope = '.page:not([style*="display: none"]) .cell';
    var row = Array.from(document.querySelectorAll(scope)).filter(function(e){ return (e.textContent||'').indexOf('上帝模式')>=0; })[0];
    if (!row) return 'no-row';
    row.click();
    return row.querySelector('.switch') && row.querySelector('.switch').classList.contains('on') ? 'ok-on' : 'ok';
  })()`);
  // 保存
  const saved = await page.eval(clickText('.btn, .page-action, .nav-action', '保存'));
  await sleep(900);
  const after = await evalJSON(`App.DB.get('characters','char_v130').then(c => ({ gender: c.gender, godMode: !!c.godMode }))`);
  if (saved && after && after.gender === 'male') ok('编辑页性别改为「男」并保存');
  else bad('性别保存失败', JSON.stringify({ saved, after, before }));
  if (after && after.godMode === true) ok('角色级上帝模式已开启并落库');
  else bad('角色级上帝模式未落库', JSON.stringify({ after }));

  // 系统提示词生效：角色开、全局关
  const promptCheck = await evalJSON(`(async () => {
    await App.DB.settings.set('god_mode', false);
    var c = await App.DB.get('characters','char_v130');
    var p = App.ChatKit.buildContext({ character: c, session: { messages: [] }, persona: null, preset: null, godMode: !!c.godMode });
    var sys = (p.messages || []).filter(function (m) { return m && m.role === 'system'; }).map(function (m) { return String(m.content || ''); }).join(' ');
    return { godMode: !!c.godMode, sysLen: sys.length, hasGodWord: sys.indexOf('上帝模式') >= 0 || sys.indexOf('虚拟') >= 0 };
  })()`);
  if (promptCheck && promptCheck.godMode && promptCheck.hasGodWord) ok('角色级上帝模式进入 system prompt');
  else bad('角色级上帝模式未进入 prompt', JSON.stringify(promptCheck));

  /* ---------- 4. 角色列表「图片库」独立入口 ---------- */
  await page.eval(`App.Router.tab('characters')`);
  await waitFor(`document.querySelectorAll('.list-item, .char-row, .cell').length > 0`, 8000);
  await sleep(500);
  // 打开行尾「⋯」菜单
  const moreTap = await page.eval(`(() => {
    var row = Array.from(document.querySelectorAll('.list-item, .char-row, .cell')).filter(function(e){ return (e.textContent||'').indexOf('林夏')>=0; })[0];
    if (!row) return 'no-row';
    var more = row.querySelector('.ck-more, .more-btn, .row-more');
    if (more) { more.click(); return 'ok'; }
    return 'no-more';
  })()`);
  if (moreTap === 'ok') ok('角色行「⋯」菜单可打开');
  else bad('找不到角色行菜单按钮', String(moreTap));
  await waitFor(`document.querySelectorAll('.sheet-item').length > 0`, 4000);
  const libTap = await page.eval(clickText('.sheet-item', '图片库'));
  const libOpen = await waitFor(`!!document.querySelector('.ck-img-modal, .modal') && document.body.textContent.indexOf('角色图片库') >= 0`, 6000);
  if (libTap === 'ok' && libOpen) ok('从角色列表打开图片库');
  else bad('图片库没有打开', JSON.stringify({ libTap, libOpen }));
  await page.screenshot(path.join(SHOTS, '102-image-library.png'));

  // 添加图片 → 自动关闭
  const addTap = await page.eval(`(() => {
    var b = Array.from(document.querySelectorAll('.modal button, .modal .btn')).filter(function(e){ return (e.textContent||'').indexOf('添加图片')>=0; })[0];
    if (!b) return 'miss';
    b.click();
    return 'ok';
  })()`);
  const closed = await waitFor(`!document.querySelector('.ck-img-modal')`, 6000).catch(() => false);
  const closedOk = await evalJSON(`(async () => {
    var n = await App.Media.list('char_v130').then(a => a.length);
    var modal = !!document.querySelector('.ck-img-modal');
    return { count: n, modalOpen: modal };
  })()`);
  if (addTap === 'ok' && closedOk && closedOk.count === 1 && !closedOk.modalOpen) ok('添加图片后自动关闭弹窗且库中有 1 张', JSON.stringify(closedOk));
  else bad('添加图片流程异常', JSON.stringify({ addTap, closedOk }));

  console.log('\n========== v1.3.0 E2E 结果 ==========');
  console.log('通过 ' + pass + ' / ' + (pass + fail));
  if (problems.length) { console.log('问题：'); problems.forEach(p => console.log(' - ' + p)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n[E2E] 崩溃：', e && e.stack || e); process.exit(2); });
