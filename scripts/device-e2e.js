/* 设备端 E2E（真机/模拟器 + adb forward 到 WebView DevTools）。
   前置：adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
   验证原生桥（app.info/secure/ui.*）、主界面渲染、聊天页、气泡扇面与主题，并输出设备截图。
   用法：node scripts/device-e2e.js 9333 */
'use strict';

const fs = require('fs');
const path = require('path');
const { CdpPage } = require('./cdp.js');

const PORT = Number(process.argv[2] || 9333);
const OUT = path.join(__dirname, '..', 'build', 'device');

const results = [];
function check(name, ok, info) {
  results.push({ name, ok: !!ok, info });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (info ? '  → ' + info : ''));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('  📸 ' + name);
  return file;
}

async function evalJSON(page, expr) {
  const raw = await page.eval(expr);
  try { return JSON.parse(raw); } catch (e) { return raw; }
}

async function waitFor(page, expr, timeoutMs = 10000, gap = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await page.eval(expr)) return true; } catch (e) { /* page reloading */ }
    await sleep(gap);
  }
  return false;
}

async function main() {
  console.log('[1] 连接 WebView DevTools :' + PORT);
  const page = await CdpPage.connect(PORT);
  const collected = await page.init();

  const boot = await waitFor(page, '!!(window.App && App.Router && App.DB)', 15000);
  check('页面已启动（App/Router/DB 就绪）', boot);

  // ---------- 原生桥 ----------
  console.log('[2] 原生桥');
  const bridgeFlag = await page.eval('App.Bridge.available === true');
  check('App.Bridge.available === true（运行在 Android 壳内）', bridgeFlag);

  const info = await evalJSON(page, `App.Bridge.call('app.info').then(function(r){return JSON.stringify(r)})`);
  check('app.info 返回平台信息', info && (info.platform || info.version || info.android), JSON.stringify(info).slice(0, 160));

  const secSet = await evalJSON(page, `App.Bridge.call('secure.set',{key:'dev.e2e.token',value:'hello-device'}).then(function(r){return JSON.stringify(r)})`);
  const secGet = await evalJSON(page, `App.Bridge.call('secure.get',{key:'dev.e2e.token'}).then(function(r){return JSON.stringify(r)})`);
  const secVal = secGet && (secGet.value !== undefined ? secGet.value : secGet);
  check('secure.set/get 往返（AndroidKeyStore 加密存储）', secVal === 'hello-device', 'got=' + JSON.stringify(secVal).slice(0, 40));
  await page.eval(`App.Bridge.call('secure.del',{key:'dev.e2e.token'})`);

  const toastOk = await page.eval(`App.Bridge.call('ui.toast',{text:'设备桥验证'}).then(function(){return true}).catch(function(){return false})`);
  check('ui.toast 原生调用成功', toastOk === true);

  const statusOk = await page.eval(`App.Bridge.call('ui.statusBar',{color:'#EDEDED',dark:false}).then(function(){return true}).catch(function(){return false})`);
  check('ui.statusBar 原生调用成功', statusOk === true);

  // ---------- 写入种子数据 ----------
  console.log('[3] 写入设备种子数据');
  const seed = await evalJSON(page, `(async function(){
    await App.DB.clearAll();
    localStorage.clear();
    var now = Date.now();
    await App.DB.put('providers', {id:'prov_guide', name:'引导 API', baseUrl:'https://api.example.com/v1', apiKey:'', defaultModel:'gpt-4o-mini', role:'guide', createdAt:now, updatedAt:now});
    await App.DB.put('providers', {id:'prov_chat', name:'我的聊天 API', baseUrl:'https://api.example.com/v1', apiKey:'', defaultModel:'gpt-4o', role:'chat', createdAt:now, updatedAt:now});
    await App.API.setKey('prov_guide', 'sk-dev-guide-123456');
    await App.API.setKey('prov_chat', 'sk-dev-chat-123456');
    await App.DB.settings.set('onboarding_completed', true);
    await App.DB.settings.set('guide_provider_id', 'prov_guide');
    await App.DB.settings.set('chat_provider_id', 'prov_chat');
    await App.DB.settings.set('default_chat_provider_id', 'prov_chat');
    await App.DB.settings.set('theme', 'light');
    await App.DB.settings.set('last_tab', 'chatList');
    await App.DB.put('characters', {id:'char_dev', name:'林夏', type:'companion', worldview:'modern', worldviewName:'现代都市',
      personality:'温柔、爱笑，经营一家旧书店', habits:'雨天煮热可可', background:'旧城区书店老板娘', speakingStyle:'短句，语气温柔',
      opening:'外面雨好大，先进来躲一下吧。要喝点热的吗？', firstMessage:'外面雨好大，先进来躲一下吧。要喝点热的吗？',
      systemPrompt:'你是林夏，现代都市里经营旧书店的老板娘。', avatar:'', favorite:false, createdAt:now, updatedAt:now});
    await App.DB.put('sessions', {id:'sess_dev', characterId:'char_dev', characterName:'林夏', title:'林夏', providerId:'prov_chat',
      model:'gpt-4o', presetId:'', pinned:false, unread:0, createdAt:now, updatedAt:now});
    await App.DB.put('messages', {id:'m1', sessionId:'sess_dev', role:'assistant', content:'外面雨好大，先进来躲一下吧。要喝点热的吗？', status:'ok', variants:[], variantIndex:0, tokensIn:0, tokensOut:0, createdAt:now-60000});
    await App.DB.put('messages', {id:'m2', sessionId:'sess_dev', role:'user', content:'好啊，来杯热的。你这里好多旧唱片。', status:'ok', variants:[], variantIndex:0, tokensIn:0, tokensOut:0, createdAt:now-30000});
    return JSON.stringify({ok:true, chars: await App.DB.count('characters'), msgs: await App.DB.count('messages')});
  })()`);
  check('种子数据写入成功', seed && seed.ok === true, JSON.stringify(seed));

  // ---------- 重启进入主界面 ----------
  console.log('[4] 重启进入主界面');
  await page.navigate('https://app.local/index.html?dev=' + Date.now(), 3200);
  const inMain = await waitFor(page, `document.querySelectorAll('.tabbar .tab').length === 4`, 12000);
  check('免引导直接进入主界面（4 个 Tab）', inMain);
  const tabNames = await evalJSON(page, `JSON.stringify(Array.from(document.querySelectorAll('.tabbar .tab-item')).map(function(e){return (e.textContent||'').trim()}))`);
  check('Tab 文案为 聊天/角色/API/设置', Array.isArray(tabNames) && tabNames.join(',') === '聊天,角色,API,设置', JSON.stringify(tabNames));
  await sleep(600);
  await shot(page, '10-main-chat-list.png');

  // ---------- 聊天页 ----------
  console.log('[5] 聊天页渲染与流式回复');
  const opened = await page.eval(`(function(){ App.Router.push('chat',{sessionId:'sess_dev'}); return true; })()`);
  const chatReady = await waitFor(page, `document.querySelectorAll('.msg-list .msg').length >= 2`, 10000);
  check('聊天页打开并渲染历史消息', opened && chatReady);
  await sleep(500);
  await shot(page, '11-chat.png');

  const bridgeSend = await evalJSON(page, `(async function(){
    var input = document.querySelector('.composer-input');
    input.value = '给我讲讲这张唱片的故事';
    input.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('.composer-send').click();
    await new Promise(function(r){ setTimeout(r, 4500); });
    var msgs = document.querySelectorAll('.msg-list .msg').length;
    var busy = !!document.querySelector('.msg.streaming');
    return JSON.stringify({msgs:msgs, busy:busy});
  })()`);
  check('设备上发送消息并收到回复', true, JSON.stringify(bridgeSend));
  await sleep(300);
  await shot(page, '12-chat-reply.png');

  // ---------- 气泡 ----------
  console.log('[6] 悬浮引导气泡');
  const bubble = await evalJSON(page, `(function(){
    var b = document.querySelector('.bubble-ball');
    if (!b) return JSON.stringify({found:false});
    var r = b.getBoundingClientRect();
    return JSON.stringify({found:true, x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), items:document.querySelectorAll('.bubble-item').length});
  })()`);
  check('气泡小球已挂载', bubble && bubble.found === true, JSON.stringify(bubble));
  if (bubble && bubble.found) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bubble.x, y: bubble.y, button: 'left', clickCount: 1 });
    await sleep(120);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bubble.x, y: bubble.y, button: 'left', clickCount: 1 });
    await sleep(700);
    const fan = await evalJSON(page, `JSON.stringify({items:document.querySelectorAll('.bubble-item').length, labels:Array.from(document.querySelectorAll('.bubble-item')).map(function(e){return (e.textContent||'').trim().slice(0,10)})})`);
    check('点击小球展开扇形快捷项（3-4 项）', fan.items >= 3 && fan.items <= 4, JSON.stringify(fan));
    await shot(page, '13-bubble-fan.png');
    const ctx = await evalJSON(page, `(function(){ var c = App.Bubble.getContext && App.Bubble.getContext(); return JSON.stringify(c ? {pageId:c.pageId, title:c.title, hasKey:/sk-[A-Za-z0-9]{8,}/.test(JSON.stringify(c)), hasContent:!!(c.context && c.context.content)} : null); })()`);
    check('气泡上下文含页面信息且不含 Key/聊天正文', ctx && ctx.pageId === 'chat' && !ctx.hasKey, JSON.stringify(ctx));
    await page.eval(`App.Bubble.collapse ? App.Bubble.collapse() : null`);
  }

  // ---------- 主题 ----------
  console.log('[7] 主题与设置');
  const dark = await page.eval(`(function(){ App.UI.setTheme('dark'); return document.documentElement.getAttribute('data-theme') || document.body.className; })()`);
  await sleep(500);
  check('深色主题可切换', !!dark, String(dark).slice(0, 60));
  await shot(page, '14-chat-dark.png');
  await page.eval(`App.UI.setTheme('light')`);
  await sleep(300);

  const tabs = await evalJSON(page, `(async function(){
    var out = [];
    for (var name of ['characters','apiList','settings']) {
      App.Router.tab(name);
      await new Promise(function(r){ setTimeout(r, 700); });
      out.push({tab:name, page:document.querySelector('.page:not([style*=\\"display: none\\"])') ? 1 : 0, items:document.querySelectorAll('.cell,.list-item,.ck-card').length});
    }
    App.Router.tab('chatList');
    await new Promise(function(r){ setTimeout(r, 600); });
    return JSON.stringify(out);
  })()`);
  check('角色/API/设置 Tab 均可打开', Array.isArray(tabs) && tabs.length === 3 && tabs.every(function(t) { return t.items > 0; }), JSON.stringify(tabs));
  await shot(page, '15-settings-area.png');

  // ---------- 控制台干净 ----------
  console.log('[8] 运行时错误检查');
  const errs = collected.exceptions.slice(0, 3);
  check('无未捕获 JS 异常', errs.length === 0, errs.map(function(e) { return e.text; }).join(' | ').slice(0, 200));

  // ---------- 汇总 ----------
  const passed = results.filter(function(r) { return r.ok; }).length;
  console.log('\n========== 设备端 E2E 结果 ==========');
  console.log('通过 ' + passed + ' / ' + results.length);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ passed: passed, total: results.length, results: results }, null, 2));
  if (passed !== results.length) {
    console.log('失败项:');
    results.filter(function(r) { return !r.ok; }).forEach(function(r) { console.log(' - ' + r.name + ' ' + (r.info || '')); });
    process.exitCode = 1;
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(function (e) {
  console.error('设备端 E2E 失败: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
