/* 需求验收补充 E2E（无头 Chrome，浏览器 mock 模式）
   覆盖 §十一 中此前未被自动化覆盖的条目：
   - #5  AI 补全成功路径：≥6 个 AI 字段、预览标注、保存前不写库
   - #6  助手 system prompt 专业性（法律/刑事辩护），不含「扮演」话术
   - #7  内置世界观恰好 7 套
   - #10 草稿持久化：预览未保存，刷新页面后草稿恢复
   - #11 「让 AI 改」产生第 2 版，可切回第 1 版回滚
   - #12 改稿固定用引导 API（即便补全 API 是另一个）
   - #21 1000 条消息会话：首屏只渲染最近 ~40 条，打开耗时可控
   用法：node scripts/e2e-acceptance.js 9222 http://127.0.0.1:8321 */
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
  await App.DB.put('providers', { id: 'prov_chat', name: '我的聊天 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', role: 'chat', createdAt: now, updatedAt: now });
  await App.Bridge.call('secure.set', { key: 'key:prov_guide', value: 'sk-demo-guide-123456' });
  await App.Bridge.call('secure.set', { key: 'key:prov_chat', value: 'sk-demo-chat-123456' });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('character_gen_provider_id', 'prov_guide');
  await App.DB.settings.set('character_gen_model', 'gpt-4o-mini');
  await App.DB.settings.set('last_tab', 'characters');
  await App.DB.settings.set('theme', 'light');
  return { ok: true };
})()`;

function jsClick(sel, text) {
  return `(() => {
    const list = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
    const t = ${text ? `list.find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}))` : 'list[0]'};
    if (!t) return 'notfound';
    t.scrollIntoView({ block: 'center' });
    t.click();
    return 'ok';
  })()`;
}

function jsFill(sel, value) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'notfound';
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok:' + el.value;
  })()`;
}

async function waitFor(page, expr, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await page.eval(expr)) return true; } catch (e) {}
    await sleep(intervalMs);
  }
  return false;
}

// 合法角色卡 JSON（陪聊）
const CARD1 = {
  name: '沈墨',
  personality: '外冷内热，话少但会默默照顾人',
  habits: '睡前一定要喝一杯热牛奶',
  background: '在旧城区经营一家开了三十年的二手书店，下雨天客人很少，他就在柜台后面修书。',
  speechStyle: '短句，语气平淡，偶尔冒出一句冷幽默。',
  catchphrases: '嗯。', 
  scenario: '雨天的旧书店，你推门进来避雨。',
  firstMessage: '雨这么大，进来躲一下吧。要喝点热的吗？',
  exampleDialogues: [{ user: '你平时看什么书？', char: '什么都看一点，最近在修一本掉了封面的诗集。' }],
  avatarHint: '深灰毛衣，指尖有旧书页的毛边',
  worldviewFit: '现代都市，旧城区书店'
};

const CARD2 = Object.assign({}, CARD1, {
  firstMessage: '……雨停了再走。先坐。',
  personality: '极度克制，几乎不主动表达情绪（第二版）'
});

const REVIEW = `(() => {
  const preview = document.querySelector('.ck-preview-name');
  return {
    step5: !!preview,
    name: (preview || {}).textContent || '',
    aiTags: document.querySelectorAll('.ck-ai-tag').length,
    userTags: document.querySelectorAll('.ck-user-tag').length,
    versions: document.querySelectorAll('.ck-version-chip').length,
    chips: Array.from(document.querySelectorAll('.ck-version-chip')).map(c => c.textContent.trim()),
    body: ((document.querySelector('.ck-wizard-body') || {}).innerText || ''),
    foot: ((document.querySelector('.ck-wizard-foot') || {}).innerText || '')
  };
})()`;

(async () => {
  const page = await CdpPage.connect(PORT);
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });

  console.log('[验收 E2E] AI 补全 / 草稿 / 改稿回滚 / 助手 prompt / 大列表');

  // ---------- 0. 全新状态 + 种子 ----------
  await page.navigate('about:blank', 300);
  await page.clearStorage(ORIGIN);
  await page.navigate(APP_URL + '/index.html', 900);
  await waitFor(page, `(() => !!(window.App && App.DB && App.Router && App.Router.current()))()`, 8000);
  await page.eval(`(async () => { try { await App.DB.clearAll(); } catch (e) {} try { localStorage.clear(); } catch (e) {} return true; })()`);
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 900);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);
  await sleep(400);
  const seeded = await page.eval(SEED);
  if (!seeded || !seeded.ok) bad('种子数据写入失败');
  await page.navigate(APP_URL + '/index.html?seed=' + Date.now(), 1800);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);

  // ---------- 1. 静态数据断言（#7 / #6 / 错误映射） ----------
  const statics = await page.eval(`(() => {
    const out = {};
    const wvs = (App.Data && App.Data.WORLDVIEW_PRESETS) || [];
    out.wvCount = wvs.length;
    out.wvNames = wvs.map(w => w.name);
    out.askill = !!(App.Bubble && App.Help);

    const card = {
      type: 'assistant', name: '法务顾问', domain: '法律',
      specialty: ['刑事辩护', '合同纠纷'], duties: ['分析案情', '提示举证要点'],
      answerStyle: '先给结论，再给依据，标注不确定的部分。',
      knowledgeBoundary: '只做一般性法律信息说明，不代替律师。',
      refusalPolicy: '不提供伪造证据、规避监管的方法。',
      firstMessage: '把情况说清楚，我先帮你梳理争议焦点。'
    };
    const sp = App.Prompts.buildSystemPrompt(card) || '';
    out.spLen = sp.length;
    out.spHasLaw = sp.indexOf('刑事辩护') >= 0 || sp.indexOf('法律') >= 0;
    out.spHasRoleplay = sp.indexOf('扮演') >= 0;
    out.spHasBoundary = sp.indexOf('不代替律师') >= 0 || sp.indexOf('知识边界') >= 0;
    out.err401 = (App.API.errorInfo({ code: 401 }) || {}).title || '';
    return out;
  })()`);
  if (statics.wvCount === 7) ok('内置世界观 7 套：' + statics.wvNames.join(' / '));
  else bad('内置世界观数量应为 7，实际 ' + statics.wvCount);
  if (statics.spHasLaw && !statics.spHasRoleplay && statics.spHasBoundary) ok('助手 system prompt 体现专业领域与边界、无「扮演」话术（' + statics.spLen + ' 字）');
  else bad('助手 system prompt 不符合预期: law=' + statics.spHasLaw + ' roleplay=' + statics.spHasRoleplay + ' boundary=' + statics.spHasBoundary);
  if (/Key/i.test(statics.err401)) ok('401 错误映射含 Key 提示：' + statics.err401);
  else bad('401 错误映射异常：' + statics.err401);
  if (statics.askill) ok('引导气泡与帮助模块存在'); else bad('引导气泡/帮助模块缺失');

  // ---------- 2. 进入创建向导（陪聊 → 现代都市 → 基本信息） ----------
  await page.eval(`(async () => { await App.Router.tab('characters'); await new Promise(r => setTimeout(r, 700)); return true; })()`);
  await page.eval(jsClick('button', '新建角色'));
  await sleep(500);
  await page.eval(jsClick('.ck-type-card', '陪聊'));
  await sleep(300);
  await page.eval(jsClick('.ck-wizard-foot button', '下一步'));
  await sleep(400);
  await page.eval(jsClick('.ck-wv-card', '现代都市'));
  await sleep(300);
  await page.eval(jsClick('.ck-wizard-foot button', '下一步'));
  await sleep(500);

  const inputs = await page.eval(`Array.from(document.querySelectorAll('.ck-wizard-body .form input, .ck-wizard-body .form textarea')).map(i => i.getAttribute('data-guide-focus') || i.id || '')`);
  const fillByFocus = (focus, value) => `(() => {
    const el = document.querySelector('[data-guide-focus="' + ${JSON.stringify(focus)} + '"]');
    if (!el) return 'notfound';
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`;
  if (inputs.includes('name') && inputs.includes('personality')) {
    ok('Step3 输入框带 data-guide-focus（可被引导定位）：' + inputs.filter(Boolean).join(','));
  } else {
    bad('Step3 输入框缺少 data-guide-focus: ' + JSON.stringify(inputs));
  }
  await page.eval(fillByFocus('name', '沈墨'));
  await page.eval(fillByFocus('personality', '外冷内热，话少但会默默照顾人'));
  await sleep(200);
  await page.eval(jsClick('.ck-wizard-foot button', 'AI 补全'));
  await sleep(600);

  // ---------- 3. 安装补全 mock（流式逐段吐 JSON，记录调用参数），Step4 开始生成 ----------
  const installed = await page.eval(`(() => {
    window.__calls = [];
    window.__chunks = [];
    var CARD = ${JSON.stringify(CARD1)};
    App.API.chatStream = function (opts) {
      window.__calls.push({ provider: (opts.provider || {}).name || '', providerId: (opts.provider || {}).id || '', model: opts.model || '', stream: true });
      var text = JSON.stringify(CARD);
      var i = 0;
      var aborted = false;
      var timer = null;
      function step() {
        if (aborted) return;
        var piece = text.slice(i, i + 16);
        i += 24;
        if (piece) { window.__chunks.push(piece.length); opts.onDelta(piece); }
        if (i >= text.length) {
          opts.onDone({ text: text, usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } });
          return;
        }
        timer = setTimeout(step, 45);
      }
      timer = setTimeout(step, 60);
      return {
        abort: function () { aborted = true; if (timer) clearTimeout(timer); opts.onError({ code: 'cancel', message: '已取消' }); }
      };
    };
    return true;
  })()`);
  if (installed) ok('已注入补全 chatStream mock（逐段吐 JSON，记录 provider/model）');
  const step4text = await page.eval(`((document.querySelector('.ck-wizard-body') || {}).innerText || '')`);
  const step4foot = await page.eval(`((document.querySelector('.ck-wizard-foot') || {}).innerText || '')`);
  if (step4text.indexOf('补全使用') >= 0 && step4text.indexOf('补全大约需要') >= 0 && step4foot.indexOf('跳过') >= 0) ok('Step4 显示补全 API、耗时提示与「跳过，手动填写」兜底');
  else bad('Step4 结构异常：' + step4text.slice(0, 80) + ' | ' + step4foot.replace(/\n/g, ' '));

  // #9：在 Step4 切换到「我的聊天 API / gpt-4o」，生成应真正用这套 API
  await page.eval(jsClick('.ck-provider-bar'));
  await waitFor(page, `(() => !!document.querySelector('.ck-pick-item'))()`, 3000);
  const switchedApi = await page.eval(jsClick('.modal button', '换 API'));
  await sleep(400);
  const pickedApi = await page.eval(jsClick('.ck-pick-item', '我的聊天 API'));
  await sleep(400);
  const pickedModel = await page.eval(jsClick('.ck-pick-item', 'gpt-4o'));
  await sleep(600);
  const barText = await page.eval(`((document.querySelector('.ck-provider-name') || {}).textContent || '')`);
  if (switchedApi === 'ok' && pickedApi === 'ok' && pickedModel === 'ok' && barText.indexOf('我的聊天 API') >= 0 && barText.indexOf('gpt-4o') >= 0) ok('Step4 可切换补全 API → ' + barText);
  else bad('Step4 切换补全 API 失败: ' + JSON.stringify({ switchedApi, pickedApi, pickedModel, barText }));

  await page.eval(jsClick('.ck-wizard-foot button', '开始 AI 补全'));
  const liveSeen = await waitFor(page, `(() => {
    const p = document.querySelector('.ck-gen-preview');
    const e = document.querySelector('.ck-gen-elapsed');
    return !!(p && (p.innerText || '').length > 20 && e && /\\d+\\.\\d+s/.test(e.innerText));
  })()`, 5000);
  if (liveSeen) ok('补全过程中实时输出 + 计时可见'); else bad('补全过程没有实时输出');
  const gotPreview = await waitFor(page, `(() => !!document.querySelector('.ck-preview-name'))()`, 10000);
  await sleep(600);
  let rev = await page.eval(REVIEW);
  if (gotPreview && rev.step5 && rev.name.indexOf('沈墨') >= 0) ok('AI 补全成功，进入预览：' + rev.name);
  else bad('AI 补全未进入预览: ' + JSON.stringify({ gotPreview, name: rev.name }));
  if (rev.aiTags >= 6) ok('预览标注 AI 补全字段 ' + rev.aiTags + ' 个（≥6）'); else bad('AI 字段标注不足：' + rev.aiTags);
  if (rev.userTags >= 2) ok('预览标注用户填写字段 ' + rev.userTags + ' 个'); else bad('用户字段标注不足：' + rev.userTags);
  if (rev.body.indexOf('雨这么大，进来躲一下吧') >= 0) ok('预览展示 AI 生成的开场白'); else bad('预览缺少开场白');

  const calls = await page.eval('window.__calls.slice()');
  if (calls.length >= 1) ok('补全调用记录：' + calls.map(c => c.provider + '/' + c.model).join(','));
  else bad('补全未调用 chatStream');
  if (calls.length && calls[0].providerId === 'prov_chat' && calls[0].model === 'gpt-4o') ok('补全使用 Step4 切换后的 API（prov_chat / gpt-4o）');
  else bad('补全 provider 不对：' + JSON.stringify(calls[0]));

  const dbBefore = await page.eval(`(async () => (await App.DB.all('characters')).length)()`);
  if (dbBefore === 0) ok('保存前 characters 表为空（未自动保存）'); else bad('保存前已写库：' + dbBefore);

  await page.screenshot(path.join(SHOTS, '60-ai-preview.png'));

  // ---------- 4. 草稿持久化：刷新后恢复（#10） ----------
  const draftSaved = await page.eval(`(async () => { const d = await App.DB.settings.get('draft_character', null); return d ? { step: d.step, name: (d.card || {}).name || '' } : null; })()`);
  if (draftSaved && draftSaved.step === 5) ok('草稿已持久化到 settings.draft_character（step=' + draftSaved.step + '）');
  else bad('草稿未持久化：' + JSON.stringify(draftSaved));

  await page.navigate(APP_URL + '/index.html?reload=' + Date.now(), 1400);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);
  await sleep(300);
  await page.eval(`(async () => { await App.Router.tab('characters'); await new Promise(r => setTimeout(r, 600)); return true; })()`);
  await page.eval(jsClick('button', '新建角色'));
  await sleep(1200);
  rev = await page.eval(REVIEW);
  if (rev.step5 && rev.name.indexOf('沈墨') >= 0 && rev.aiTags >= 6) ok('刷新后草稿恢复：直接回到预览页（' + rev.name + '，AI 字段 ' + rev.aiTags + '）');
  else bad('草稿恢复失败: ' + JSON.stringify({ step5: rev.step5, name: rev.name, ai: rev.aiTags }));

  // ---------- 5. 让 AI 改 → 第 2 版 → 回滚（#11 / #12） ----------
  await page.eval(`(() => {
    window.__rewrite = [];
    App.API.completion = function (opts) {
      window.__rewrite.push({ provider: (opts.provider || {}).name || '', providerId: (opts.provider || {}).id || '', model: opts.model || '', hasInstruction: String(opts.user || '').indexOf('再高冷一点') >= 0 });
      return Promise.resolve({ ok: true, text: JSON.stringify(${JSON.stringify(CARD2)}), usage: null, error: null });
    };
    return true;
  })()`);
  await page.eval(jsClick('.ck-wizard-foot button', '让 AI 改'));
  await waitFor(page, `(() => !!document.querySelector('.modal textarea'))()`, 3000);
  await page.eval(jsFill('.modal textarea', '再高冷一点'));
  await sleep(150);
  await page.eval(jsClick('.modal-foot button', '开始修改'));
  const gotV2 = await waitFor(page, `(() => document.querySelectorAll('.ck-version-chip').length >= 2)()`, 10000);
  await sleep(500);
  rev = await page.eval(REVIEW);
  if (gotV2 && rev.versions >= 2) ok('改稿后出现版本切换：' + rev.chips.join(' / '));
  else bad('改稿未产生第 2 版: ' + JSON.stringify({ gotV2, versions: rev.versions }));
  if (rev.body.indexOf('雨停了再走') >= 0) ok('当前预览为第 2 版内容');
  else bad('第 2 版内容未生效');
  const rw = await page.eval('window.__rewrite.slice()');
  if (rw.length && rw[0].providerId === 'prov_guide') ok('改稿固定使用引导 API（prov_guide）');
  else bad('改稿 API 不对：' + JSON.stringify(rw[0]));
  if (rw.length && rw[0].hasInstruction) ok('改稿请求携带用户意见');
  else bad('改稿请求未包含修改意见');

  await page.screenshot(path.join(SHOTS, '61-ai-rewrite-v2.png'));

  // 回滚到第 1 版
  await page.eval(jsClick('.ck-version-chip', '首次补全'));
  await sleep(600);
  rev = await page.eval(REVIEW);
  if (rev.body.indexOf('雨这么大，进来躲一下吧') >= 0) ok('切回第 1 版成功（内容已回滚）');
  else bad('回滚第 1 版失败');

  // ---------- 6. 保存 + 落库字段来源校验 ----------
  await page.eval(jsClick('.ck-wizard-foot button', '保存'));
  await sleep(1500);
  const saved = await page.eval(`(async () => {
    const list = await App.DB.all('characters');
    const c = list[0] || {};
    return { count: list.length, name: c.name, type: c.type, genProvider: c.generationProviderId, genModel: c.generationModel, originBg: (c.fieldOrigin || {}).background || '', originFirst: (c.fieldOrigin || {}).firstMessage || '', hasSp: !!(c.systemPrompt && c.systemPrompt.length > 50), draft: await App.DB.settings.get('draft_character', null) };
  })()`);
  if (saved.count === 1 && saved.name === '沈墨' && saved.type === 'companion') ok('保存成功并落库：' + saved.name);
  else bad('保存落库异常：' + JSON.stringify(saved));
  if (saved.genProvider === 'prov_chat' && saved.originBg === 'ai') ok('落库记录生成 API（prov_chat）与字段来源（background=ai）');
  else bad('生成信息/字段来源异常：' + JSON.stringify({ genProvider: saved.genProvider, originBg: saved.originBg }));
  if (saved.hasSp) ok('保存后带 systemPrompt'); else bad('保存后 systemPrompt 缺失');
  if (!saved.draft) ok('保存后草稿已清理'); else bad('保存后草稿仍存在');

  // ---------- 7. 1000 条消息会话首屏性能（#21） ----------
  const perf = await page.eval(`(async () => {
    const now = Date.now();
    const char = (await App.DB.all('characters'))[0];
    await App.DB.put('sessions', { id: 'sess_big', characterId: char.id, title: char.name, providerId: 'prov_chat', model: 'gpt-4o', presetId: '', personaId: '', pinned: false, unread: 0, isGenerating: false, lastMessage: '第 1000 条消息', createdAt: now - 100000, updatedAt: now });
    const rows = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({ id: 'm_' + i, sessionId: 'sess_big', role: i % 2 === 0 ? 'user' : 'assistant', content: '这是第 ' + (i + 1) + ' 条消息，用来测试大列表渲染性能。', createdAt: now - (1000 - i) * 1000, status: 'ok', variantIndex: 0, variants: [], tokensIn: 0, tokensOut: 0 });
    }
    await App.DB.bulkPut('messages', rows);
    const t0 = performance.now();
    await App.Router.push('chat', { sessionId: 'sess_big' });
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 100 && !document.querySelector('.msg'); i++) await wait(30);
    const tOpen = performance.now() - t0;
    await wait(900);
    return { tOpen: Math.round(tOpen), nodes: document.querySelectorAll('.msg').length, total: document.querySelectorAll('.msg-list .msg').length };
  })()`);
  if (perf.nodes > 0 && perf.nodes <= 80) ok('1000 条消息首屏只渲染 ' + perf.nodes + ' 个节点，打开耗时 ' + perf.tOpen + 'ms');
  else bad('大列表首屏渲染异常：' + JSON.stringify(perf));
  await page.screenshot(path.join(SHOTS, '62-big-list.png'));

  // ---------- 8. 断网：历史仍可读，发送给出明确错误（#20） ----------
  const offline = await page.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const before = document.querySelectorAll('.msg').length;
    App.API.chatStream = function (opts) {
      setTimeout(function () {
        try { opts.onError({ code: 'offline', message: '网络不可用' }); } catch (e) {}
      }, 80);
      return { abort: function () {}, done: Promise.resolve({ ok: false, error: { code: 'offline' } }) };
    };
    const inp = document.querySelector('[data-guide-focus="composer"]');
    if (!inp) return { error: 'no composer' };
    const proto = inp.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(inp, '断网测试消息');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(120);
    const send = document.querySelector('[data-guide-tap="send"]');
    if (!send) return { error: 'no send button' };
    send.click();
    for (let i = 0; i < 100 && !document.querySelector('.msg-error'); i++) await wait(60);
    const errEl = document.querySelector('.msg-error-text');
    return { before, after: document.querySelectorAll('.msg').length, errText: errEl ? errEl.textContent : '', history: document.querySelectorAll('.msg').length };
  })()`);
  if (offline && offline.errText && /网络|断网|连接|离线/.test(offline.errText)) ok('断网发送给出明确错误：' + offline.errText.trim());
  else bad('断网错误提示异常：' + JSON.stringify(offline));
  if (offline && offline.history >= 30) ok('断网时历史消息仍可读（渲染 ' + offline.history + ' 条）');
  else bad('断网时历史不可读：' + JSON.stringify(offline));
  await page.screenshot(path.join(SHOTS, '63-offline.png'));

  // ---------- 8b. 错误气泡「这是什么意思？」→ 带上下文的帮助抽屉（#14） ----------
  const errHelp = await page.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const btns = Array.from(document.querySelectorAll('.msg-error-actions button'));
    const b = btns.find(x => (x.textContent || '').indexOf('这是什么意思') >= 0);
    if (!b) return { error: 'no help button', btns: btns.map(x => x.textContent.trim()) };
    b.click();
    for (let i = 0; i < 60 && !document.querySelector('[data-help-drawer]'); i++) await wait(60);
    await wait(400);
    const drawer = document.querySelector('[data-help-drawer]');
    const sub = document.querySelector('.help-drawer-sub');
    const chips = Array.from(document.querySelectorAll('.help-quick-chip, .help-chip, .help-q')).map(x => x.textContent.trim());
    return { open: !!drawer, sub: sub ? sub.innerText : '', chips: chips.slice(0, 8), body: drawer ? drawer.innerText.slice(0, 200) : '' };
  })()`);
  if (errHelp.open && /网络|断网|offline|错误/.test(errHelp.sub + ' ' + errHelp.body)) ok('错误气泡「这是什么意思？」打开帮助抽屉并带上错误上下文');
  else bad('错误帮助抽屉异常：' + JSON.stringify(errHelp));
  await page.screenshot(path.join(SHOTS, '64-error-help.png'));
  await page.eval(`(async () => { try { App.Help.close(); } catch (e) {} return true; })()`);
  await sleep(300);

  // ---------- 9. 引导会话不进聊天列表（#15） ----------
  const guideList = await page.eval(`(async () => {
    const now = Date.now();
    await App.DB.put('helpSessions', { id: 'hs_test', title: '引导会话', source: 'settings_help', context: {}, createdAt: now, updatedAt: now });
    await App.DB.put('helpMessages', { id: 'hm_test', sessionId: 'hs_test', role: 'user', content: '怎么配置 API', createdAt: now });
    await App.Router.tab('chatList');
    await new Promise(r => setTimeout(r, 700));
    const sessions = await App.DB.all('sessions');
    return { sessions: sessions.length, help: (await App.DB.all('helpSessions')).length, rows: document.querySelectorAll('.session-cell').length };
  })()`);
  if (guideList.rows === guideList.sessions && guideList.help >= 1) ok('引导会话独立存储，聊天列表只显示 ' + guideList.rows + ' 个真实会话');
  else bad('引导会话混入聊天列表：' + JSON.stringify(guideList));

  // ---------- 9b. null 增量回归：兼容 API 会发 {"delta":{"content":null}}，不能拼出 "null" ----------
  const nullCase = await page.eval(`(async () => {
    const orig = App.API.chatStream;
    const obj = ${JSON.stringify(CARD1)};
    const text = JSON.stringify(obj);
    App.API.chatStream = function (o) {
      setTimeout(function () {
        o.onDelta(null);
        o.onDelta(undefined);
        o.onDelta('');
        o.onDelta(text.slice(0, 12));
        o.onDelta(text.slice(12));
        o.onDone({ text: text });
      }, 30);
      return { abort: function () {} };
    };
    let acc = '';
    let res;
    try {
      res = await App.Prompts.completeCharacter({
        provider: { id: 'prov_chat', name: '测试 API', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o' },
        model: 'gpt-4o',
        draft: { name: '测试' },
        onDelta: function (a) { acc = a; }
      });
    } finally {
      App.API.chatStream = orig;
    }
    return { acc: acc, ok: !!(res && res.ok), hasNull: /[\\[\\{]?null/.test(acc), len: acc.length };
  })()`);
  if (nullCase.ok && !nullCase.hasNull) ok('null 增量被忽略：累计文本不含 "null"（' + nullCase.acc.slice(0, 40) + '）');
  else bad('null 增量回归失败：' + JSON.stringify(nullCase));

  // ---------- 汇总 ----------
  console.log('');
  if (problems.length) {
    console.log('[验收 E2E] 失败 ' + problems.length + ' 项：');
    problems.forEach((p) => console.log('  - ' + p));
    process.exit(1);
  }
  console.log('[验收 E2E] 全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('[验收 E2E] 运行异常：', e);
  process.exit(2);
});
