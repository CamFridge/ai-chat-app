/* v1.4.0 布局/滚动探针 v2：各页面骨架尺寸、滚动能力（先回顶再测）、页面重叠、横向溢出、JS 异常
 * 用法：node scripts/probe-layout.js [cdpPort] [appUrl] [width] [height]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9222);
const APP = (process.argv[3] || 'http://127.0.0.1:8321').replace(/\/$/, '');
const W = Number(process.argv[4] || 390)
const H = Number(process.argv[5] || 844);
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
const ORIGIN = new URL(APP).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(window.App && App.DB && App.Router); i++) await wait(50);
  await App.DB.ready;
  const now = Date.now();
  await App.DB.put('providers', { id: 'prov_guide', name: '示例引导 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o-mini', role: 'guide', createdAt: now, updatedAt: now });
  await App.DB.put('providers', { id: 'prov_chat', name: '示例聊天 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', role: 'chat', createdAt: now + 1, updatedAt: now + 1 });
  const base = { type: 'companion', avatar: '', worldviewId: 'wv-modern', personality: '开朗直率', habits: '爱聊吃的',
    background: '在一家咖啡馆打工。这个背景很长，用来测试换行与滚动。'.repeat(3), speechStyle: '', catchphrases: '',
    scenario: '咖啡馆', scenarios: ['咖啡馆', '雨天街道', '深夜便利店'], firstMessage: '外面雨好大，先进来躲一下吧。',
    exampleDialogues: [], systemPrompt: '', domain: '', specialty: [], duties: [], answerStyle: '',
    knowledgeBoundary: '', refusalPolicy: '', draft: {}, fieldOrigin: {}, generatedAt: now, createdAt: now, updatedAt: now };
  for (let i = 0; i < 26; i++) {
    await App.DB.put('characters', Object.assign({}, base, { id: 'char_' + i, name: '角色' + i }));
  }
  for (let s = 0; s < 26; s++) {
    await App.DB.put('sessions', { id: 'sess_' + s, title: '会话' + s, characterId: 'char_' + s, personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_chat', pinned: false, updatedAt: now - s * 1000, createdAt: now - s * 1000, scene: '咖啡馆', lastText: '最后一条消息内容', lastRole: 'user' });
    for (let i = 0; i < 12; i++) {
      await App.DB.put('messages', { id: 'm' + s + '_' + i, sessionId: 'sess_' + s, role: i % 2 ? 'user' : 'assistant', content: '消息 ' + i + '：' + '内容 '.repeat(20), variantIndex: 0, isActive: true, status: 'ok', errorText: '', tokensIn: 0, tokensOut: 0, createdAt: now + i });
    }
  }
  await App.DB.put('lorebooks', { id: 'lb_1', name: '测试世界书', characterId: 'char_1', worldviewId: '', enabled: true, tokenBudget: 300, createdAt: now, updatedAt: now });
  for (let i = 0; i < 12; i++) {
    await App.DB.put('loreEntries', { id: 'le_' + i, lorebookId: 'lb_1', keys: ['咖啡馆' + i], secondaryKeys: [], content: '条目内容 ' + i + '：'.repeat(1) + '这是一段比较长的世界书条目文本，用来测试编辑器滚动。'.repeat(3), name: '条目' + i, priority: i, enabled: true, caseSensitive: false, alwaysOn: false, createdAt: now + i, updatedAt: now + i });
  }
  await App.DB.put('groups', { id: 'g_1', name: '测试群', characterIds: ['char_1', 'char_2'], avatar: '', createdAt: now, updatedAt: now });
  await App.DB.put('sessions', { id: 'sess_g', title: '测试群', characterId: '', characterIds: ['char_1', 'char_2'], groupId: 'g_1', kind: 'group', personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_chat', pinned: false, updatedAt: now, createdAt: now });
  for (let i = 0; i < 8; i++) {
    await App.DB.put('messages', { id: 'g' + i, sessionId: 'sess_g', characterId: 'char_' + (i % 2 ? 1 : 2), speakerName: '角色' + (i % 2 ? 1 : 2), role: i % 2 ? 'user' : 'assistant', content: '群聊消息 ' + i, variantIndex: 0, isActive: true, status: 'ok', errorText: '', tokensIn: 0, tokensOut: 0, createdAt: now + i });
  }
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('last_tab', 'chatList');
  await App.DB.settings.set('theme', 'light');
  return { ok: true };
})()`;

const PROBE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const shell = document.querySelector('.shell');
  const body = document.querySelector('.page-body');
  const pages = Array.from(document.querySelectorAll('.page')).filter((p) => getComputedStyle(p).display !== 'none');
  // 找“内容超出但滚不动”的可疑块
  const suspects = [];
  document.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    if (el.scrollHeight > el.clientHeight + 8) {
      const oy = cs.overflowY;
      if (oy !== 'auto' && oy !== 'scroll') {
        const r = el.getBoundingClientRect();
        if (r.height > 40 && el.children.length) suspects.push({ sel: (el.className || el.tagName).toString().slice(0, 30), oy, sh: el.scrollHeight, ch: el.clientHeight });
      }
    }
  });
  // 可滚动块：先回顶再测
  const scrolls = [];
  document.querySelectorAll('*').forEach((el) => {
    const cs = getComputedStyle(el);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
      const keep = el.scrollTop; el.scrollTop = 0; const t0 = el.scrollTop; el.scrollTop = 60;
      const moved = el.scrollTop > t0; el.scrollTop = keep;
      scrolls.push({ sel: (el.className || el.tagName).toString().slice(0, 28), sh: el.scrollHeight, ch: el.clientHeight, can: moved });
    }
  });
  const overflowX = [];
  document.querySelectorAll('.page *').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > vw + 2 || r.left < -2)) overflowX.push({ sel: (el.className || el.tagName).toString().slice(0, 30), l: Math.round(r.left), r: Math.round(r.right) });
  });
  // 重叠：可见页面的 rect 是否有两个以上同时占满
  const overlap = pages.length > 1 ? pages.map((p) => { const r = p.getBoundingClientRect(); return { cls: (p.className || '').toString().slice(0, 24), top: Math.round(r.top), h: Math.round(r.height) }; }) : [];
  return {
    vw, vh,
    bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
    visiblePages: pages.length, overlap,
    scrolls: scrolls.slice(0, 6), suspects: suspects.slice(0, 5), overflowX: overflowX.slice(0, 5),
    route: window.App && App.Router && App.Router.current ? (App.Router.current() || {}).name : '?'
  };
})()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const page = await CdpPage.connect(PORT);
  const collect = await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true, screenWidth: W, screenHeight: H });
  await page.navigate('about:blank', 300);
  await page.clearStorage(ORIGIN);
  await page.navigate(APP + '/index.html?probe=' + Date.now(), 1200);
  await sleep(700);
  console.log('seed:', JSON.stringify(await page.eval(SEED).catch((e) => ({ err: String(e) }))));
  await page.navigate(APP + '/index.html?probe=' + Date.now() + 'b', 1500);
  await sleep(500);
  const tag = `${W}x${H}`;

  const routes = [
    ['聊天列表', `App.Router.tab('chatList')`, null],
    ['角色列表', `App.Router.tab('characters')`, null],
    ['API 列表', `App.Router.tab('apiList')`, null],
    ['设置', `App.Router.tab('settings')`, null],
    ['单聊', `App.Router.push('chat', { sessionId: 'sess_0' })`, null],
    ['群聊', `App.Router.push('chat', { sessionId: 'sess_g' })`, null],
    ['世界书列表', `App.Router.push('lorebook', { characterId: 'char_1' })`, null],
    ['世界书编辑', `App.Router.push('lorebookEdit', { lorebookId: 'lb_1' })`, null],
    ['群管理', `App.Router.push('groupManage', { sessionId: 'sess_g' })`, null],
    ['我的身份', `App.Router.push('personas', {})`, null],
    ['身份编辑', `App.Router.push('personaEdit', {})`, null],
    ['角色创建', `App.Router.push('characterCreate', {})`, null],
    ['角色编辑', `App.Router.push('characterEdit', { characterId: 'char_1' })`, null],
    ['世界观', `App.Router.push('worldviews', {})`, null],
    ['预设编辑', `App.Router.push('presetEdit', { presetId: 'preset-companion' })`, null]
  ];

  for (const [name, run] of routes) {
    const before = collect.exceptions.length;
    try {
      const r = await page.eval(`(async () => { try { ${run}; } catch (e) { return 'err:' + e.message; } await new Promise(res => setTimeout(res, 500)); return 'ok'; })()`);
      await sleep(400);
      const m = await page.eval(PROBE);
      try { await page.screenshot(path.join(SHOTS, `probe-${tag}-${name}.png`), { width: W, height: H }); } catch (e) {}
      const errs = collect.exceptions.slice(before).map((e) => (e.text || '').split('\n')[0].slice(0, 140));
      console.log(`\n### ${name}  route=${m.route}  ${r === 'ok' ? '' : r}`);
      console.log(`  viewport ${m.vw}x${m.vh} body=${m.bodyH} visiblePages=${m.visiblePages}`);
      console.log('  scrollable: ' + (m.scrolls.length ? m.scrolls.map((s) => `${s.sel} sh=${s.sh}/ch=${s.ch} can=${s.can}`).join(' ; ') : '（没有内容需要滚动）'));
      if (m.suspects.length) console.log('  ⚠ 内容超出但滚不动: ' + JSON.stringify(m.suspects));
      if (m.overlap.length) console.log('  ⚠ 多页面同时可见: ' + JSON.stringify(m.overlap));
      if (m.overflowX.length) console.log('  ⚠ 横向溢出: ' + JSON.stringify(m.overflowX));
      if (errs.length) console.log('  ✗ JS 异常: ' + JSON.stringify(errs));
    } catch (e) {
      console.log(`\n### ${name}  ✗ ${e.message}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
