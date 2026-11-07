/* E2E: 运行日志（v1.3.4）
 * 用法：node scripts/e2e-log.js 9222 http://127.0.0.1:8321
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
  while (Date.now() - t0 < timeout) {
    try {
      const v = await page.eval(expr);
      if (v) return v;
    } catch (e) { /* ignore */ }
    await sleep(interval);
  }
  return false;
}

const SEED = `
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await App.DB.clearAll(); localStorage.clear();
  await wait(120);
  const now = Date.now();
  await App.DB.put('providers', { id:'prov_guide', name:'示例引导 API', baseUrl:'https://api.example.com/v1', defaultModel:'gpt-4o-mini', role:'guide', isDefault:false, createdAt: now });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('last_tab', 'settings');
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
  await waitFor(`!!(window.App && App.DB && App.Log && App.Router)`, 12000);

  console.log('\n[E2E] 运行日志');

  // 1. 模块挂载与基础 API
  const api = await page.eval(`JSON.stringify({
    has: !!App.Log,
    fns: ['add','info','warn','error','list','count','clear','text'].filter(function (k) { return typeof App.Log[k] === 'function'; }).length
  })`);
  const apiObj = JSON.parse(api || '{}');
  if (apiObj.has && apiObj.fns === 8) ok('App.Log 已加载且 API 完整');
  else bad('App.Log 缺失：' + api);

  // 2. 主动记录
  await page.eval(`(() => { App.Log.clear(); App.Log.info('E2E-INFO-MARKER 测试信息'); App.Log.error('E2E-ERROR-MARKER 测试错误'); return true; })()`);
  const count1 = await page.eval(`App.Log.count()`);
  if (Number(count1) >= 2) ok('主动记录日志（count=' + count1 + '）');
  else bad('主动记录日志失败：' + count1);

  // 3. 自动捕获 console.error
  await page.eval(`(() => { console.error('E2E-CONSOLE-MARKER 控制台错误被捕获'); return true; })()`);
  const captured = await page.eval(`App.Log.text().indexOf('E2E-CONSOLE-MARKER') >= 0`);
  if (captured) ok('自动捕获 console.error');
  else bad('console.error 没有被日志捕获');

  // 4. 持久化到 localStorage
  const stored = await page.eval(`(() => { try { var arr = JSON.parse(localStorage.getItem('aichat.logs.v1') || '[]'); return arr.length; } catch (e) { return -1; } })()`);
  if (Number(stored) > 0) ok('日志持久化到 localStorage（' + stored + ' 条）');
  else bad('日志没有持久化：' + stored);

  // 5. 设置页入口
  await page.eval(`App.Router.tab('settings')`);
  await waitFor(`!!document.querySelector('[data-guide-focus="logs"]')`, 8000);
  const entry = await page.eval(`(() => {
    var el = document.querySelector('[data-guide-focus="logs"]');
    if (!el) return { found: false };
    return { found: true, text: (el.textContent || '').trim().slice(0, 80) };
  })()`);
  const entryObj = (entry && typeof entry === 'object') ? entry : JSON.parse(entry || '{}');
  if (entryObj.found) ok('设置页有「运行日志」入口', entryObj.text);
  else bad('设置页没有运行日志入口');

  // 6. 打开日志弹窗并检查内容
  await page.eval(`(() => { var el = document.querySelector('[data-guide-focus="logs"]'); if (el) el.click(); return true; })()`);
  const modalShown = await waitFor(`!!(document.querySelector('.modal') && document.querySelector('.modal .log-pre'))`, 6000);
  if (modalShown) ok('日志弹窗已打开');
  else bad('日志弹窗没有打开');
  await sleep(250);
  const logText = await page.eval(`(() => { var e = document.querySelector('.modal .log-pre'); return e ? (e.textContent || '') : ''; })()`);
  if (logText.indexOf('E2E-INFO-MARKER') >= 0 && logText.indexOf('E2E-CONSOLE-MARKER') >= 0) ok('日志弹窗显示已记录内容');
  else bad('日志内容缺失：' + String(logText).slice(0, 160));
  await page.screenshot(path.join(SHOTS, '118-settings-log.png'));

  // 7. 清空日志
  await page.eval(`(() => {
    var clear = document.querySelector('.modal .log-clear');
    if (clear) clear.click();
    return !!clear;
  })()`);
  await sleep(400);
  const cleared = await page.eval(`App.Log.count()`);
  if (Number(cleared) === 0) ok('清空日志生效');
  else bad('清空日志后仍有 ' + cleared + ' 条');

  // 8. 清空后重新打开显示「暂无日志」
  await page.eval(`(() => { var el = document.querySelector('[data-guide-focus="logs"]'); if (el) el.click(); return true; })()`);
  const emptyShown = await waitFor(`!!document.querySelector('.modal .log-pre')`, 6000);
  const emptyText = await page.eval(`(() => { var e = document.querySelector('.modal .log-pre'); return e ? (e.textContent || '') : ''; })()`);
  if (emptyShown && String(emptyText).indexOf('暂无日志') >= 0) ok('清空后显示「暂无日志」');
  else bad('清空后提示不正确：' + String(emptyText).slice(0, 80));

  const errs = await page.eval(`JSON.stringify(window.__e2eErrors || [])`);
  const errList = JSON.parse(errs || '[]');
  if (!errList.length) ok('无未捕获 JS 异常');
  else bad('出现未捕获异常：' + errs);

  console.log('\n========== 运行日志 E2E 结果 ==========');
  if (problems.length) {
    console.log('失败 ' + problems.length + ' 项：');
    problems.forEach((p) => console.log('  - ' + p));
    process.exitCode = 1;
  } else {
    console.log('全部通过');
  }
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E 运行失败：', e);
  process.exit(1);
});
