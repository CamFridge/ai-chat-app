/* 悬浮引导气泡 E2E（无头 Chrome）
   验证：
   - 气泡上下文准确（当前页 pageId / title）
   - 点小球 → 扇形 3~4 项（怎么走/问引导/帮助）
   - 「怎么走」走引导 API：注入 mock 的 JSON 回答 → 渲染 ≤3 步可点清单
   - focus 步骤：落到带 data-guide-focus 的输入框并高亮
   - navigate 步骤：跳到目标页面
   - 解析失败降级为纯文本，不阻断
   用法：node scripts/e2e-guide.js 9222 http://127.0.0.1:8321 */
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
  await App.DB.settings.set('last_tab', 'chatList');
  await App.DB.settings.set('theme', 'light');
  return { ok: true };
})()`;

const MOCK_STEPS = `(() => {
  window.__origCompletion = App.API.completion;
  App.API.completion = function () {
    return Promise.resolve({
      ok: true,
      text: '看这里，先填 Base URL，再去设置页确认。' + JSON.stringify({
        summary: '先补全 API 的基础信息，再去设置页确认默认 API。',
        steps: [
          { text: '在 Base URL 里填写 OpenAI 兼容端点', action: { type: 'focus', target: 'baseUrl' } },
          { text: '去设置页确认默认聊天 API', action: { type: 'navigate', target: '/settings' } }
        ]
      }) ,
      usage: {}
    });
  };
  return true;
})()`;

const MOCK_PLAIN = `(() => {
  App.API.completion = function () {
    return Promise.resolve({ ok: true, text: '先点右上角的「＋」新建一个 API，然后填 Key。', usage: {} });
  };
  return true;
})()`;

async function waitFor(page, expr, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await page.eval(expr)) return true; } catch (e) {}
    await sleep(intervalMs);
  }
  return false;
}

async function clickBall(page) {
  const rect = await page.eval(`(() => {
    const b = document.querySelector('.bubble-ball');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!rect) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 });
  }
  return true;
}

async function openFan(page) {
  await page.eval(`(() => { if (App.Bubble && App.Bubble.collapse) App.Bubble.collapse(); return true; })()`);
  await sleep(200);
  if (!(await clickBall(page))) return 'noball';
  const shown = await waitFor(page, `(() => document.querySelectorAll('.bubble-item').length >= 2)()`, 4000);
  return shown ? 'ok' : 'nofan';
}

async function clickFanItem(page, label) {
  return page.eval(`(() => {
    const items = Array.from(document.querySelectorAll('.bubble-item'));
    const t = items.find(e => (e.innerText || '').replace(/\\s+/g, '').includes(${JSON.stringify(label)}));
    if (!t) return 'notfound';
    t.click();
    return 'ok';
  })()`);
}

(async () => {
  const page = await CdpPage.connect(PORT);
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });

  console.log('[E2E] 悬浮引导气泡');

  await page.navigate('about:blank', 300);
  await page.clearStorage(ORIGIN);
  await page.navigate(APP_URL + '/index.html', 900);
  await waitFor(page, `(() => !!(window.App && App.DB && App.Router && App.Router.current()))()`, 8000);
  await page.eval(`(async () => { try { await App.DB.clearAll(); } catch (e) {} try { localStorage.clear(); } catch (e) {} return true; })()`);
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 900);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);
  await sleep(300);
  await page.eval(SEED);
  await page.navigate(APP_URL + '/index.html?seed=' + Date.now(), 1800);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);
  await sleep(400);

  // ---------- 1. 打开 API 编辑页，检查上下文 ----------
  await page.eval(`(async () => { await App.Router.push('apiEdit', { isNew: true }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  const ctx = await page.eval(`(() => { const c = App.Bubble && App.Bubble.getContext && App.Bubble.getContext(); return c || null; })()`);
  if (ctx && ctx.pageId === 'apiEdit') ok('气泡上下文 pageId=' + ctx.pageId + ' title=' + ctx.title);
  else bad('气泡上下文不正确：' + JSON.stringify(ctx));
  if (ctx && !/sk-[A-Za-z0-9]{8,}/.test(JSON.stringify(ctx))) ok('气泡上下文不包含真实 Key');
  else bad('气泡上下文疑似包含真实 Key：' + JSON.stringify(ctx));
  if (ctx && !JSON.stringify(ctx).match(/content|messages/)) ok('气泡上下文不含聊天正文');
  else bad('气泡上下文疑似包含聊天正文');

  // ---------- 2. 扇形菜单 ----------
  let fan = await openFan(page);
  if (fan === 'ok') {
    const labels = await page.eval(`(() => Array.from(document.querySelectorAll('.bubble-item')).map(e => (e.innerText || '').replace(/\\s+/g, '')))()`);
    ok('扇形菜单已展开：' + labels.join(' / '));
    if (labels.some((l) => l.includes('怎么走'))) ok('含「怎么走」');
    else bad('扇形菜单缺少「怎么走」：' + labels.join(','));
    if (labels.length >= 3 && labels.length <= 4) ok('扇形项数量 ' + labels.length + '（3~4 项）');
    else bad('扇形项数量异常：' + labels.length);
    await page.screenshot(path.join(SHOTS, '50-bubble-fan.png'));
  } else bad('扇形菜单打不开：' + fan);

  // ---------- 3. 怎么走：JSON 步骤渲染（focus） ----------
  await page.eval(MOCK_STEPS);
  let r = await clickFanItem(page, '怎么走');
  if (r !== 'ok') bad('点不到「怎么走」：' + r);
  const stepsShown = await waitFor(page, `(() => document.querySelectorAll('.bubble-panel .guide-step').length >= 2)()`, 6000);
  if (stepsShown) ok('「怎么走」渲染出可点步骤清单');
  else bad('「怎么走」没有渲染步骤清单');
  const stepTexts = await page.eval(`(() => Array.from(document.querySelectorAll('.bubble-panel .guide-step')).map(e => (e.innerText || '').replace(/\\s+/g, ' ').trim()))()`);
  ok('步骤内容：' + stepTexts.join(' | '));
  await page.screenshot(path.join(SHOTS, '51-guide-steps.png'));

  // 点 focus 步骤
  const focusClicked = await page.eval(`(() => {
    const steps = Array.from(document.querySelectorAll('.bubble-panel .guide-step'));
    if (!steps.length) return 'nostep';
    steps[0].click();
    return 'ok';
  })()`);
  if (focusClicked === 'ok') {
    await sleep(700);
    const focusInfo = await page.eval(`(() => {
      const el = document.activeElement;
      return {
        tag: el ? el.tagName : '',
        guideFocus: el ? el.getAttribute('data-guide-focus') : '',
        flash: el ? el.className.indexOf('guide-focus-flash') >= 0 : false,
        placeholder: el ? el.getAttribute('placeholder') : ''
      };
    })()`);
    if (focusInfo.guideFocus === 'baseUrl') ok('focus 步骤落到 Base URL 输入框（placeholder=' + focusInfo.placeholder + '）');
    else bad('focus 步骤未落到目标输入框：' + JSON.stringify(focusInfo));
    if (focusInfo.flash) ok('目标输入框高亮动画生效');
    else bad('目标输入框没有高亮 class');
    await page.screenshot(path.join(SHOTS, '52-guide-focus.png'));
  }

  // ---------- 4. 怎么走：navigate 步骤 ----------
  await sleep(600);
  fan = await openFan(page);
  if (fan !== 'ok') bad('第二次打开扇形菜单失败：' + fan);
  await page.eval(MOCK_STEPS);
  r = await clickFanItem(page, '怎么走');
  if (r !== 'ok') bad('第二次点不到「怎么走」：' + r);
  await waitFor(page, `(() => document.querySelectorAll('.bubble-panel .guide-step').length >= 2)()`, 6000);
  const navClicked = await page.eval(`(() => {
    const steps = Array.from(document.querySelectorAll('.bubble-panel .guide-step'));
    if (steps.length < 2) return 'nostep';
    steps[1].click();
    return 'ok';
  })()`);
  if (navClicked === 'ok') {
    await sleep(900);
    const pageName = await page.eval(`(() => (App.Router.current() || {}).name)()`);
    if (pageName === 'settings') ok('navigate 步骤跳到设置页');
    else bad('navigate 步骤没有跳转，当前页：' + pageName);
    await page.screenshot(path.join(SHOTS, '53-guide-navigate.png'));
  }

  // ---------- 5. 解析失败降级为纯文本 ----------
  await page.eval(MOCK_PLAIN);
  fan = await openFan(page);
  if (fan !== 'ok') bad('第三次打开扇形菜单失败：' + fan);
  r = await clickFanItem(page, '怎么走');
  if (r !== 'ok') bad('第三次点不到「怎么走」：' + r);
  const panelText = await waitFor(page, `(() => {
    const p = document.querySelector('.bubble-panel');
    return p && /新建一个 API/.test(p.innerText);
  })()`, 6000);
  if (panelText) ok('解析失败时降级显示纯文本，不阻断');
  else bad('解析失败时没有显示纯文本兜底');
  const plainTip = await page.eval(`(() => { const p = document.querySelector('.bubble-panel'); return p ? (p.innerText || '') : ''; })()`);
  if (/格式没看懂|原文展示/.test(plainTip)) ok('纯文本兜底有「已按原文展示」提示');
  else bad('纯文本兜底缺少提示文案：' + plainTip.slice(0, 80));
  if (/问引导/.test(plainTip)) ok('纯文本兜底面板提供「问引导」入口');
  else bad('纯文本兜底面板缺少入口');
  await page.screenshot(path.join(SHOTS, '54-guide-plain.png'));

  console.log('');
  if (problems.length) {
    console.log('结果：' + problems.length + ' 个问题');
    problems.forEach((p, i) => console.log('  ' + (i + 1) + ') ' + p));
    process.exit(1);
  }
  console.log('结果：全部通过');
  process.exit(0);
})().catch((e) => { console.error('E2E 崩溃：', e && e.stack || e); process.exit(2); });
