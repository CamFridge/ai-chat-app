/* 聊天页「气泡重叠」探针：种入各种消息类型（长短文本、换行、图片、长图、文件、错误、流式中、群聊）
 * 后，逐条量测 .msg / .msg-bubble / .composer 的包围盒，检测矩形相交与裁剪，并截图。
 * 用法：node scripts/probe-overlap.js [cdpPort] [appUrl] [width] [height]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9222);
const APP = (process.argv[3] || 'http://127.0.0.1:8321').replace(/\/$/, '');
const W = Number(process.argv[4] || 390);
const H = Number(process.argv[5] || 844);
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
const ORIGIN = new URL(APP).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 宽高比 1:4 的「长图」
const PNG_TALL =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="1200"><rect width="300" height="1200" fill="#7aa7d8"/><text x="20" y="120" font-size="40" fill="#fff">long shot</text></svg>'
  ).toString('base64');

const SEED = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(window.App && App.DB && App.Router); i++) await wait(50);
  await App.DB.ready;
  const now = Date.now();
  await App.DB.put('providers', { id: 'prov_guide', name: '引导', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o-mini', role: 'guide', createdAt: now, updatedAt: now });
  await App.DB.put('providers', { id: 'prov_chat', name: '聊天', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', role: 'chat', createdAt: now, updatedAt: now });
  const base = { type: 'companion', avatar: '', worldviewId: 'wv-modern', personality: '开朗', habits: '爱聊', background: '', speechStyle: '', catchphrases: '', scenario: '', scenarios: [], firstMessage: '', exampleDialogues: [], systemPrompt: '', domain: '', specialty: [], duties: [], answerStyle: '', knowledgeBoundary: '', refusalPolicy: '', draft: {}, fieldOrigin: {}, generatedAt: now, createdAt: now, updatedAt: now };
  await App.DB.put('characters', Object.assign({}, base, { id: 'char_1', name: '林夏' }));
  await App.DB.put('characters', Object.assign({}, base, { id: 'char_2', name: '陆沉' }));
  await App.DB.put('sessions', { id: 'sess_o', title: '林夏', characterId: 'char_1', personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_chat', pinned: false, updatedAt: now, createdAt: now, scene: '', lastText: '', lastRole: 'user' });
  const msgs = [
    ['assistant', 'ok', '短句。'],
    ['user', 'ok', '长文本：' + '这是一段用来测试自动换行与气泡高度的内容。'.repeat(6)],
    ['assistant', 'ok', '多行文本\\n第二行\\n\\n第四行（空行）\\n第六行 ' + '尾巴'.repeat(20)],
    ['assistant', 'ok', '*她抬头看了你一眼，指尖停在杯沿。*\\n「今天怎么想到来这儿？」\\n\\n**重点** 与 [inline code] 混排，再补一段很长的文字看看会不会溢出：' + '等等'.repeat(30)],
    ['user', 'ok', '- 列表一\\n- 列表二\\n- 列表三'],
    ['assistant', 'ok', 'FENCE\\nconsole.log(\"hello\");\\nconsole.log(\"world\");\\nFENCE\\n代码块后面的正文。'],
    ['assistant', 'ok', '图片消息：', { attachments: [{ id: 'att1', kind: 'image', dataUri: '${PNG_1x1}', name: 'a.png', size: 1200 }] }],
    ['user', 'ok', '长图消息：', { attachments: [{ id: 'att2', kind: 'image', dataUri: '${PNG_TALL}', name: 'long.png', size: 4000 }] }],
    ['user', 'ok', '文件消息：', { attachments: [{ id: 'att3', kind: 'file', name: 'notes.md', size: 2345, text: '文件内容第一行\\n第二行' }] }],
    ['assistant', 'error', '', { errorText: '网络错误：连接超时，请检查网络后重试。' }],
    ['assistant', 'streaming', '正在流式输出的一段较长的内容，用来模拟生成中的气泡：' + '逐字追加的内容。'.repeat(8)],
    ['user', 'ok', '最后一条：收个尾。']
  ];
  let t = now - msgs.length * 60000;
  for (let i = 0; i < msgs.length; i++) {
    const [role, status, content, extra] = msgs[i];
    const m = Object.assign({
      id: 'm_' + i, sessionId: 'sess_o', role: role, content: content, variantIndex: 0, isActive: true,
      status: status, errorText: '', tokensIn: 0, tokensOut: 0, createdAt: t + i * 60000
    }, extra || {});
    await App.DB.put('messages', m);
  }
  // 群聊
  await App.DB.put('groups', { id: 'g_1', name: '夜话群', characterIds: ['char_1', 'char_2'], avatar: '', createdAt: now, updatedAt: now });
  await App.DB.put('sessions', { id: 'sess_g', title: '夜话群', characterId: '', characterIds: ['char_1', 'char_2'], groupId: 'g_1', kind: 'group', personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_chat', pinned: false, updatedAt: now, createdAt: now });
  for (let i = 0; i < 10; i++) {
    await App.DB.put('messages', { id: 'gm_' + i, sessionId: 'sess_g', characterId: 'char_' + (i % 2 ? 1 : 2), speakerName: (i % 2 ? '陆沉' : '林夏'), role: 'assistant', content: '群聊第 ' + i + ' 条：' + (i % 3 === 0 ? '*看了你一眼*\\n' : '') + '内容内容内容'.repeat(3 + i), variantIndex: 0, isActive: true, status: 'ok', errorText: '', tokensIn: 0, tokensOut: 0, createdAt: now + i * 1000 });
  }
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('last_tab', 'chatList');
  await App.DB.settings.set('theme', 'light');
  return { ok: true };
})()`;

const MEASURE = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  // 只测「当前可见」的聊天页：隐藏的旧页面 list 高为 0，会污染统计
  const lists = Array.from(document.querySelectorAll('.chat-msg-list'));
  const list = lists.filter((el) => el.getBoundingClientRect().height > 0).pop() || lists.pop();
  if (!list) return { err: 'no list' };
  const pageEl = list.closest('.chat-page') || document;
  // 等图片解码完成
  const imgs = Array.from(pageEl.querySelectorAll('img'));
  await Promise.all(imgs.map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; }))));
  await wait(250);
  const R = (el) => { const r = el.getBoundingClientRect(); return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), b: +r.bottom.toFixed(1), r: +r.right.toFixed(1) }; };
  const nodes = Array.from(list.querySelectorAll('.msg'));
  const boxes = nodes.map((n) => ({ id: (n.dataset && n.dataset.id) || '?', cls: n.className, rect: R(n) }));
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].rect, b = boxes[j].rect;
      const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (ox > 2 && oy > 2) overlaps.push({ a: boxes[i].id, b: boxes[j].id, ox: +ox.toFixed(1), oy: +oy.toFixed(1), at: [Math.round(a.t), Math.round(b.t)] });
    }
  }
  // 气泡与自身行高：文字是否溢出气泡盒（视觉上会盖到相邻消息）
  const overflowBubbles = [];
  list.querySelectorAll('.msg-bubble').forEach((b) => {
    const outer = b.getBoundingClientRect();
    const inner = b.scrollHeight;
    if (inner > Math.ceil(outer.height) + 3) {
      const msg = b.closest('.msg');
      overflowBubbles.push({ id: msg ? msg.dataset.id : '?', ch: Math.round(outer.height), sh: inner });
    }
  });
  // 负数高度 / 高度为 0 的消息（塌陷会导致后续元素上移重叠）
  const collapsed = boxes.filter((x) => x.rect.h < 8).map((x) => ({ id: x.id, h: x.rect.h, cls: x.cls }));
  // 与输入栏、顶栏相交
  const composer = pageEl.querySelector('.composer') || document.querySelector('.composer');
  const topbar = pageEl.querySelector('.chat-topbar') || document.querySelector('.chat-topbar');
  const crossUI = [];
  if (composer) {
    const c = composer.getBoundingClientRect();
    boxes.forEach((x) => {
      const oy = Math.min(c.bottom, x.rect.b) - Math.max(c.top, x.rect.t);
      const ox = Math.min(c.right, x.rect.r) - Math.max(c.left, x.rect.l);
      if (oy > 2 && ox > 2) crossUI.push({ id: x.id, with: 'composer', oy: +oy.toFixed(1) });
    });
  }
  if (topbar) {
    const c = topbar.getBoundingClientRect();
    boxes.forEach((x) => {
      const oy = Math.min(c.bottom, x.rect.b) - Math.max(c.top, x.rect.t);
      const ox = Math.min(c.right, x.rect.r) - Math.max(c.left, x.rect.l);
      if (oy > 2 && ox > 2) crossUI.push({ id: x.id, with: 'topbar', oy: +oy.toFixed(1) });
    });
  }
  // 日期分隔条是否压住消息
  const days = Array.from(list.querySelectorAll('.chat-day')).map((d) => ({ rect: R(d), text: (d.textContent || '').slice(0, 12) }));
  const dayOverlaps = [];
  days.forEach((d) => boxes.forEach((x) => {
    const oy = Math.min(d.rect.b, x.rect.b) - Math.max(d.rect.t, x.rect.t);
    const ox = Math.min(d.rect.r, x.rect.r) - Math.max(d.rect.l, x.rect.l);
    if (oy > 2 && ox > 2) dayOverlaps.push({ day: d.text, id: x.id, oy: +oy.toFixed(1) });
  }));
  const last = boxes[boxes.length - 1];
  const gaps = [];
  for (let i = 1; i < boxes.length; i++) gaps.push(+(boxes[i].rect.t - boxes[i - 1].rect.b).toFixed(1));
  const shell = document.querySelector('.shell');
  const shellRect = shell ? R(shell) : null;
  const compRect = composer ? R(composer) : null;
  return {
    count: boxes.length,
    listH: { sh: list.scrollHeight, ch: list.clientHeight, top: Math.round(list.scrollTop) },
    shell: shellRect,
    composer: compRect,
    kbVar: getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim(),
    innerH: window.innerHeight,
    overlaps: overlaps.slice(0, 8),
    overflowBubbles: overflowBubbles.slice(0, 8),
    collapsed: collapsed.slice(0, 8),
    crossUI: crossUI.slice(0, 8),
    dayOverlaps: dayOverlaps.slice(0, 6),
    lastMsg: last ? { id: last.id, h: last.rect.h, bottom: last.rect.b, listBottom: Math.round(list.getBoundingClientRect().bottom) } : null,
    gaps: gaps.slice(0, 14),
    flexShrink: nodes[0] ? getComputedStyle(nodes[0]).flexShrink : '-',
    noFlexGap: String(document.documentElement.className).indexOf('no-flex-gap') >= 0,
    heights: boxes.map((b) => b.id + ':' + Math.round(b.rect.h))
  };
})()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const page = await CdpPage.connect(PORT);
  const collect = await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 2,
    mobile: true,
    screenWidth: W,
    screenHeight: H
  });
  await page.navigate('about:blank', 300);
  await page.clearStorage(ORIGIN);
  await page.navigate(APP + '/index.html?probe=' + Date.now(), 1200);
  await sleep(600);
  console.log('seed:', JSON.stringify(await page.eval(SEED).catch((e) => ({ err: String(e) }))));
  await page.navigate(APP + '/index.html?probe=' + Date.now() + 'b', 1500);
  await sleep(500);

  async function run(name, code) {
    const before = collect.exceptions.length;
    const r = await page.eval(code).catch((e) => 'err:' + e.message);
    await sleep(700);
    const m = await page.eval(MEASURE).catch((e) => ({ err: String(e) }));
    try {
      await page.screenshot(path.join(SHOTS, `overlap-${name}.png`), { width: W, height: H });
    } catch (e) {}
    const errs = collect.exceptions.slice(before).map((e) => (e.text || '').split('\n')[0].slice(0, 140));
    console.log(`\n### ${name}  ${typeof r === 'string' && r !== 'ok' ? r : ''}`);
    if (m.err) {
      console.log('  ✗ ' + m.err);
      return;
    }
    console.log(`  msgs=${m.count}  list sh=${m.listH.sh}/ch=${m.listH.ch} top=${m.listH.top}  innerH=${m.innerH} kb=${m.kbVar || '0'}`);
    console.log('  shell=' + JSON.stringify(m.shell) + '  composer=' + JSON.stringify(m.composer));
    console.log(`  heights: ${m.heights.join(' ')}`);
    console.log(`  gaps: ${JSON.stringify(m.gaps)}  flexShrink=${m.flexShrink} noFlexGap=${m.noFlexGap}`);
    console.log('  ⚠ 消息矩形相交: ' + (m.overlaps.length ? JSON.stringify(m.overlaps) : '无'));
    console.log('  ⚠ 气泡内文字超出气泡盒: ' + (m.overflowBubbles.length ? JSON.stringify(m.overflowBubbles) : '无'));
    console.log('  ⚠ 高度塌陷(<8px): ' + (m.collapsed.length ? JSON.stringify(m.collapsed) : '无'));
    console.log('  ⚠ 消息压住顶栏/输入栏: ' + (m.crossUI.length ? JSON.stringify(m.crossUI) : '无'));
    console.log('  ⚠ 日期条压住消息: ' + (m.dayOverlaps.length ? JSON.stringify(m.dayOverlaps) : '无'));
    console.log('  last=' + JSON.stringify(m.lastMsg));
    if (errs.length) console.log('  ✗ JS 异常: ' + JSON.stringify(errs));
  }

  await run(
    '单聊-初始',
    `(async () => { try { App.Router.tab('chatList'); } catch (e) {} await new Promise(r => setTimeout(r, 400)); App.Router.push('chat', { sessionId: 'sess_o' }); await new Promise(r => setTimeout(r, 700)); return 'ok'; })()`
  );
  await run(
    '单聊-滚动中段',
    `(async () => { const l = document.querySelector('.chat-msg-list'); l.scrollTop = Math.floor((l.scrollHeight - l.clientHeight) / 2); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  await run(
    '单聊-回到底部',
    `(async () => { const l = document.querySelector('.chat-msg-list'); l.scrollTop = l.scrollHeight; await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  // 模拟 Android 9 / Chrome 70 WebView：flex 列里消息默认可压缩、且自动最小尺寸失效。
  // 行高被压到比内容还矮，文字溢出到相邻消息上 —— 用户截图里的「气泡重叠」。
  await run(
    '单聊-模拟老内核压缩',
    `(async () => { const s = document.createElement('style'); s.id = 'sim-shrink'; s.textContent = '.msg-list > * { flex: 1 1 auto !important; min-height: 0 !important; }'; document.head.appendChild(s); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  await run(
    '单聊-撤销压缩模拟',
    `(async () => { const s = document.getElementById('sim-shrink'); if (s) s.parentNode.removeChild(s); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  // 只让「自动最小尺寸」失效（老内核的 bug），flex-shrink:0 仍由 App 的 CSS 生效：
  // 这才是修复后的真实工况——行高必须保持原样，不被压扁。
  await run(
    '单聊-老内核仅最小尺寸失效',
    `(async () => { const s = document.createElement('style'); s.id = 'sim-minsize'; s.textContent = '.msg-list > * { min-height: 0 !important; }'; document.head.appendChild(s); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  await run(
    '单聊-撤销最小尺寸模拟',
    `(async () => { const s = document.getElementById('sim-minsize'); if (s) s.parentNode.removeChild(s); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  // 模拟不支持 flex gap 的老内核：gap 归零 + html 加 no-flex-gap，看外边距兜底能否补回间距
  await run(
    '单聊-模拟无gap兜底',
    `(async () => { const s = document.createElement('style'); s.id = 'sim-nogap'; s.textContent = '.msg-list { gap: 0 !important; } .msg { gap: 0 !important; }'; document.head.appendChild(s); document.documentElement.classList.add('no-flex-gap'); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  await run(
    '单聊-撤销gap模拟',
    `(async () => { const s = document.getElementById('sim-nogap'); if (s) s.parentNode.removeChild(s); document.documentElement.classList.remove('no-flex-gap'); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  await run(
    '群聊-初始',
    `(async () => { App.Router.push('chat', { sessionId: 'sess_g' }); await new Promise(r => setTimeout(r, 800)); return 'ok'; })()`
  );
  await run(
    '群聊-滚动中段',
    `(async () => { const l = document.querySelector('.chat-msg-list'); l.scrollTop = Math.floor((l.scrollHeight - l.clientHeight) / 2); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  // 键盘弹起：视口压到 500 高（模拟 adjustResize），看输入框是否与消息压住
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: 500, deviceScaleFactor: 2, mobile: true, screenWidth: W, screenHeight: H
  });
  await sleep(400);
  await run(
    '单聊-键盘弹起(视口500)',
    `(async () => { await new Promise(r => setTimeout(r, 300)); return 'ok'; })()`
  );
  // 模拟「键盘只盖不 resize」的 WebView：直接把 --kb-inset 写成 260px
  await run(
    '单聊-kb-inset 260',
    `(async () => { document.documentElement.style.setProperty('--kb-inset','260px'); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  await run(
    '单聊-kb-inset 复位',
    `(async () => { document.documentElement.style.setProperty('--kb-inset','0px'); await new Promise(r => setTimeout(r, 400)); return 'ok'; })()`
  );
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 2, mobile: true, screenWidth: W, screenHeight: H
  });
  process.exit(0);
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
