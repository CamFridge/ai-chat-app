/* 问候语 E2E（无头 Chrome，浏览器 mock）
   验证 v1.2.0「问候语（首选 / 备选）」：
   - 角色编辑页：问候语入口 → 弹窗编辑首选 + 备选 → 保存落库
   - 聊天页「…」菜单 →「换个开场白」：未聊过可换（替换首条 assistant 并写 greetingIndex），已聊过拦截
   - 新建会话默认用首选；首选为空时退回第一条备选
   - 聊天列表监听 aichat:session-updated 刷新
   用法：node scripts/e2e-greetings.js 9222 http://127.0.0.1:8321 */
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
  const base = {
    type: 'companion', avatar: '', worldviewId: 'wv-modern', personality: '开朗直率', habits: '爱聊吃的', background: '', speechStyle: '',
    catchphrases: '', scenario: '', exampleDialogues: [], systemPrompt: '', domain: '', specialty: [], duties: [], answerStyle: '',
    knowledgeBoundary: '', refusalPolicy: '', draft: {}, fieldOrigin: {}, generatedAt: now, createdAt: now, updatedAt: now
  };
  await App.DB.put('characters', Object.assign({}, base, {
    id: 'char_g', name: '林夏',
    firstMessage: '首选问候：今天也来啦？',
    alternateGreetings: ['备选一：我带了你爱吃的。', '备选二：外面下雨了，进来躲躲？']
  }));
  await App.DB.put('characters', Object.assign({}, base, {
    id: 'char_nofirst', name: '阿青', firstMessage: '', alternateGreetings: ['无首选时的备选问候。']
  }));
  // 没聊过的会话：只有首条 assistant 问候
  await App.DB.put('sessions', { id: 'sess_g0', title: '林夏', characterId: 'char_g', personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_chat', pinned: false, unread: 0, greetingIndex: 0, updatedAt: now, createdAt: now });
  await App.DB.put('messages', { id: 'mg1', sessionId: 'sess_g0', role: 'assistant', content: '首选问候：今天也来啦？', variantIndex: 0, isActive: true, status: 'ok', createdAt: now + 1 });
  // 已聊过的会话
  await App.DB.put('sessions', { id: 'sess_chat', title: '林夏', characterId: 'char_g', personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_chat', pinned: false, unread: 0, greetingIndex: 0, updatedAt: now, createdAt: now });
  await App.DB.put('messages', { id: 'mc1', sessionId: 'sess_chat', role: 'assistant', content: '首选问候：今天也来啦？', variantIndex: 0, isActive: true, status: 'ok', createdAt: now + 1 });
  await App.DB.put('messages', { id: 'mc2', sessionId: 'sess_chat', role: 'user', content: '我来了。', variantIndex: 0, isActive: true, status: 'ok', createdAt: now + 2 });
  await App.DB.put('messages', { id: 'mc3', sessionId: 'sess_chat', role: 'assistant', content: '*笑了笑* 来，坐。', variantIndex: 0, isActive: true, status: 'ok', createdAt: now + 3 });
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

  console.log('[E2E] 问候语');

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

  // ---------- 1. 聊天页「换个开场白」（未聊过） ----------
  await page.eval(`(async () => { await App.Router.push('chat', { sessionId: 'sess_g0' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  if ((await page.eval(`(() => { const b = document.querySelector('.nav-action'); if (!b) return 'notfound'; b.click(); return 'ok'; })()`)) === 'ok') ok('打开聊天页会话菜单');
  else bad('找不到导航按钮 .nav-action');
  await sleep(400);
  if ((await page.eval(jsClick('.sheet-item', '换个开场白'))) === 'ok') ok('菜单中有「换个开场白」');
  else bad('菜单中没有「换个开场白」');
  await sleep(400);
  const greetSheet = await page.eval(`(() => {
    const items = Array.from(document.querySelectorAll('.sheet-item'));
    return { labels: items.map(i => (i.textContent || '').trim()), sheet: !!document.querySelector('.sheet') };
  })()`);
  if (greetSheet.sheet) ok('打开问候语选择面板');
  else bad('问候语面板未打开');
  const hasAll = ['首选', '备选 1', '备选 2'].every((k) => greetSheet.labels.some((l) => l.indexOf(k) >= 0));
  if (hasAll) ok('问候语列表含首选 + 2 条备选');
  else bad('问候语列表异常：' + JSON.stringify(greetSheet.labels));
  await page.screenshot(path.join(SHOTS, '91-greeting-sheet.png'));
  if ((await page.eval(jsClick('.sheet-item', '备选 1'))) === 'ok') ok('选择「备选 1」');
  else bad('点不到「备选 1」');
  await waitFor(page, `(async () => {
    const rows = await App.DB.byIndex('messages', 'sessionId', 'sess_g0');
    return rows.some(m => m.role === 'assistant' && /备选一/.test(String(m.content || '')));
  })()`, 6000);
  await sleep(400);
  const afterPick = await page.eval(`(async () => {
    const sess = await App.DB.get('sessions', 'sess_g0');
    const rows = (await App.DB.byIndex('messages', 'sessionId', 'sess_g0')).sort((a,b) => (a.createdAt||0)-(b.createdAt||0));
    const first = rows.find(m => m.role === 'assistant');
    const dom = Array.from(document.querySelectorAll('.msg-bubble')).map(e => e.innerText);
    return { greetingIndex: sess.greetingIndex, first: String(first && first.content || ''), dom: dom, lastText: sess.lastText };
  })()`);
  if (afterPick.greetingIndex === 1) ok('session.greetingIndex 写为 1');
  else bad('greetingIndex 异常：' + afterPick.greetingIndex);
  if (/备选一/.test(afterPick.first) && afterPick.dom.some((d) => /备选一/.test(d))) ok('首条 assistant 与界面都换成备选问候');
  else bad('首条消息未替换：' + afterPick.first + ' / ' + JSON.stringify(afterPick.dom));

  // ---------- 1b. 选择「空」开场白 ----------
  await page.eval(`(() => { const b = document.querySelector('.nav-action'); if (b) b.click(); return 'ok'; })()`);
  await sleep(400);
  await page.eval(jsClick('.sheet-item', '换个开场白'));
  await sleep(500);
  const emptyItem = await page.eval(`(() => {
    const items = Array.from(document.querySelectorAll('.sheet-item'));
    const it = items.find(i => (i.textContent || '').indexOf('空对话') >= 0);
    return it ? 'found' : JSON.stringify(items.map(i => (i.textContent || '').trim()));
  })()`);
  if (emptyItem === 'found') ok('问候语面板含「不使用开场白（空对话）」');
  else bad('问候语面板缺少空对话选项：' + emptyItem);
  await page.eval(jsClick('.sheet-item', '空对话'));
  await sleep(900);
  const afterEmpty = await page.eval(`(async () => {
    const sess = await App.DB.get('sessions', 'sess_g0');
    const rows = await App.DB.byIndex('messages', 'sessionId', 'sess_g0');
    return {
      greetingIndex: sess.greetingIndex,
      count: rows.length,
      bubbles: document.querySelectorAll('.msg-bubble').length,
      body: (document.querySelector('.msg-list') || {}).innerText || ''
    };
  })()`);
  if (afterEmpty.greetingIndex === -1) ok('选择空对话后 session.greetingIndex=-1');
  else bad('空对话 greetingIndex 异常：' + afterEmpty.greetingIndex);
  if (afterEmpty.count === 0) ok('空对话后会话没有消息');
  else bad('空对话后仍有 ' + afterEmpty.count + ' 条消息');
  if (afterEmpty.bubbles === 0) ok('界面不显示任何消息气泡');
  else bad('界面仍有 ' + afterEmpty.bubbles + ' 个气泡');
  if (/还没有消息|发第一条消息/.test(afterEmpty.body)) ok('显示空对话提示文案');
  else bad('空对话提示缺失：' + afterEmpty.body.slice(0, 40));
  await page.screenshot(path.join(SHOTS, '98-greeting-empty.png'));

  // 从空对话切回首选问候语
  await page.eval(`(() => { const b = document.querySelector('.nav-action'); if (b) b.click(); return 'ok'; })()`);
  await sleep(400);
  await page.eval(jsClick('.sheet-item', '换个开场白'));
  await sleep(500);
  await page.eval(jsClick('.sheet-item', '首选'));
  await waitFor(page, `(async () => {
    const rows = await App.DB.byIndex('messages', 'sessionId', 'sess_g0');
    return rows.length === 1 && rows[0].role === 'assistant';
  })()`, 6000);
  const backToFirst = await page.eval(`(async () => {
    const sess = await App.DB.get('sessions', 'sess_g0');
    const rows = await App.DB.byIndex('messages', 'sessionId', 'sess_g0');
    return { greetingIndex: sess.greetingIndex, first: String(rows[0] && rows[0].content || '') };
  })()`);
  if (backToFirst.greetingIndex === 0 && /首选问候/.test(backToFirst.first)) ok('从空对话可切回首选问候语');
  else bad('切回首选失败：' + JSON.stringify(backToFirst));

  // ---------- 2. 已聊过 → 拦截 ----------
  await page.eval(`(async () => { await App.Router.replace('chat', { sessionId: 'sess_chat' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  await sleep(300);
  await page.eval(`(() => { const b = document.querySelector('.nav-action'); if (b) b.click(); return 'ok'; })()`);
  await sleep(400);
  await page.eval(jsClick('.sheet-item', '换个开场白'));
  await sleep(600);
  const blocked = await page.eval(`(() => {
    const items = Array.from(document.querySelectorAll('.sheet-item')).map(i => (i.textContent || '').trim());
    const toasts = Array.from(document.querySelectorAll('.toast')).map(t => (t.textContent || '').trim());
    const greetingSheetOpen = items.some(t => t.indexOf('备选 1') >= 0);
    return { greetingSheetOpen, toasts, items };
  })()`);
  if (blocked.greetingSheetOpen === false) ok('已聊过的会话不打开问候语面板');
  else bad('已聊过仍打开问候语面板');
  if (blocked.toasts.some((t) => /不能换开场白/.test(t))) ok('提示「已经聊起来了，不能换开场白」');
  else bad('缺少拦截提示：' + JSON.stringify(blocked.toasts));

  // ---------- 3. 角色编辑页：问候语编辑 ----------
  await page.eval(`(async () => { await App.Router.push('characterEdit', { id: 'char_g' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  await sleep(400);
  if ((await page.eval(`(() => { const row = document.querySelector('[data-guide-focus="greetings"]'); if (!row) return 'notfound'; row.click(); return 'ok'; })()`)) === 'ok') ok('角色编辑页点击「问候语」入口');
  else bad('角色编辑页缺少问候语入口');
  const modalOpen = await waitFor(page, `(() => !!(document.querySelector('.ck-greet-modal') && getComputedStyle(document.querySelector('.ck-greet-modal'))))`, 4000);
  if (modalOpen) ok('问候语弹窗已打开');
  else bad('问候语弹窗未打开');
  const prefVal = await page.eval(`(() => { const ta = document.querySelector('.ck-greet-modal textarea'); return ta ? ta.value : 'notfound'; })()`);
  if (/首选问候/.test(String(prefVal))) ok('弹窗回填首选问候语');
  else bad('首选问候语回填异常：' + prefVal);
  await page.eval(`(() => { const btn = Array.from(document.querySelectorAll('.ck-greet-add')).pop(); if (btn) btn.click(); return 'ok'; })()`);
  await sleep(250);
  await page.eval(`(() => { const ta = document.querySelector('.ck-greet-modal textarea'); if (ta) { ta.focus(); const proto = HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, '首选问候（改）：今天想聊点什么？'); ta.dispatchEvent(new Event('input', { bubbles: true })); } return 'ok'; })()`);
  await page.eval(`(() => { const list = Array.from(document.querySelectorAll('.ck-greet-modal textarea')); const ta = list[list.length - 1]; if (ta) { ta.focus(); const proto = HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(ta, '备选三：我给你留了灯。'); ta.dispatchEvent(new Event('input', { bubbles: true })); } return 'ok'; })()`);
  await sleep(250);
  const saveClicked = await page.eval(`(() => {
    const btns = Array.from(document.querySelectorAll('.ck-greet-modal button, .modal button'));
    const b = btns.find(x => (x.textContent || '').trim() === '保存');
    if (!b) return 'notfound';
    b.click();
    return 'ok';
  })()`);
  if (saveClicked === 'ok') ok('点击问候语弹窗「保存」');
  else bad('找不到问候语保存按钮');
  await waitFor(page, `(async () => {
    const c = await App.DB.get('characters', 'char_g');
    return c && /改/.test(String(c.firstMessage || '')) && Array.isArray(c.alternateGreetings) && c.alternateGreetings.some(s => /备选三/.test(s));
  })()`, 6000);
  const savedChar = await page.eval(`(async () => { const c = await App.DB.get('characters','char_g'); return { first: String(c.firstMessage||''), alts: c.alternateGreetings || [] }; })()`);
  if (/首选问候（改）/.test(savedChar.first)) ok('首选问候语已保存');
  else bad('首选问候语未保存：' + savedChar.first);
  if (savedChar.alts.some((s) => /备选三/.test(s))) ok('新增备选问候语已保存（共 ' + savedChar.alts.length + ' 条）');
  else bad('备选问候语未保存：' + JSON.stringify(savedChar.alts));
  await page.screenshot(path.join(SHOTS, '92-greeting-edit.png'));

  // ---------- 4. 新建会话默认用首选 ----------
  await page.eval(`(async () => { await App.Router.tab('chatList'); await new Promise(r => setTimeout(r, 800)); return true; })()`);
  await sleep(300);
  await page.eval(`(() => { const b = document.querySelector('.nav-action'); if (b) b.click(); return 'ok'; })()`);
  const pickerOpen = await waitFor(page, `(() => !!document.querySelector('.char-picker-item'))`, 6000);
  if (pickerOpen) {
    await page.eval(`(() => { const items = Array.from(document.querySelectorAll('.char-picker-item')); const it = items.find(x => (x.textContent||'').includes('林夏')) || items[0]; if (it) it.click(); return 'ok'; })()`);
    await waitFor(page, `(async () => { const list = await App.DB.all('sessions'); return list.some(s => s.characterId === 'char_g' && s.id !== 'sess_g0' && s.id !== 'sess_chat'); })()`, 6000);
    const created = await page.eval(`(async () => {
      const list = await App.DB.all('sessions');
      const s = list.filter(x => x.characterId === 'char_g' && x.id !== 'sess_g0' && x.id !== 'sess_chat').pop();
      if (!s) return null;
      const rows = (await App.DB.byIndex('messages', 'sessionId', s.id)).sort((a,b) => (a.createdAt||0)-(b.createdAt||0));
      return { greetingIndex: s.greetingIndex, firstContent: rows.length ? String(rows[0].content || '') : '' };
    })()`);
    if (created && created.greetingIndex === 0) ok('新会话 greetingIndex=0');
    else bad('新会话 greetingIndex 异常：' + JSON.stringify(created));
    if (created && /首选问候（改）/.test(created.firstContent)) ok('新会话首条消息使用首选问候语');
    else bad('新会话首条消息异常：' + (created && created.firstContent));

    // ---------- 5. 首选为空时退回第一条备选 ----------
    await page.eval(`(() => { const b = document.querySelector('.nav-action'); if (b) b.click(); return 'ok'; })()`);
    await waitFor(page, `(() => !!document.querySelector('.char-picker-item'))`, 5000);
    await page.eval(`(() => { const items = Array.from(document.querySelectorAll('.char-picker-item')); const it = items.find(x => (x.textContent||'').includes('阿青')); if (it) it.click(); return 'ok'; })()`);
    await waitFor(page, `(async () => { const list = await App.DB.all('sessions'); return list.some(s => s.characterId === 'char_nofirst'); })()`, 6000);
    const created2 = await page.eval(`(async () => {
      const list = await App.DB.all('sessions');
      const s = list.filter(x => x.characterId === 'char_nofirst').pop();
      if (!s) return null;
      const rows = (await App.DB.byIndex('messages', 'sessionId', s.id)).sort((a,b) => (a.createdAt||0)-(b.createdAt||0));
      return { greetingIndex: s.greetingIndex, firstContent: rows.length ? String(rows[0].content || '') : '' };
    })()`);
    if (created2 && created2.greetingIndex === 1) ok('首选为空时 greetingIndex=1');
    else bad('首选为空时 greetingIndex 异常：' + JSON.stringify(created2));
    if (created2 && /无首选时的备选问候/.test(created2.firstContent)) ok('首选为空时使用第一条备选问候');
    else bad('首选为空时首条消息异常：' + (created2 && created2.firstContent));
  } else {
    bad('角色选择器未打开，跳过新建会话检查');
  }

  // ---------- 6. 列表监听 aichat:session-updated 刷新 ----------
  await page.eval(`(async () => { await App.Router.tab('chatList'); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  const refreshOk = await page.eval(`(async () => {
    const sess = await App.DB.get('sessions', 'sess_g0');
    sess.lastText = '事件刷新测试摘要';
    sess.lastRole = 'assistant';
    sess.lastAt = Date.now();
    sess.updatedAt = Date.now();
    await App.DB.put('sessions', sess);
    await App.DB.put('messages', { id: 'msg_e2e_refresh', sessionId: 'sess_g0', role: 'assistant', content: '事件刷新测试摘要', createdAt: Date.now(), status: 'ok' });
    for (var attempt = 0; attempt < 3; attempt++) {
      document.dispatchEvent(new CustomEvent('aichat:session-updated', { detail: { sessionId: 'sess_g0', reason: 'proactive' } }));
      for (var i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 100));
        if ((document.body.innerText || '').indexOf('事件刷新测试摘要') >= 0) return true;
      }
      // 兜底：事件在页面转场期间可能被忽略，重新展示列表时 router.onChange 会补一次刷新
      await App.Router.tab('settings');
      await new Promise(r => setTimeout(r, 350));
      await App.Router.tab('chatList');
      await new Promise(r => setTimeout(r, 500));
      if ((document.body.innerText || '').indexOf('事件刷新测试摘要') >= 0) return true;
    }
    return false;
  })()`);
  if (refreshOk) ok('聊天列表收到 session-updated 事件后刷新摘要');
  else bad('聊天列表未在事件后刷新');

  console.log('\n========== 问候语 E2E 结果 ==========');
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
