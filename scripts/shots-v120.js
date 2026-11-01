/* 生成 v1.2.0 视觉截图（开发期脚本，不进 APK）
   用法：node scripts/shots-v120.js 9222 http://127.0.0.1:8321 */
'use strict';
const path = require('path');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9222);
const APP_URL = process.argv[3] || 'http://127.0.0.1:8321';
const SHOTS = path.join(__dirname, '..', 'build', 'shots');
const ORIGIN = new URL(APP_URL).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(window.App && App.DB && App.Router); i++) await wait(50);
  await App.DB.ready;
  const now = Date.now();
  await App.DB.put('providers', { id: 'prov_guide', name: '示例引导 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o-mini', role: 'guide', createdAt: now, updatedAt: now });
  await App.DB.put('providers', { id: 'prov_chat', name: '我的聊天 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o', role: 'chat', createdAt: now + 1, updatedAt: now + 1 });
  await App.Bridge.call('secure.set', { key: 'key:prov_guide', value: 'sk-demo-guide-123456' });
  await App.Bridge.call('secure.set', { key: 'key:prov_chat', value: 'sk-demo-chat-123456' });
  await App.DB.put('characters', {
    id: 'char_g', type: 'companion', name: '林夏', avatar: '', worldviewId: 'wv-modern',
    personality: '开朗直率', habits: '爱聊吃的', background: '旧城区书店店员', speechStyle: '短句、语气轻快', catchphrases: '',
    scenario: '', firstMessage: '首选问候：今天也来啦？', alternateGreetings: ['备选一：我带了你爱吃的。', '备选二：外面下雨了，进来躲躲？'],
    exampleDialogues: [], systemPrompt: '', domain: '', specialty: [], duties: [], answerStyle: '', knowledgeBoundary: '', refusalPolicy: '',
    draft: {}, fieldOrigin: {}, generatedAt: now, createdAt: now, updatedAt: now
  });
  await App.DB.put('sessions', { id: 'sess_g0', title: '林夏', characterId: 'char_g', personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_chat', pinned: false, unread: 0, greetingIndex: 0, updatedAt: now, createdAt: now });
  await App.DB.put('messages', { id: 'mg1', sessionId: 'sess_g0', role: 'assistant', content: '首选问候：今天也来啦？', variantIndex: 0, isActive: true, status: 'ok', createdAt: now + 1 });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('chat_provider_id', 'prov_chat');
  await App.DB.settings.set('last_tab', 'settings');
  await App.DB.settings.set('theme', 'light');
  await App.DB.settings.set('proactive_enabled', true);
  await App.DB.settings.set('proactive_interval_min', 30);
  return { ok: true };
})()`;

(async () => {
  const page = await CdpPage.connect(PORT);
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });

  await page.navigate('about:blank', 300);
  await page.clearStorage(ORIGIN);
  await page.navigate(APP_URL + '/index.html', 900);
  for (let i = 0; i < 60; i++) { try { if (await page.eval('!!(window.App && App.DB)')) break; } catch (e) {} await sleep(150); }
  await page.eval(`(async () => { try { await App.DB.clearAll(); } catch (e) {} try { localStorage.clear(); } catch (e) {} return true; })()`);
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 900);
  for (let i = 0; i < 60; i++) { try { if (await page.eval('!!(window.App && App.DB)')) break; } catch (e) {} await sleep(150); }
  await page.eval(SEED);
  await page.navigate(APP_URL + '/index.html?seed=' + Date.now(), 1800);
  for (let i = 0; i < 60; i++) { try { if (await page.eval('!!(window.App && App.Router && App.Router.current())')) break; } catch (e) {} await sleep(150); }

  // 1. 设置页：角色主动消息分组
  await page.eval(`(async () => { await App.Router.tab('settings'); await new Promise(r => setTimeout(r, 800)); return true; })()`);
  await page.eval(`(() => { const row = document.querySelector('[data-guide-focus="proactive"]'); if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' }); return 'ok'; })()`);
  await sleep(500);
  await page.screenshot(path.join(SHOTS, '93-settings-proactive.png'));

  // 2. 角色编辑：问候语入口 + 弹窗
  await page.eval(`(async () => { await App.Router.push('characterEdit', { id: 'char_g' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  await sleep(400);
  await page.eval(`(() => { const row = document.querySelector('[data-guide-focus="greetings"]'); if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' }); return 'ok'; })()`);
  await sleep(500);
  await page.screenshot(path.join(SHOTS, '94-greeting-entry.png'));
  await page.eval(`(() => { const row = document.querySelector('[data-guide-focus="greetings"]'); if (row) row.click(); return 'ok'; })()`);
  await sleep(700);
  await page.screenshot(path.join(SHOTS, '95-greeting-modal.png'));
  await page.eval(`(() => { const btns = Array.from(document.querySelectorAll('.modal button')); const b = btns.find(x => (x.textContent || '').trim() === '取消'); if (b) b.click(); return 'ok'; })()`);
  await sleep(400);

  // 3. 聊天页：问候语气泡（首选）
  await page.eval(`(async () => { await App.Router.push('chat', { sessionId: 'sess_g0' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  await sleep(400);
  await page.screenshot(path.join(SHOTS, '96-chat-greeting.png'));

  console.log('截图完成: 93-settings-proactive / 94-greeting-entry / 95-greeting-modal / 96-chat-greeting');
  process.exit(0);
})().catch((e) => { console.error(e && (e.stack || e.message || e)); process.exit(1); });
