/* 补充截图：聊天页（长会话）、暗色 / AMOLED 主题、气泡展开、引导抽屉。
   开发期验证脚本，不进入 APK。
   用法：node scripts/shots-extra.js [cdpPort] [baseUrl] */
'use strict';
const path = require('path');
const { CdpPage } = require('./cdp');

const port = Number(process.argv[2] || 9222);
const base = process.argv[3] || 'http://127.0.0.1:8321';
const outDir = path.resolve(path.join(__dirname, '..', 'build', 'shots-extra'));
const origin = new URL(base).origin;

const SEED = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(window.App && App.DB && App.Router); i++) await wait(50);
  if (!window.App) return { ok: false, reason: 'App 未加载' };
  await App.DB.ready;
  await App.DB.clearAll();
  try { localStorage.clear(); } catch (e) {}
  const now = Date.now();
  const guide = { id: 'prov_guide', name: '示例引导 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o-mini', role: 'guide', createdAt: now, updatedAt: now };
  const chat = { id: 'prov_chat', name: '示例聊天 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', role: 'chat', createdAt: now + 1, updatedAt: now + 1 };
  await App.DB.put('providers', guide);
  await App.DB.put('providers', chat);
  await App.Bridge.call('secure.set', { key: 'key:prov_guide', value: 'sk-demo-guide-123456' });
  await App.Bridge.call('secure.set', { key: 'key:prov_chat', value: 'sk-demo-chat-123456' });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('last_tab', 'chatList');
  await App.DB.settings.set('theme', 'light');
  await App.DB.settings.set('bubble_enabled', true);

  const char = {
    id: 'char_linxia', type: 'companion', name: '林夏', avatar: '',
    worldviewId: 'wv_modern', worldviewSnapshot: null,
    personality: '开朗直率，爱开玩笑，偶尔有点小别扭', habits: '喜欢在深夜聊吃的，会在句末加「啦」',
    background: '在一家独立书店做店长，周末去旧货市场淘唱片', speechStyle: '轻松口语，句子短，偶尔用表情',
    catchphrases: '', scenario: '雨天书店打烊后，你推门进来躲雨',
    firstMessage: '外面雨好大，先进来躲一下吧。要喝点热的吗？',
    exampleDialogues: [], systemPrompt: '', domain: '', specialty: [], duties: [],
    answerStyle: '', knowledgeBoundary: '', refusalPolicy: '',
    draft: {}, fieldOrigin: {}, generatedAt: now, createdAt: now, updatedAt: now
  };
  await App.DB.put('characters', char);

  const sess = {
    id: 'sess_demo', title: '林夏', characterId: char.id, personaId: '', presetId: 'builtin_companion',
    model: 'gpt-4o', providerId: 'prov_chat', pinned: false, updatedAt: now + 20, createdAt: now
  };
  await App.DB.put('sessions', sess);

  const lines = [
    ['assistant', '外面雨好大，先进来躲一下吧。要喝点热的吗？'],
    ['user', '好啊，来杯热的。你这里好多旧唱片。'],
    ['assistant', '都是二手市场淘的，那张蓝色封面的有三十年啦。\\n你要不要听听看？'],
    ['user', '听着像故事，讲讲？'],
    ['assistant', '老板说它原来的主人是个开夜班出租的，每晚收车都要放一遍。\\n后来车卖了，唱片留在了店里。']
  ];
  let i = 0;
  for (const [role, content] of lines) {
    await App.DB.put('messages', {
      id: 'm_' + (++i), sessionId: sess.id, role, content, variantIndex: 0, isActive: true,
      status: 'ok', errorText: '', tokensIn: 0, tokensOut: 0, createdAt: now + i
    });
  }
  return { ok: true };
})()`;

function log(...a) { console.log(...a); }

async function shoot(page, file) {
  const p = await page.screenshot(path.join(outDir, file));
  log('  ✓', file);
  return p;
}

async function main() {
  const page = await CdpPage.connect(port);
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });

  log('[1] 重置并写入角色 / 会话 / 消息');
  await page.navigate('about:blank', 300);
  await page.clearStorage(origin);
  await page.navigate(base + '/index.html', 2200);
  await page.eval(`(async () => { try { await App.DB.clearAll(); localStorage.clear(); } catch (e) {} return true; })()`);
  await page.navigate(base + '/index.html?fresh=' + Date.now(), 2200);
  const se = await page.eval(SEED);
  log('   seed:', JSON.stringify(se));

  log('[2] 打开聊天页（长会话）');
  await page.eval(`(async () => { await App.Router.push('chat', { sessionId: 'sess_demo' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  await shoot(page, '01-chat-light.png');

  log('[3] 气泡展开');
  const ball = await page.eval(`(function(){ var b=document.querySelector('.bubble-ball'); if(!b) return null; var r=b.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
  if (ball) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ball.x, y: ball.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ball.x, y: ball.y, button: 'left', clickCount: 1 });
  }
  await new Promise((r) => setTimeout(r, 900));
  await shoot(page, '02-bubble-fan.png');
  // 点遮罩收起
  await page.eval(`(function(){ var m=document.querySelector('.bubble-mask'); if(m) m.click(); return !!m; })()`);
  await new Promise((r) => setTimeout(r, 400));

  log('[4] 引导抽屉');
  await page.eval(`(function(){ App.Help.open({ source: 'settings_help', page: 'settings' }); return true; })()`);
  await new Promise((r) => setTimeout(r, 700));
  await shoot(page, '03-help-drawer.png');
  await page.eval(`(function(){ if (App.Help && App.Help.close) App.Help.close(); return true; })()`);
  await new Promise((r) => setTimeout(r, 500));

  log('[5] 暗色主题');
  await page.eval(`(async () => { await App.UI.setTheme('dark'); await new Promise(r => setTimeout(r, 500)); return true; })()`);
  await shoot(page, '04-chat-dark.png');
  await page.eval(`(async () => { await App.Router.tab('settings'); await new Promise(r => setTimeout(r, 700)); return true; })()`);
  await shoot(page, '05-settings-dark.png');

  log('[6] AMOLED 纯黑主题');
  await page.eval(`(async () => { await App.UI.setTheme('amoled'); await App.Router.tab('chatList'); await new Promise(r => setTimeout(r, 700)); return true; })()`);
  await shoot(page, '06-chat-list-amoled.png');
  await page.eval(`(async () => { await App.Router.push('chat', { sessionId: 'sess_demo' }); await new Promise(r => setTimeout(r, 800)); return true; })()`);
  await shoot(page, '07-chat-amoled.png');

  log('[7] 恢复浅色');
  await page.eval(`(async () => { await App.UI.setTheme('light'); return true; })()`);

  log('\n截图目录:', outDir);
  process.exit(0);
}

main().catch((e) => { console.error('失败:', e && e.stack || e); process.exit(1); });
