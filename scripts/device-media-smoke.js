#!/usr/bin/env node
/**
 * 设备端 v1.1.0 新功能冒烟：角色图片库、角色发图（[[img:ID]]）、动作斜体、上帝模式 prompt。
 * 依赖：adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
 * 用法: node scripts/device-media-smoke.js [cdpPort]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9333);
const SHOTS = path.join(__dirname, '..', 'build', 'device');
const PHOTO = path.join(__dirname, 'fixtures', 'sample-photo.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  \u2713 ' + m); }
function bad(m) { fail++; console.log('  \u2717 ' + m); }

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const png = 'data:image/png;base64,' + fs.readFileSync(PHOTO).toString('base64');
  const page = await CdpPage.connect(PORT);
  await page.init();
  console.log('[设备 v1.1.0 冒烟] 已连接 WebView');

  await page.eval(`(async () => { await App.DB.clearAll(); localStorage.clear(); return true; })()`);
  await page.navigate('https://app.local/index.html?fresh=' + Date.now(), 2500);

  const seed = await page.eval(`(async () => {
    var now = Date.now();
    await App.DB.put('providers', { id:'prov_mock', name:'设备 mock API', baseUrl:'http://127.0.0.1:8899/v1', apiKey:'', defaultModel:'mock-null-model', role:'chat', isDefault:true, createdAt:now, updatedAt:now });
    await App.API.setKey('prov_mock', 'sk-device-123456');
    await App.DB.settings.set('onboarding_completed', true);
    await App.DB.settings.set('chat_provider_id', 'prov_mock');
    await App.DB.settings.set('last_tab', 'chatList');
    await App.DB.settings.set('god_mode', true);
    await App.DB.put('characters', { id:'ch_demo', name:'林夏', type:'companion', personality:'开朗', firstMessage:'你好呀', createdAt:now, updatedAt:now });
    var img = await App.Media.addImage('ch_demo', { kind:'image', name:'海边照片.png', mime:'image/png', size:27710, dataUri:${JSON.stringify(png)} }, { caption:'海边' });
    await App.DB.put('sessions', { id:'sess_demo', characterId:'ch_demo', title:'林夏', providerId:'prov_mock', model:'mock-null-model', createdAt:now, updatedAt:now });
    await App.DB.put('messages', { id:'m1', sessionId:'sess_demo', role:'user', content:'发张照片看看', createdAt:now, updatedAt:now });
    await App.DB.put('messages', { id:'m2', sessionId:'sess_demo', role:'assistant', content:'*她低头笑了笑，把一张照片推到你面前*，说：「你看，这就是我说的海边。」\\n[[img:' + img.id + ']]\\n好看吧？', createdAt:now+1, updatedAt:now+1 });
    return { imgId: img.id, count: await App.Media.count('ch_demo') };
  })()`);

  await page.navigate('https://app.local/index.html?fresh=' + Date.now(), 3000);
  await page.eval(`(async () => { App.Router.push('chat', { sessionId:'sess_demo' }); return true; })()`);
  // 图片节点是异步加载的（先「图片加载中…」，拿到图片库记录后再换成 <img>），轮询等待
  let loaded = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const n = await page.eval(`document.querySelectorAll('.msg-image-img').length`);
    if (n > 0) { loaded = true; break; }
  }
  const view = await page.eval(`(async () => {
    var italic = document.querySelectorAll('.md-action').length;
    var images = document.querySelectorAll('.msg-image-img').length;
    var plain = document.querySelectorAll('.msg-image-missing').length;
    var gp = App.ChatKit.buildSystemPrompt({ name:'林夏', type:'companion' }, null, null, { godMode:true, images:[] });
    var gn = App.ChatKit.buildSystemPrompt({ name:'林夏', type:'companion' }, null, null, { godMode:false, images:[] });
    var html = document.querySelector('.msg-list') ? document.querySelector('.msg-list').innerHTML : '';
    return { italic:italic, images:images, missing:plain, leakedToken:html.indexOf('[[img:') >= 0, godPrompt:gp.indexOf('虚拟') >= 0, noGod:gn.indexOf('虚拟') < 0 };
  })()`);

  if (loaded && seed.count === 1) ok('角色图片库写入成功（count=' + seed.count + '）'); else bad('角色图片库写入失败 count=' + seed.count);
  if (view.italic > 0) ok('动作/神态渲染为斜体（.md-action n=' + view.italic + '）'); else bad('动作斜体未渲染');
  if (view.images > 0) ok('角色发图渲染为图片消息（n=' + view.images + '）'); else bad('角色发图未渲染');
  if (view.missing === 0) ok('图片不可用占位未误报（n=0）'); else bad('误报图片不可用 n=' + view.missing);
  if (!view.leakedToken) ok('不泄漏 [[img:ID]] 原始标记'); else bad('泄漏了 [[img:ID]] 标记');
  if (view.godPrompt) ok('上帝模式开启时 system prompt 含「虚拟」'); else bad('上帝模式 prompt 未注入');
  if (view.noGod) ok('上帝模式关闭时 system prompt 不含「虚拟」'); else bad('上帝模式关闭时 prompt 仍含「虚拟」');

  await sleep(500);
  await page.screenshot(path.join(SHOTS, '21-media-god.png'), { width: 390, height: 844 });
  console.log('\n[设备 v1.1.0 冒烟] 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
