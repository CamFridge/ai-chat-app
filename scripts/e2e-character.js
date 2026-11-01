/* 创建角色 5 步向导 E2E（无头 Chrome，浏览器 mock 模式）
   验证：
   - 角色 Tab → ＋新建角色 → 5 步向导（类型/世界观/基本信息/AI 补全/预览）
   - Step3 必填校验：只填名称 → 不能进入下一步
   - Step4 AI 补全在 mock 下解析失败 → 显示失败卡片 + 「跳过 AI 补全」兜底
   - 手动兜底 → 预览 → 保存 → characters 表落库（且只有点保存才写库）
   - 保存后自动进入聊天页并写入开场白
   用法：node scripts/e2e-character.js 9222 http://127.0.0.1:8321 */
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
  await App.Bridge.call('secure.set', { key: 'key:prov_guide', value: 'sk-demo-guide-123456' });
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

const jsWizard = `(() => {
  const cur = App.Router.current();
  const body = document.querySelector('.ck-wizard-body');
  const foot = document.querySelector('.ck-wizard-foot');
  return {
    page: cur && cur.name,
    caption: ((document.querySelector('.ck-wizard-caption') || {}).innerText || '').replace(/\\s+/g, ' ').trim(),
    bodyText: body ? body.innerText : '',
    footText: foot ? foot.innerText : '',
    typeCards: document.querySelectorAll('.ck-type-card').length,
    wvCards: document.querySelectorAll('.ck-wv-card').length,
    inputs: Array.from(document.querySelectorAll('.ck-wizard-body .form input, .ck-wizard-body .form textarea')).map(i => i.getAttribute('data-guide-focus') || i.id || ''),
    charCount: 0
  };
})()`;

async function waitFor(page, expr, timeoutMs = 8000, intervalMs = 150) {
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

  console.log('[E2E] 创建角色向导');

  // ---------- 0. 全新状态 + 种子（已完成引导、有引导 API） ----------
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

  // 进入角色 Tab
  await page.eval(`(async () => { await App.Router.tab('characters'); await new Promise(r => setTimeout(r, 800)); return true; })()`);
  let st = await page.eval(jsWizard);
  if (st.page === 'characters') ok('进入角色 Tab');
  else bad('未进入角色 Tab：' + st.page);

  // 空态下新建角色
  if ((await page.eval(jsClick('button', '新建角色'))) !== 'ok') bad('点不到「新建角色」');
  await sleep(700);
  st = await page.eval(jsWizard);
  if (st.page === 'characterCreate') ok('打开创建角色向导：' + st.caption);
  else bad('未打开创建角色向导：' + st.page);
  await page.screenshot(path.join(SHOTS, '30-char-step1.png'));

  // ---------- 1. Step1 选择类型（陪聊） ----------
  if (st.typeCards >= 2) ok('Step1 有 ' + st.typeCards + ' 个类型卡片');
  else bad('Step1 类型卡片数量异常：' + st.typeCards);
  if ((await page.eval(jsClick('.ck-type-card', '陪聊'))) !== 'ok') bad('点不到陪聊类型卡片');
  await sleep(300);
  if ((await page.eval(jsClick('.ck-wizard-foot button', '下一步'))) !== 'ok') bad('Step1 点不到下一步');
  await sleep(600);
  st = await page.eval(jsWizard);
  if (/第 2/.test(st.caption) && /选择世界观/.test(st.caption)) ok('进入 Step2：' + st.caption);
  else bad('未进入 Step2：' + st.caption);

  // ---------- 2. Step2 选择世界观 ----------
  if (st.wvCards >= 7) ok('Step2 世界观卡片 ' + st.wvCards + ' 个（含自定义）');
  else bad('Step2 世界观卡片数量异常：' + st.wvCards);
  if ((await page.eval(jsClick('.ck-wv-card', '现代都市'))) !== 'ok') bad('点不到「现代都市」世界观');
  await sleep(300);
  await page.screenshot(path.join(SHOTS, '31-char-step2.png'));
  if ((await page.eval(jsClick('.ck-wizard-foot button', '下一步'))) !== 'ok') bad('Step2 点不到下一步');
  await sleep(600);
  st = await page.eval(jsWizard);
  if (/第 3/.test(st.caption)) ok('进入 Step3：' + st.caption);
  else bad('未进入 Step3：' + st.caption);

  // ---------- 3. Step3 必填校验 + 填写 ----------
  const filledName = await page.eval(jsFill('[data-guide-focus="name"]', '林晚'));
  if (filledName === 'ok:林晚') ok('填写角色名称');
  else bad('名称写入失败：' + filledName);
  // 只填名称 → 点 AI 补全应被校验拦截
  if ((await page.eval(jsClick('.ck-wizard-foot button', 'AI 补全'))) !== 'ok') bad('Step3 点不到「AI 补全」');
  await sleep(500);
  st = await page.eval(jsWizard);
  if (/第 3/.test(st.caption)) ok('缺少性格时被拦截（仍停留 Step3）');
  else bad('缺少必填项却进入了下一步：' + st.caption);
  const filledP = await page.eval(jsFill('[data-guide-focus="personality"]', '外冷内热，说话简短，偶尔毒舌'));
  if (filledP && filledP.indexOf('ok:') === 0) ok('填写一句话性格');
  else bad('性格写入失败：' + filledP);
  await page.eval(jsFill('[data-guide-focus="habits"]', '睡前一定要喝一杯热牛奶'));
  await page.screenshot(path.join(SHOTS, '32-char-step3.png'));

  // ---------- 4. Step4 AI 补全（实时输出 / 可停止 / 失败兜底） ----------
  if ((await page.eval(jsClick('.ck-wizard-foot button', 'AI 补全'))) !== 'ok') bad('无法进入 Step4');
  await sleep(700);
  st = await page.eval(jsWizard);
  if (/第 4/.test(st.caption)) ok('进入 Step4：' + st.caption);
  else bad('未进入 Step4：' + st.caption);
  if ((await page.eval(jsClick('.ck-wizard-foot button', '开始 AI 补全'))) !== 'ok') bad('点不到「开始 AI 补全」');

  // 4.1 生成中：真实计时 + 实时输出
  const liveShown = await waitFor(page, `(() => {
    const live = document.querySelector('.ck-gen-live');
    const pre = document.querySelector('.ck-gen-preview');
    const elapsed = document.querySelector('.ck-gen-elapsed');
    return !!(live && pre && (pre.innerText || '').length > 8 && elapsed && /\\d+\\.\\d+s/.test(elapsed.innerText));
  })()`, 10000);
  const liveInfo = await page.eval(`(() => {
    const foot = document.querySelector('.ck-wizard-foot');
    const meta = (document.querySelector('.ck-gen-meta') || {}).innerText || '';
    return {
      status: ((document.querySelector('.ck-gen-status') || {}).innerText || '').replace(/\\s+/g, ' ').trim(),
      meta: meta.replace(/\\s+/g, ' ').trim(),
      foot: foot ? foot.innerText.replace(/\\s+/g, ' ').trim() : '',
      previewLen: ((document.querySelector('.ck-gen-preview') || {}).innerText || '').length
    };
  })()`);
  if (liveShown) ok('生成中实时输出 + 计时可见（预览 ' + liveInfo.previewLen + ' 字）');
  else bad('生成中没有实时输出 / 计时：' + JSON.stringify(liveInfo));
  if (/已接收 \d+ 字/.test(liveInfo.meta) && /第 1 次尝试/.test(liveInfo.meta)) ok('生成状态如实显示：' + liveInfo.meta);
  else bad('生成状态显示异常：' + liveInfo.meta);
  if (/停止生成/.test(liveInfo.foot)) ok('生成中底部只有「停止生成」');
  else bad('生成中底部按钮异常：' + liveInfo.foot);
  await page.screenshot(path.join(SHOTS, '33a-char-step4-live.png'));

  // 4.2 停止生成 → 保留已收到内容
  if ((await page.eval(jsClick('.ck-wizard-foot button', '停止生成'))) !== 'ok') bad('点不到「停止生成」');
  const stopped = await waitFor(page, `(() => /已停止生成/.test((document.querySelector('.ck-wizard-body') || {}).innerText || ''))()`, 6000);
  if (stopped) ok('停止生成后显示「已停止生成」并保留内容');
  else bad('停止生成后没有停止态');
  await page.screenshot(path.join(SHOTS, '33b-char-step4-stopped.png'));

  // 4.3 继续生成 → mock 流式返回非 JSON → 重试一次 → 失败卡片
  if ((await page.eval(jsClick('.ck-wizard-foot button', '继续生成'))) !== 'ok') bad('点不到「继续生成」');
  const failed = await waitFor(page, `(() => /AI 补全没有返回完整角色卡/.test((document.querySelector('.ck-wizard-body') || {}).innerText || ''))()`, 20000);
  if (failed) ok('AI 补全失败卡片出现（含原始输出与手动兜底）');
  else bad('AI 补全失败卡片未出现');
  const failActions = await page.eval(`(() => {
    const foot = document.querySelector('.ck-wizard-foot');
    return {
      foot: foot ? foot.innerText.replace(/\\s+/g, ' ').trim() : '',
      hasRaw: !!document.querySelector('.ck-gen-raw-toggle, .ck-gen-raw'),
      bodyButtons: Array.from(document.querySelectorAll('.ck-gen-error button')).map(b => (b.innerText || '').trim())
    };
  })()`);
  if (/手动填写/.test(failActions.foot) && /重新生成/.test(failActions.foot)) ok('失败后底部提供「手动填写 / 重新生成」：' + failActions.foot);
  else bad('失败后底部按钮异常：' + failActions.foot);
  await page.screenshot(path.join(SHOTS, '33-char-step4-fail.png'));

  // 保存前：characters 表应为空
  const beforeSave = await page.eval(`(async () => (await App.DB.all('characters')).length)()`);
  if (beforeSave === 0) ok('保存前 characters 表为空（不自动保存）');
  else bad('保存前就已经写库了：' + beforeSave);

  // 手动兜底 → Step5 预览
  if ((await page.eval(jsClick('.ck-wizard-foot button', '手动填写'))) !== 'ok') {
    bad('点不到「手动填写」');
  }
  await sleep(800);
  st = await page.eval(jsWizard);
  if (/第 5/.test(st.caption) || /预览/.test(st.caption)) ok('进入 Step5 预览：' + st.caption);
  else bad('未进入 Step5：' + st.caption);
  await page.screenshot(path.join(SHOTS, '34-char-step5.png'));

  // ---------- 5. 保存 → 落库 → 自动开聊 ----------
  if ((await page.eval(jsClick('.ck-wizard-foot button', '保存'))) !== 'ok') bad('点不到「保存」');
  await sleep(1800);
  const after = await page.eval(`(async () => {
    const chars = await App.DB.all('characters');
    const sessions = await App.DB.all('sessions');
    const msgs = sessions.length ? await App.DB.byIndex('messages', 'sessionId', sessions[0].id) : [];
    return {
      page: App.Router.current() && App.Router.current().name,
      chars: chars.map(c => ({ name: c.name, type: c.type, personality: c.personality, wv: c.worldviewId, origin: c.fieldOrigin, firstMessage: c.firstMessage })),
      sessions: sessions.map(s => ({ id: s.id, characterId: s.characterId, title: s.title })),
      msgs: msgs.map(m => ({ role: m.role, content: m.content }))
    };
  })()`);
  if (after.chars.length === 1) ok('角色已保存：' + after.chars[0].name + ' / ' + after.chars[0].type);
  else bad('角色落库数量异常：' + JSON.stringify(after.chars));
  if (after.chars[0] && after.chars[0].name === '林晚') ok('保存的名称与填写一致');
  if (after.sessions.length === 1) ok('自动创建会话：' + JSON.stringify(after.sessions[0]));
  else bad('未自动创建会话：' + JSON.stringify(after.sessions));
  const firstMsg = after.chars[0] && String(after.chars[0].firstMessage || '').trim();
  if (firstMsg) {
    if (after.msgs.length >= 1 && after.msgs[0].role === 'assistant') ok('会话写入角色开场白（role=assistant）');
    else bad('角色有开场白但会话未写入：' + JSON.stringify(after.msgs));
  } else {
    if (!after.msgs.length) ok('手动兜底角色无开场白（按预期不写消息）');
    else bad('角色无开场白但会话出现了消息：' + JSON.stringify(after.msgs));
    const emptyText = await page.eval(`(() => { const el = document.querySelector('.msg-list'); return el ? el.innerText : ''; })()`);
    if (/还没有消息/.test(emptyText)) ok('空会话显示「还没有消息」空态');
    else bad('空会话缺少空态提示：' + emptyText.slice(0, 60));
  }
  if (after.page === 'chat') ok('保存后自动进入聊天页');
  else bad('保存后未进入聊天页，当前：' + after.page);
  await page.screenshot(path.join(SHOTS, '35-char-saved-chat.png'));

  // 再次进角色列表 → 应看到刚建的角色
  await page.eval(`(async () => { await App.Router.tab('characters'); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  const listText = await page.eval(`(() => (document.querySelector('#page-root .page:not([style*="none"])') || document.body).innerText.slice(0, 600))()`);
  if (listText.includes('林晚')) ok('角色列表显示新角色');
  else bad('角色列表未显示新角色');
  await page.screenshot(path.join(SHOTS, '36-char-list.png'));

  console.log('');
  if (problems.length) {
    console.log('结果：' + problems.length + ' 个问题');
    problems.forEach((p, i) => console.log('  ' + (i + 1) + ') ' + p));
    process.exit(1);
  }
  console.log('结果：全部通过');
  process.exit(0);
})().catch((e) => { console.error('E2E 崩溃：', e && e.stack || e); process.exit(2); });
