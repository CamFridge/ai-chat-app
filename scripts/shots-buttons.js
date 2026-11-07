/* 按键自适应检查：在 320/360/390 三档宽度下截图关键页面的底部按钮区
 * 用法：node scripts/shots-buttons.js 9222 http://127.0.0.1:8321
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { CdpPage } = require('./cdp.js');

const CDP_PORT = Number(process.argv[2] || 9222);
const APP_URL = (process.argv[3] || 'http://127.0.0.1:8321').replace(/\/$/, '');
const ORIGIN = new URL(APP_URL).origin;
const OUT = path.join(__dirname, '..', 'build', 'shots-buttons');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SEED = `
(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await App.DB.clearAll(); localStorage.clear();
  await wait(120);
  const now = Date.now();
  await App.DB.put('providers', { id:'prov_guide', name:'示例引导 API', baseUrl:'https://api.example.com/v1', defaultModel:'gpt-4o-mini', role:'guide', isDefault:false, createdAt: now });
  await App.DB.put('providers', { id:'prov_chat', name:'我的聊天 API', baseUrl:'https://api.example.com/v1', defaultModel:'gpt-4o', role:'chat', isDefault:true, createdAt: now });
  await App.DB.put('characters', { id:'char_btn', name:'林夏', type:'companion', gender:'female', personality:'开朗直率', habits:'爱聊吃的', background:'旧书店店员', worldviewId:'', firstMessage:'今天也来啦？', alternateGreetings:['备选一：我带了吃的。'], scenarios:['雨夜的书店'], scenario:'雨夜的书店', systemPrompt:'', avatar:'', godMode:false, fieldOrigin:{}, createdAt: now, updatedAt: now });
  await App.DB.put('sessions', { id:'sess_btn', characterId:'char_btn', title:'林夏', providerId:'prov_chat', model:'gpt-4o', presetId:'', personaId:'', greetingIndex:0, scene:'', unread:0, lastText:'今天也来啦？', lastRole:'assistant', lastAt: now, createdAt: now, updatedAt: now });
  await App.DB.put('messages', { id:'m1', sessionId:'sess_btn', role:'assistant', content:'今天也来啦？', status:'ok', createdAt: now, updatedAt: now, variants:[], variantIndex:0 });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('last_tab', 'chatList');
  return 'seeded';
})()
`;

(async () => {
  const page = await CdpPage.connect(CDP_PORT);
  await page.init();
  await page.navigate('about:blank', 200);
  try { await page.clearStorage(ORIGIN); } catch (e) {}
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 2600);
  await page.eval(SEED);
  await page.navigate(APP_URL + '/index.html?seed=' + Date.now(), 3200);
  await sleep(800);

  const widths = [320, 360, 390];
  for (const w of widths) {
    const h = w === 320 ? 700 : 800;
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    await shot(page, w, '01-settings', async () => {
      await page.eval(`App.Router.tab('settings')`);
      await sleep(500);
    });
    await shot(page, w, '02-create-step1', async () => {
      await page.eval(`App.Router.push('characterCreate', {}, {})`);
      await sleep(700);
    });
    await shot(page, w, '03-create-step3', async () => {
      await page.eval(`(() => {
        var b = Array.from(document.querySelectorAll('.ck-wizard-foot .btn')).filter(function (e) { return (e.textContent || '').indexOf('下一步') >= 0; })[0];
        if (b) b.click();
        return true;
      })()`);
      await sleep(500);
      await page.eval(`(() => {
        var b = Array.from(document.querySelectorAll('.ck-wizard-foot .btn')).filter(function (e) { return (e.textContent || '').indexOf('下一步') >= 0; })[0];
        if (b) b.click();
        return true;
      })()`);
      await sleep(600);
      await page.eval(`(() => {
        var inputs = document.querySelectorAll('.ck-wizard-body .form input, .ck-wizard-body .form textarea');
        if (inputs[0]) { inputs[0].value = '林夏'; inputs[0].dispatchEvent(new Event('input', { bubbles: true })); inputs[0].dispatchEvent(new Event('change', { bubbles: true })); }
        if (inputs[1]) { inputs[1].value = '开朗直率'; inputs[1].dispatchEvent(new Event('input', { bubbles: true })); inputs[1].dispatchEvent(new Event('change', { bubbles: true })); }
        return true;
      })()`);
      await sleep(300);
    });
    await shot(page, w, '04-chat', async () => {
      await page.eval(`App.Router.push('chat', { sessionId: 'sess_btn' }, {})`);
      await sleep(800);
    });
    await shot(page, w, '05-greeting-sheet', async () => {
      await page.eval(`(() => {
        var b = Array.from(document.querySelectorAll('.nav-action')).filter(function (e) { return (e.getAttribute('aria-label') || '').indexOf('菜单') >= 0 || (e.textContent || '').indexOf('⋯') >= 0; })[0];
        if (b) b.click();
        return true;
      })()`);
      await sleep(400);
      await page.eval(`(() => {
        var it = Array.from(document.querySelectorAll('.sheet-item')).filter(function (e) { return (e.textContent || '').indexOf('开场白') >= 0; })[0];
        if (it) it.click();
        return true;
      })()`);
      await sleep(500);
    });
  }

  await page.send('Emulation.clearDeviceMetricsOverride');
  console.log('截图目录：' + OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

async function shot(page, w, name, prep) {
  try { await prep(); } catch (e) {}
  await sleep(250);
  const file = path.join(OUT, w + '-' + name + '.png');
  await page.screenshot(file, { width: w, height: w === 320 ? 700 : 800 });
  console.log('✓ ' + file);
}
