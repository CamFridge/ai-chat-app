/* 无头 Chrome 冒烟测试 + 截图（开发期验证，不进入 APK）。
   先启动：node scripts/preview-server.js 8321
   再启动 Chrome：chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<tmp> about:blank
   然后：node scripts/audit.js [cdpPort] [baseUrl] [outDir] */
'use strict';
const path = require('path');
const { CdpPage } = require('./cdp');

const port = Number(process.argv[2] || 9222);
const base = process.argv[3] || 'http://127.0.0.1:8321';
const outDir = path.resolve(process.argv[4] || path.join(__dirname, '..', 'build', 'shots'));
const origin = new URL(base).origin;

const issues = [];
const shots = [];

function log(...a) { console.log(...a); }
function fail(msg) { issues.push(msg); console.log('  ✗ ' + msg); }
function ok(msg) { console.log('  ✓ ' + msg); }

const SEED = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(window.App && App.DB && App.Router); i++) await wait(50);
  if (!window.App) return { ok: false, reason: 'App 未加载' };
  await App.DB.ready;
  const now = Date.now();
  const guide = { id: 'prov_guide', name: '示例引导 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o-mini', role: 'guide', params: { temperature: 0.8 }, createdAt: now, updatedAt: now, isBuiltin: false };
  const chat = { id: 'prov_chat', name: '示例聊天 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', role: 'chat', params: { temperature: 0.9, max_tokens: 1024 }, createdAt: now + 1, updatedAt: now + 1, isBuiltin: false };
  await App.DB.put('providers', guide);
  await App.DB.put('providers', chat);
  await App.Bridge.call('secure.set', { key: 'key:' + guide.id, value: 'sk-demo-guide-123456' });
  await App.Bridge.call('secure.set', { key: 'key:' + chat.id, value: 'sk-demo-chat-123456' });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', guide.id);
  await App.DB.settings.set('chat_provider_id', chat.id);
  await App.DB.settings.set('last_tab', 'chatList');
  await App.DB.settings.set('theme', 'light');
  await App.DB.put('presets', { id: 'preset_demo', name: '演示预设', mode: 'chat', appliesTo: 'both', instructTemplate: '', params: { temperature: 0.8, top_p: 1, max_tokens: 2000 }, isBuiltin: false, createdAt: now + 2, updatedAt: now + 2 });
  return { ok: true };
})()`;

async function main() {
  const page = await CdpPage.connect(port);
  const collected = await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });

  log('\n[1] 全新状态 → 首次启动引导');
  await page.clearStorage(origin);
  await page.navigate(base + '/index.html', 2200);
  // clearDataForOrigin 可能因连接占用延迟生效：再在页面内清一遍，保证是「全新安装」
  await page.eval(`(async () => { try { await App.DB.clearAll(); } catch (e) {} try { localStorage.clear(); } catch (e) {} return true; })()`).catch(() => {});
  await page.navigate(base + '/index.html?fresh=' + Date.now(), 2200);
  const boot1 = await page.eval(`(function(){
    return {
      title: document.title,
      app: !!window.App,
      router: !!(window.App && App.Router),
      page: window.App && App.Router && App.Router.current && App.Router.current() ? App.Router.current().name : null,
      bodyChildren: document.querySelectorAll('#page-root .page').length,
      visibleText: (document.querySelector('#page-root')||document.body).innerText.slice(0, 200)
    };
  })()`);
  log('   ', JSON.stringify(boot1));
  if (!boot1.app) fail('App 未初始化');
  if (boot1.page !== 'onboarding') fail('首次启动未进入 onboarding，实际: ' + boot1.page);
  else ok('首次启动进入 onboarding');
  shots.push(await page.screenshot(path.join(outDir, '01-onboarding.png')));

  log('\n[2] 写入种子数据后重载 → 主界面');
  const seeded = await page.eval(SEED);
  log('    seed:', JSON.stringify(seeded));
  if (!seeded || !seeded.ok) fail('种子数据写入失败');
  await page.navigate(base + '/index.html', 2500);
  const boot2 = await page.eval(`(function(){
    const cur = window.App && App.Router.current();
    return {
      page: cur ? cur.name : null,
      tabbar: !!document.querySelector('#tabbar'),
      tabs: Array.from(document.querySelectorAll('#tabbar .tab, #tabbar [data-tab]')).map(e => e.textContent.trim()),
      text: (document.querySelector('#page-root')||document.body).innerText.slice(0, 300)
    };
  })()`);
  log('   ', JSON.stringify(boot2));
  if (boot2.page !== 'chatList') fail('重载后未进入主界面 chatList，实际: ' + boot2.page);
  else ok('进入主界面 chatList');
  shots.push(await page.screenshot(path.join(outDir, '02-chat-list.png')));

  log('\n[3] 四个 Tab 逐个截图');
  for (const [name, file] of [['characters', '03-characters.png'], ['apiList', '04-api-list.png'], ['settings', '05-settings.png'], ['chatList', '06-chat-list-again.png']]) {
    try {
      await page.eval(`(async () => { await App.Router.tab(${JSON.stringify(name)}); await new Promise(r=>setTimeout(r,450)); })()`);
      const cur = await page.eval(`App.Router.current().name`);
      if (cur !== name) fail('切换到 ' + name + ' 失败，当前 ' + cur);
      else ok('Tab ' + name);
      shots.push(await page.screenshot(path.join(outDir, file)));
    } catch (e) {
      fail('Tab ' + name + ' 出错: ' + e.message);
    }
  }

  log('\n[4] 二级页面逐个打开截图');
  const subpages = [
    ['worldviews', {}, '07-worldviews.png'],
    ['apiEdit', { id: 'prov_chat' }, '08-api-edit.png'],
    ['characterCreate', {}, '09-character-create.png'],
    ['presetEdit', { id: 'preset_demo' }, '10-preset-edit.png'],
    ['about', {}, '11-about.png'],
    ['help', {}, '12-help.png']
  ];
  for (const [name, params, file] of subpages) {
    try {
      const has = await page.eval(`App.Router.has(${JSON.stringify(name)})`);
      if (!has) { fail('页面未注册: ' + name); continue; }
      await page.eval(`(async () => { await App.Router.push(${JSON.stringify(name)}, ${JSON.stringify(params)}); await new Promise(r=>setTimeout(r,500)); })()`);
      const cur = await page.eval(`App.Router.current().name`);
      if (cur !== name) fail('打开 ' + name + ' 失败，当前 ' + cur);
      else ok('页面 ' + name);
      shots.push(await page.screenshot(path.join(outDir, file)));
      await page.eval(`(async () => { await App.Router.pop(); await new Promise(r=>setTimeout(r,250)); })()`);
    } catch (e) {
      fail('页面 ' + name + ' 出错: ' + e.message);
      try { await page.eval(`(async () => { await App.Router.pop(); })()`); } catch (e2) {}
    }
  }

  log('\n[5] 引导气泡 & 帮助');
  try {
    const bubble = await page.eval(`(function(){
      if (!App.Bubble) return { mounted: false, reason: 'App.Bubble 不存在' };
      const el = document.querySelector('.bubble-root, #bubble-root');
      return { mounted: !!el, html: el ? el.outerHTML.slice(0, 200) : null };
    })()`);
    log('    bubble:', JSON.stringify(bubble));
    if (!bubble.mounted) fail('引导气泡未挂载');
    shots.push(await page.screenshot(path.join(outDir, '13-bubble.png')));
  } catch (e) { fail('气泡检查出错: ' + e.message); }

  log('\n[6] 控制台错误汇总');
  const errs = collected.consoleMsgs.filter((m) => m.level === 'error');
  const warns = collected.consoleMsgs.filter((m) => m.level === 'warning');
  if (errs.length) {
    for (const e of errs) fail('console.error: ' + e.text);
  } else ok('无 console.error');
  if (collected.exceptions.length) {
    for (const e of collected.exceptions) fail('未捕获异常: ' + e.text + ' @' + (e.url || '') + ':' + (e.line || 0));
  } else ok('无未捕获异常');
  if (warns.length) log('  warnings:', warns.map((w) => w.text.slice(0, 160)).join(' | '));

  log('\n截图:');
  for (const s of shots) log('  ' + s);
  log('\n结果: ' + (issues.length ? issues.length + ' 个问题' : '全部通过'));
  process.exit(issues.length ? 2 : 0);
}

main().catch((e) => { console.error('审计脚本异常:', e); process.exit(3); });
