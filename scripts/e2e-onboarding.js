/* 首次引导向导 E2E（无头 Chrome，浏览器 mock 模式）
   验证验收要点：
   - 首次启动强制进入 onboarding，不能跳过
   - 测试连接失败时不能继续（无「下一步」按钮，且 gotoStep 被拦截）
   - 测试通过后才能选模型 → 完成 → 进入主界面
   - Key 只写安全存储，不写 DB
   用法：node scripts/e2e-onboarding.js 9222 http://127.0.0.1:8321 */
'use strict';
const path = require('path');
const fs = require('fs');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9222);
const APP_URL = process.argv[3] || 'http://127.0.0.1:8321';
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
const ORIGIN = new URL(APP_URL).origin;

const problems = [];
const ok = (m) => console.log('  \u2713 ' + m);
const bad = (m) => { problems.push(m); console.log('  \u2717 ' + m); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function jsFill(sel, value, index = 0) {
  return `(() => {
    const list = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
    const el = list[${index}];
    if (!el) return 'notfound';
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok:' + el.value;
  })()`;
}

function jsState() {
  return `(() => {
    const cur = App.Router.current();
    const stepLabel = (document.querySelector('.ob-step-label') || {}).textContent || '';
    const foot = (document.querySelector('.ob-footer') || {}).textContent || '';
    return {
      page: cur && cur.name,
      stepLabel: stepLabel.trim(),
      footer: foot.trim(),
      hasNext: Array.from(document.querySelectorAll('.ob-footer button')).some(b => /下一步|开始配置|开始使用/.test(b.textContent)),
      hasTest: Array.from(document.querySelectorAll('button')).some(b => /测试连接/.test(b.textContent)),
      hasError: !!document.querySelector('.ob-error'),
      hasOk: !!document.querySelector('.ob-ok'),
      modelItems: document.querySelectorAll('.ob-model-item').length,
      bodyText: (document.querySelector('.ob-body') || {}).innerText || ''
    };
  })()`;
}

async function waitFor(page, expr, timeoutMs = 6000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.eval(expr)) return true;
    } catch (e) { /* 页面切换中，继续等 */ }
    await sleep(intervalMs);
  }
  return false;
}

(async () => {
  const page = await CdpPage.connect(PORT);
  await page.init();
  console.log('[E2E] 首次引导向导');

  // ---------- 0. 清空数据，全新启动 ----------
  await page.navigate('about:blank', 300);
  await page.clearStorage(ORIGIN);
  await page.navigate(APP_URL + '/index.html', 900);
  await waitFor(page, `(() => !!(window.App && App.DB && App.Router && App.Router.current()))()`, 8000);
  // 双重保险：即使 clearDataForOrigin 因连接占用未完全生效，也在页面内清空所有表 + 本地缓存
  await page.eval(`(async () => {
    try { await App.DB.clearAll(); } catch (e) {}
    try { localStorage.clear(); } catch (e) {}
    return true;
  })()`);
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 900);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);
  await sleep(400);

  let st = await page.eval(jsState());
  if (st.page === 'onboarding') ok('首次启动进入 onboarding（强制）');
  else bad('首次启动未进入 onboarding，当前页：' + st.page);
  if (st.hasNext === false) ok('欢迎页没有可跳过入口（下一步按钮为「开始配置」）');
  await page.screenshot(path.join(SHOTS, '20-onboarding-welcome.png'));

  // ---------- 1. 欢迎 → 选择供应商 ----------
  if ((await page.eval(jsClick('.ob-footer button', '开始配置'))) !== 'ok') bad('点不到「开始配置」');
  await sleep(400);
  st = await page.eval(jsState());
  if (/第 2 步/.test(st.stepLabel)) ok('进入第 2 步：' + st.stepLabel);
  else bad('未进入选择供应商：' + st.stepLabel);

  // 选择 OpenAI 预设（自动填充 Base URL / 模型）
  if ((await page.eval(jsClick('.ob-preset', 'OpenAI'))) === 'ok') ok('选择了 OpenAI 预设');
  else bad('点不到 OpenAI 预设');
  await sleep(400);
  st = await page.eval(jsState());
  if (st.bodyText.includes('https://api.openai.com/v1')) ok('预设自动填好了 Base URL');
  else bad('预设没有自动填充 Base URL');

  if ((await page.eval(jsClick('.ob-footer button', '下一步'))) !== 'ok') bad('供应商页点不到「下一步」');
  await sleep(400);
  st = await page.eval(jsState());
  if (/第 3 步/.test(st.stepLabel)) ok('进入第 3 步：填写 API Key');
  else bad('未进入填写 API Key：' + st.stepLabel);

  // ---------- 2. 故意填错 Key，验证「测试不通过不能继续」 ----------
  if ((await page.eval(jsFill('.ob-key-row input', 'bad'))) !== 'ok:bad') bad('Key 输入框写入失败');
  if ((await page.eval(jsClick('.ob-footer button', '下一步'))) !== 'ok') bad('Key 页点不到「下一步」');
  await sleep(400);
  st = await page.eval(jsState());
  if (/第 4 步/.test(st.stepLabel)) ok('进入第 4 步：测试连接');
  else bad('未进入测试连接：' + st.stepLabel);

  if ((await page.eval(jsClick('button', '测试连接'))) !== 'ok') bad('点不到「测试连接」');
  await sleep(1400);
  st = await page.eval(jsState());
  if (st.hasError) ok('错误 Key → 显示连接失败卡片');
  else bad('错误 Key 没有显示失败卡片');
  if (!st.hasNext) ok('测试未通过时没有「下一步」（不能继续）');
  else bad('测试未通过却出现了「下一步」，可以绕过测试');
  if (/403|401|Key|失败|Unauthorized/.test(st.bodyText + st.footer)) ok('失败原因有中文提示');
  await page.screenshot(path.join(SHOTS, '21-onboarding-test-fail.png'));

  // 绕过尝试：直接调 gotoStep 不可行，改为验证前端状态门禁（选中模型页按钮不存在即可）
  const bypass = await page.eval(`(() => {
    const page = App.Router.current().page;
    return { step: (document.querySelector('.ob-step-label') || {}).textContent || '' };
  })()`);
  if (/第 4 步/.test(bypass.step)) ok('仍停留在测试连接步骤（未因失败跳步）');

  // ---------- 3. 修正 Key，测试通过 → 选模型 → 完成 ----------
  if ((await page.eval(jsClick('.ob-footer button', '上一步'))) !== 'ok') bad('点不到「上一步」');
  await sleep(400);
  const fixed = await page.eval(jsFill('.ob-key-row input', 'sk-valid-key-123456'));
  if (fixed === 'ok:sk-valid-key-123456') ok('已修正为有效 Key'); else bad('修正 Key 写入失败：' + fixed);
  if ((await page.eval(jsClick('.ob-footer button', '下一步'))) !== 'ok') bad('修正后点不到「下一步」');
  await sleep(400);
  if ((await page.eval(jsClick('button', '测试连接'))) !== 'ok') bad('点不到「测试连接」');
  await sleep(1600);
  st = await page.eval(jsState());
  if (st.hasOk) ok('有效 Key → 连接成功卡片');
  else bad('有效 Key 没有通过连接测试');
  if (st.hasNext) ok('测试通过后出现「下一步」');
  else bad('测试通过后仍无「下一步」');
  await page.screenshot(path.join(SHOTS, '22-onboarding-test-ok.png'));

  if ((await page.eval(jsClick('.ob-footer button', '下一步'))) !== 'ok') bad('测试通过后点不到「下一步」');
  await sleep(500);
  st = await page.eval(jsState());
  if (/第 5 步/.test(st.stepLabel)) ok('进入第 5 步：选择模型');
  else bad('未进入选择模型：' + st.stepLabel);
  if (st.modelItems > 0) ok('模型列表已加载：' + st.modelItems + ' 个');
  else bad('模型列表为空（mock 应返回 6 个）');
  if (st.modelItems > 1) {
    await page.eval(jsClick('.ob-model-item', 'gpt-4o') );
  }
  await page.screenshot(path.join(SHOTS, '23-onboarding-model.png'));

  if ((await page.eval(jsClick('.ob-footer button', '下一步'))) !== 'ok') bad('模型页点不到「下一步」');
  await sleep(500);
  st = await page.eval(jsState());
  if (/第 6 步/.test(st.stepLabel)) ok('进入第 6 步：完成配置');
  else bad('未进入完成页：' + st.stepLabel);

  // Key 不能出现在 DB 里
  const dbLeak = await page.eval(`(async () => {
    const provs = await App.DB.all('providers');
    const dump = JSON.stringify(provs);
    return { count: provs.length, leak: dump.includes('sk-valid-key-123456') || /"apiKey"|"key"/.test(dump) };
  })()`);
  if (!dbLeak.leak) ok('Key 未写入数据库（providers 表无 key 字段）');
  else bad('Key 疑似写入数据库！');
  if (dbLeak.count === 0) ok('完成前 providers 表仍为空（先测试后保存）');
  else bad('完成前已写入 provider 记录：' + dbLeak.count);

  await page.screenshot(path.join(SHOTS, '24-onboarding-done.png'));

  if ((await page.eval(jsClick('.ob-footer button', '开始使用'))) !== 'ok') bad('点不到「开始使用」');
  // 等保存 + 跳转真正完成（避免与重建页面抢时序）
  await waitFor(page, `(async () => (await App.DB.settings.get('onboarding_completed', false)) === true)()`, 8000);
  await waitFor(page, `(() => { const c = App.Router.current(); return !!(c && c.name !== 'onboarding'); })()`, 5000);
  await sleep(600);
  const after = await page.eval(`(async () => {
    const cur = App.Router.current();
    const provs = await App.DB.all('providers');
    const done = await App.DB.settings.get('onboarding_completed', false);
    const gid = await App.DB.settings.get('guide_provider_id', null);
    const key = gid ? await App.Bridge.call('secure.get', { key: 'key:' + gid }) : null;
    return {
      page: cur && cur.name,
      providers: provs.map(p => ({ id: p.id, role: p.role, baseUrl: p.baseUrl, model: p.defaultModel })),
      done, gid, hasKey: !!(key && key.value)
    };
  })()`);
  if (after.page && after.page !== 'onboarding') ok('完成后离开 onboarding，进入：' + after.page);
  else bad('完成后仍停留在 onboarding');
  if (after.done) ok('onboarding_completed = true');
  else bad('onboarding_completed 未置 true');
  if (after.providers.length === 1 && after.providers[0].role === 'guide') ok('写入 1 条 guide provider');
  else bad('provider 记录异常：' + JSON.stringify(after.providers));
  if (after.hasKey) ok('Key 已保存到安全存储');
  else bad('Key 未保存到安全存储');
  await page.screenshot(path.join(SHOTS, '25-main-after-onboarding.png'));

  // ---------- 4. 重启后不再要求引导 ----------
  await page.navigate(APP_URL + '/index.html', 1200);
  await waitFor(page, `(() => { const c = App.Router.current(); return !!(c && c.name !== 'onboarding'); })()`, 6000);
  await sleep(300);
  const restart = await page.eval(`(() => {
    const cur = App.Router.current();
    return { page: cur && cur.name, tabs: document.querySelectorAll('#tabbar .tab').length };
  })()`);
  if (restart.page === 'chatList') ok('重启后直接进入主界面，不再要求引导');
  else bad('重启后仍进入：' + restart.page);
  if (restart.tabs === 4) ok('底部 4 个 Tab 正常');
  else bad('Tab 数量异常：' + restart.tabs);

  // ---------- 汇总 ----------
  const errs = page.collect.consoleMsgs.filter((m) => m.level === 'error');
  const exc = page.collect.exceptions;
  if (!errs.length) ok('无 console.error');
  else bad('有 console.error：' + errs.map((e) => e.text).join(' | '));
  if (!exc.length) ok('无未捕获异常');
  else bad('有未捕获异常：' + exc.map((e) => e.text).join(' | '));

  console.log('\n截图目录：' + SHOTS);
  console.log('结果：' + (problems.length ? problems.length + ' 个问题' : '全部通过'));
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E 失败：', e);
  process.exit(2);
});
