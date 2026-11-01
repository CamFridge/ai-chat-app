/* 本轮新功能 E2E（无头 Chrome）
   验证：
   - 角色编辑页「角色图片库」：打开弹窗、添加图片、预览、删除
   - 聊天页：发送图片附件、发送文件附件、附件落库
   - 角色发图：assistant 文本含 [[img:ID]] 时渲染为图片节点
   - 动作/神态：*斜体* 渲染为 <em class="md-action"> 且 font-style 为 italic
   - 上帝模式：设置开关持久化；开启/关闭时 system prompt 包含/不包含【上帝模式】段
   - 引导助手：发图后「加到角色图片库」写入 characterImages（source=guide）
   用法：node scripts/e2e-media.js 9222 http://127.0.0.1:8321 */
'use strict';
const fs = require('fs');
const path = require('path');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9222);
const APP_URL = process.argv[3] || 'http://127.0.0.1:8321';
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
const ORIGIN = new URL(APP_URL).origin;
// 用一张 360x240 的示例图（fixtures 内，dev-only，不打包进 APK）
const PNG = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-photo.png')).toString('base64');

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
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('last_tab', 'chatList');
  await App.DB.settings.set('theme', 'light');
  await App.DB.settings.set('god_mode', false);
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

const jsMockImage = (name) => `(() => { window.__AICHAT_MOCK_IMAGE__ = { dataUri: ${JSON.stringify(PNG)}, name: ${JSON.stringify(name)} }; return 'ok'; })()`;
const jsMockFile = (name, data) => `(() => { window.__AICHAT_MOCK_FILE__ = { name: ${JSON.stringify(name)}, data: ${JSON.stringify(data)} }; return 'ok'; })()`;

const jsCounts = `(async () => {
  const rows = await App.DB.all('characterImages');
  const msgs = await App.DB.byIndex('messages', 'sessionId', 'sess_1');
  const lastUser = msgs.filter(m => m.role === 'user').slice(-1)[0] || null;
  const helpMsgs = await App.DB.all('helpMessages');
  return {
    images: rows.map(r => ({ id: r.id, characterId: r.characterId, name: r.name, source: r.source, cap: r.caption || '' })),
    lastUserAttachments: lastUser ? (lastUser.attachments || []) : null,
    helpAttachments: helpMsgs.map(m => (m.attachments || []).length).filter(n => n > 0).length,
    godMode: await App.DB.settings.get('god_mode', false)
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

  console.log('[E2E] 角色图片库 / 附件消息 / 动作斜体 / 上帝模式');

  // ---------- 0. 重置 + 种子 ----------
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

  // ---------- 1. 角色图片库 ----------
  console.log('[1] 角色图片库');
  await page.eval(`(async () => { await App.Router.push('characterEdit', { id: 'char_1' }); await new Promise(r => setTimeout(r, 1100)); return App.Router.current().name; })()`);
  const onEdit = await page.eval(`(App.Router.current() || {}).name`);
  if (onEdit === 'characterEdit') ok('打开角色编辑页');
  else bad('角色编辑页未打开：' + onEdit);

  if ((await page.eval(jsClick('[data-guide-focus="characterImages"]'))) === 'ok') ok('点击「角色图片库」行');
  else bad('点不到「角色图片库」行');
  const modalOpen = await waitFor(page, `(() => { const m = document.querySelector('.modal'); return m && /角色图片库/.test(m.innerText || '') && Number(getComputedStyle(m).opacity) > 0.9; })()`, 4000);
  if (modalOpen) ok('图片库弹窗已打开（可见）');
  else bad('图片库弹窗未打开或不可见');
  const emptyShown = await page.eval(`(() => /还没有图片/.test((document.querySelector('.modal') || {}).innerText || ''))()`);
  if (emptyShown) ok('空态文案正确');
  else bad('空态文案缺失');

  await page.eval(jsMockImage('测试图.png'));
  if ((await page.eval(jsClick('[data-guide-tap="addCharacterImage"]'))) === 'ok') ok('点击「添加图片」');
  else bad('点不到「添加图片」');
  const added = await waitFor(page, `(async () => { const rows = await App.DB.all('characterImages'); return rows.length === 1; })()`, 5000);
  if (added) ok('图片已写入 characterImages');
  else bad('图片未写入');
  let counts = await page.eval(jsCounts);
  if (counts.images[0] && counts.images[0].source === 'user') ok('source 记为 user');
  else bad('source 异常：' + JSON.stringify(counts.images[0]));
  const cellShown = await waitFor(page, `(() => document.querySelectorAll('.ck-img-cell').length === 1)()`, 4000);
  if (cellShown) ok('图片格已渲染');
  else bad('图片格未渲染');
  await page.screenshot(path.join(SHOTS, '80-media-library.png'));

  if ((await page.eval(jsClick('.ck-img-cell'))) === 'ok') ok('点击缩略图');
  else bad('点不到缩略图');
  const previewed = await waitFor(page, `(() => !!document.querySelector('.media-preview-img'))()`, 4000);
  if (previewed) ok('大图预览已打开');
  else bad('大图预览未打开');
  await page.screenshot(path.join(SHOTS, '81-media-preview.png'));
  await page.eval(`(async () => { App.UI.closeTopOverlay(); await new Promise(r => setTimeout(r, 350)); App.UI.closeTopOverlay(); await new Promise(r => setTimeout(r, 350)); return true; })()`);

  // 删除
  if ((await page.eval(jsClick('[data-guide-focus="characterImages"]'))) === 'ok') await sleep(400);
  if ((await page.eval(jsClick('.ck-img-more'))) === 'ok') ok('打开图片「⋯」菜单');
  else bad('点不到「⋯」菜单');
  await sleep(450);
  const sheetVisible = await page.eval(`(() => { const s = document.querySelector('.sheet'); if (!s) return null; const cs = getComputedStyle(s); return { opacity: cs.opacity, transform: cs.transform, items: s.querySelectorAll('.sheet-item').length }; })()`);
  if (sheetVisible && Number(sheetVisible.opacity) > 0.9) ok('操作菜单（sheet）可见');
  else bad('操作菜单不可见：' + JSON.stringify(sheetVisible));
  if ((await page.eval(jsClick('.sheet button, .sheet .sheet-item', '删除'))) === 'ok') ok('点击「删除」');
  else bad('点不到「删除」');
  await sleep(500);
  const confirmVisible = await page.eval(`(() => { const m = document.querySelector('.modal'); return m ? Number(getComputedStyle(m).opacity) : 0; })()`);
  if (confirmVisible > 0.9) ok('删除确认弹窗可见');
  else bad('删除确认弹窗不可见（opacity=' + confirmVisible + '）');
  if ((await page.eval(jsClick('.modal button', '删除'))) === 'ok') ok('确认删除');
  else bad('点不到确认删除');
  const removed = await waitFor(page, `(async () => { const rows = await App.DB.all('characterImages'); return rows.length === 0; })()`, 5000);
  if (removed) ok('图片已删除');
  else bad('图片未删除');

  // 重新添加一张，供后续 AI 发图使用
  await page.eval(jsMockImage('海边照片.png'));
  await page.eval(jsClick('[data-guide-tap="addCharacterImage"]'));
  await waitFor(page, `(async () => { const rows = await App.DB.all('characterImages'); return rows.length === 1; })()`, 5000);
  counts = await page.eval(jsCounts);
  const imgId = counts.images[0] && counts.images[0].id;
  if (imgId) ok('已准备图片库素材 ' + imgId);
  else bad('图片库素材缺失');
  await page.eval(`(async () => { App.UI.closeTopOverlay(); await new Promise(r => setTimeout(r, 350)); return true; })()`);
  await page.eval(`(async () => { App.Router.pop(); await new Promise(r => setTimeout(r, 500)); return true; })()`);

  // ---------- 2. 聊天发送图片 / 文件 ----------
  console.log('[2] 聊天附件');
  await page.eval(`(async () => { await App.Router.push('chat', { sessionId: 'sess_1' }); await new Promise(r => setTimeout(r, 1000)); return true; })()`);
  if ((await page.eval(`(App.Router.current() || {}).name`)) === 'chat') ok('打开聊天页');
  else bad('聊天页未打开');

  await page.eval(jsMockImage('要发的照片.png'));
  if ((await page.eval(jsClick('.composer-attach'))) === 'ok') ok('点击附件按钮');
  else bad('点不到附件按钮');
  await sleep(400);
  if ((await page.eval(jsClick('.sheet button, .sheet .sheet-item', '相册图片'))) === 'ok') ok('附件菜单选择「相册图片」');
  else bad('附件菜单无「相册图片」');
  const chipShown = await waitFor(page, `(() => document.querySelectorAll('.composer-attach-chip').length === 1)()`, 5000);
  if (chipShown) ok('输入框上方出现附件 chip');
  else bad('附件 chip 未出现');
  await page.screenshot(path.join(SHOTS, '82-chat-attach-chip.png'));
  await page.eval(`(async () => { const btn = document.querySelector('.composer-send'); if (btn) btn.click(); await new Promise(r => setTimeout(r, 1200)); return true; })()`);
  const imgSent = await waitFor(page, `(() => document.querySelectorAll('.msg-attach-img').length >= 1)()`, 6000);
  if (imgSent) ok('图片消息已渲染（.msg-attach-img）');
  else bad('图片消息未渲染');
  await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '发送'; })()`, 15000);
  await sleep(500);
  counts = await page.eval(jsCounts);
  const attImg = (counts.lastUserAttachments || [])[0];
  if (attImg && attImg.kind === 'image') ok('最后一条 user 消息带图片附件并落库');
  else bad('图片附件未落库：' + JSON.stringify(counts.lastUserAttachments));

  await page.eval(jsMockFile('note.txt', '你好，附件内容'));
  if ((await page.eval(jsClick('.composer-attach'))) === 'ok') await sleep(350);
  if ((await page.eval(jsClick('.sheet button, .sheet .sheet-item', '文件'))) === 'ok') ok('附件菜单选择「文件」');
  else bad('附件菜单无「文件」');
  await waitFor(page, `(() => document.querySelectorAll('.composer-attach-chip').length === 1)()`, 5000);
  await page.eval(jsFill('.composer-input', '给你一份文件'));
  await sleep(150);
  await page.eval(`(async () => { const btn = document.querySelector('.composer-send'); if (btn) btn.click(); await new Promise(r => setTimeout(r, 1200)); return true; })()`);
  const fileSent = await waitFor(page, `(() => document.querySelectorAll('.msg-attach-file').length >= 1)()`, 6000);
  if (fileSent) ok('文件消息已渲染（.msg-attach-file）');
  else bad('文件消息未渲染');
  await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '发送'; })()`, 15000);
  await sleep(500);
  counts = await page.eval(jsCounts);
  const attFile = (counts.lastUserAttachments || [])[0];
  if (attFile && attFile.kind === 'file') ok('最后一条 user 消息带文件附件并落库');
  else bad('文件附件未落库：' + JSON.stringify(counts.lastUserAttachments));
  await page.screenshot(path.join(SHOTS, '83-chat-attachments.png'));

  // ---------- 3. 角色发图 + 动作斜体 ----------
  console.log('[3] 角色发图 / 动作斜体');
  const replyText = `*她低头笑了笑，把一张照片推到你面前*，说：「你看，这就是我说的海边。」\n\n[[img:${imgId}]]\n\n好看吧？`;
  await page.eval(`(() => {
    window.__LAST_REQ = null;
    App.API.chatStream = function (opts) {
      try { window.__LAST_REQ = { provider: opts.provider, model: opts.model, messages: (opts.messages || []).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '[多模态]' })) }; } catch (e) {}
      var text = ${JSON.stringify(replyText)};
      var i = 0; var timer = null;
      function step() {
        i = Math.min(text.length, i + 6);
        try { opts.onDelta(text.slice(Math.max(0, i - 6), i)); } catch (e) {}
        if (i >= text.length) {
          clearInterval(timer);
          try { opts.onDone && opts.onDone({ ok: true, text: text, usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }); } catch (e) {}
        }
      }
      timer = setInterval(step, 12);
      return { abort: function () { clearInterval(timer); try { opts.onError && opts.onError({ code: 'cancel' }); } catch (e) {} } };
    };
    return 'ok';
  })()`);
  await page.eval(jsFill('.composer-input', '发张你在海边的照片看看'));
  await sleep(150);
  await page.eval(jsClick('.composer-send'));
  const imageRendered = await waitFor(page, `(() => document.querySelectorAll('.msg-image-img').length >= 1)()`, 10000);
  if (imageRendered) ok('assistant [[img:ID]] 渲染为图片消息');
  else bad('assistant 图片消息未渲染');
  const italicRendered = await waitFor(page, `(() => document.querySelectorAll('.md-action').length >= 1)()`, 10000);
  if (italicRendered) ok('*动作* 渲染为 .md-action');
  else bad('斜体动作未渲染');
  const italicStyle = await page.eval(`(() => { const el = document.querySelector('.md-action'); if (!el) return null; const cs = getComputedStyle(el); return { fontStyle: cs.fontStyle, fontWeight: cs.fontWeight, text: (el.textContent || '').slice(0, 20) }; })()`);
  if (italicStyle && italicStyle.fontStyle === 'italic') ok('动作段落字体为 italic（' + italicStyle.text + '…）');
  else bad('动作段落不是斜体：' + JSON.stringify(italicStyle));
  const rawTokenLeak = await page.eval(`(() => { const t = (document.querySelector('.chat-msg-list') || {}).innerText || ''; return t.indexOf('[[img:') >= 0; })()`);
  if (!rawTokenLeak) ok('界面未泄漏 [[img:]] 原始标记');
  else bad('界面出现 [[img:]] 原始标记');
  const sysPrompt = await page.eval(`(() => { const req = window.__LAST_REQ; const sys = req && req.messages && req.messages[0] && req.messages[0].role === 'system' ? String(req.messages[0].content || '') : ''; return { hasImages: sys.indexOf('图片库') >= 0, hasImgRule: sys.indexOf('[[img:') >= 0, hasFormat: sys.indexOf('斜体') >= 0 || sys.indexOf('表达格式') >= 0, hasGod: sys.indexOf('上帝模式') >= 0 }; })()`);
  if (sysPrompt.hasImages && sysPrompt.hasImgRule) ok('system prompt 含图片库清单与 [[img:]] 规则');
  else bad('system prompt 缺图片库规则：' + JSON.stringify(sysPrompt));
  if (sysPrompt.hasFormat) ok('system prompt 含表达格式（动作斜体）约定');
  else bad('system prompt 缺表达格式约定');
  await page.screenshot(path.join(SHOTS, '84-chat-image-italic.png'));

  // ---------- 4. 上帝模式 ----------
  console.log('[4] 上帝模式');
  if (!sysPrompt.hasGod) ok('关闭时 system prompt 不含上帝模式');
  else bad('关闭时 system prompt 仍含上帝模式');

  await page.eval(`(async () => { await App.DB.settings.set('god_mode', true); await App.Router.pop(); await new Promise(r => setTimeout(r, 400)); await App.Router.push('chat', { sessionId: 'sess_1' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  await page.eval(`(() => { window.__LAST_REQ = null; return 'ok'; })()`);
  await page.eval(jsFill('.composer-input', '你知道自己是谁吗'));
  await sleep(120);
  await page.eval(jsClick('.composer-send'));
  await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '停止'; })()`, 4000);
  await waitFor(page, `(() => { const b = document.querySelector('.composer-send'); return b && (b.textContent || '').trim() === '发送'; })()`, 15000);
  await sleep(500);
  const godSys = await page.eval(`(() => { const req = window.__LAST_REQ; const sys = req && req.messages && req.messages[0] ? String(req.messages[0].content || '') : ''; return { hasGod: sys.indexOf('上帝模式') >= 0, virtual: /虚拟|AI|人工智能/.test(sys) }; })()`);
  if (godSys.hasGod) ok('开启后 system prompt 含上帝模式段');
  else bad('开启后 system prompt 未含上帝模式段');
  if (godSys.virtual) ok('上帝模式段说明角色是虚拟的');
  else bad('上帝模式段缺少虚拟说明');

  await page.eval(`(async () => { await App.DB.settings.set('god_mode', true); await App.Router.pop(); await new Promise(r => setTimeout(r, 300)); await App.Router.tab('settings'); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  const godSwitch = await page.eval(`(() => { const row = document.querySelector('[data-guide-focus="godMode"]'); if (!row) return null; const sw = row.querySelector('.cfg-switch, .switch, input[type="checkbox"]'); return { found: !!row, checked: sw ? (sw.checked !== undefined ? sw.checked : sw.classList.contains('on')) : null, text: (row.innerText || '').slice(0, 30) }; })()`);
  if (godSwitch && godSwitch.found) ok('设置页存在上帝模式开关');
  else bad('设置页缺少上帝模式开关');
  if (godSwitch && godSwitch.checked === true) ok('开关状态与 god_mode=true 一致');
  else bad('开关状态不一致：' + JSON.stringify(godSwitch));
  await page.screenshot(path.join(SHOTS, '85-god-mode-setting.png'));

  // ---------- 5. 引导助手发图 → 加入图片库 ----------
  console.log('[5] 引导助手加图');
  await page.eval(`(async () => { App.Help.open({ source: 'media_help' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  const helpOpen = await waitFor(page, `(() => !!document.querySelector('.help-composer'))()`, 5000);
  if (helpOpen) ok('引导助手抽屉已打开');
  else bad('引导助手抽屉未打开');
  await page.eval(jsMockImage('助手加的图.png'));
  if ((await page.eval(jsClick('.help-attach'))) === 'ok') ok('点击帮助抽屉附件按钮');
  else bad('点不到帮助抽屉附件按钮');
  const helpChip = await waitFor(page, `(() => document.querySelectorAll('.help-attach-chip').length === 1)()`, 5000);
  if (helpChip) ok('帮助抽屉显示附件 chip');
  else bad('帮助抽屉附件 chip 未出现');
  await page.eval(jsFill('.help-input', '帮我把这张图加到林夏的图片库'));
  await sleep(150);
  await page.eval(jsClick('.help-composer .composer-send'));
  const actionShown = await waitFor(page, `(() => !!document.querySelector('.help-img-action'))()`, 6000);
  if (actionShown) ok('出现「加到角色图片库」按钮');
  else bad('未出现「加到角色图片库」按钮');
  await page.screenshot(path.join(SHOTS, '86-help-image-add.png'));
  if ((await page.eval(jsClick('.help-img-action'))) === 'ok') ok('点击「加到角色图片库」');
  else bad('点不到「加到角色图片库」');
  await sleep(450);
  let sheetShown = await waitFor(page, `(() => !!document.querySelector('.sheet'))()`, 3000);
  if (sheetShown) {
    if ((await page.eval(jsClick('.sheet button, .sheet .sheet-item', '林夏'))) === 'ok') ok('选择角色「林夏」');
    else bad('角色选择列表无林夏');
  } else {
    bad('角色选择 sheet 未打开');
  }
  const guideAdded = await waitFor(page, `(async () => { const rows = await App.DB.all('characterImages'); return rows.filter(r => r.source === 'guide').length >= 1; })()`, 6000);
  if (guideAdded) ok('图片已通过引导助手写入图片库（source=guide）');
  else bad('引导助手加图未写入');
  counts = await page.eval(jsCounts);
  const guideImg = counts.images.filter(r => r.source === 'guide')[0];
  if (guideImg && guideImg.characterId === 'char_1') ok('归属角色正确（char_1）');
  else bad('归属角色异常：' + JSON.stringify(guideImg));
  if (counts.helpAttachments >= 1) ok('帮助消息附件已落库');
  else bad('帮助消息附件未落库');
  await page.screenshot(path.join(SHOTS, '87-help-added.png'));

  console.log('');
  if (problems.length) {
    console.log('结果：' + problems.length + ' 个问题');
    problems.forEach((p, i) => console.log('  ' + (i + 1) + ') ' + p));
    process.exit(1);
  }
  console.log('结果：全部通过');
  process.exit(0);
})().catch((e) => { console.error('E2E 崩溃：', (e && e.stack) || e); process.exit(2); });
