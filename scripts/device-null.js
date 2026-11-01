#!/usr/bin/env node
/**
 * 设备端 null 回归验证（Android WebView + 真机桥 + mock SSE 服务）。
 * 依赖：adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
 *       node scripts/mock-sse-server.js 8899
 * 用法: node scripts/device-null.js [cdpPort]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9333);
const SHOTS = path.join(__dirname, '..', 'build', 'device');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log('  \u2713 ' + msg); }
function bad(msg) { fail++; console.log('  \u2717 ' + msg); }

async function waitFor(page, expr, timeout = 15000, interval = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await page.eval(expr)) return true; } catch (e) { /* ignore */ }
    await sleep(interval);
  }
  return false;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const page = await CdpPage.connect(PORT);
  await page.init();
  console.log('[设备 null 回归] 连接 WebView 成功');

  await page.eval(`(async () => {
    await App.DB.clearAll();
    localStorage.clear();
    return true;
  })()`);
  await page.navigate('https://app.local/index.html?fresh=' + Date.now(), 2500);

  await page.eval(`(async () => {
    const now = Date.now();
    await App.DB.put('providers', {
      id: 'prov_mock', name: '设备 mock API', baseUrl: 'http://10.0.2.2:8899/v1',
      apiKey: '', defaultModel: 'mock-null-model', role: 'chat', isDefault: true,
      createdAt: now, updatedAt: now
    });
    await App.API.setKey('prov_mock', 'sk-device-123456');
    await App.DB.settings.set('onboarding_completed', true);
    await App.DB.settings.set('chat_provider_id', 'prov_mock');
    await App.DB.settings.set('last_tab', 'chatList');
    return true;
  })()`);
  await page.navigate('https://app.local/index.html?fresh=' + Date.now(), 2500);

  // 1) 桥接层直连 mock SSE：delta.content 里混入 null，正文不能出现 "null"
  const raw = await page.eval(`(async () => {
    const provider = await App.DB.get('providers', 'prov_mock');
    let deltas = '';
    const r = await new Promise((resolve) => {
      let text = '';
      const h = App.API.chatStream({
        provider: provider,
        model: 'mock-null-model',
        messages: [{ role: 'user', content: '你好' }],
        params: { temperature: 0.5, max_tokens: 100 },
        timeoutMs: 20000,
        onDelta: function (piece) { text += piece; deltas += piece; },
        onDone: function (d) { resolve({ ok: true, text: d && d.text, deltas: text }); },
        onError: function (e) { resolve({ ok: false, error: e, deltas: text }); }
      });
      window.__h = h;
      setTimeout(function () { try { h.abort(); } catch (e) {} resolve({ ok: false, error: { code: 'timeout' }, deltas: text }); }, 18000);
    });
    return r;
  })()`);
  if (raw && raw.ok && /你好/.test(raw.text || '') && !/null/.test(raw.deltas || '')) {
    ok('桥接层：正文「' + String(raw.text).trim() + '」，增量无 "null"');
  } else {
    bad('桥接层 null 回归失败：' + JSON.stringify(raw));
  }

  // 2) UI 层：建角色 + 会话，真实发送一条消息，气泡中不能出现 null
  const ui = await page.eval(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const now = Date.now();
    const char = { id: 'char_mock', name: '小测', type: 'companion', worldviewId: '', worldviewName: '', persona: '', personality: '测试', background: '', speechStyle: '', scenario: '', firstMessage: '', exampleDialogues: '', systemPrompt: '你是测试角色。', fieldOrigin: {}, createdAt: now, updatedAt: now };
    await App.DB.put('characters', char);
    await App.DB.put('sessions', { id: 'sess_mock', characterId: 'char_mock', title: '小测', providerId: 'prov_mock', model: 'mock-null-model', presetId: '', personaId: '', pinned: false, unread: 0, isGenerating: false, lastMessage: '', createdAt: now, updatedAt: now });
    await App.Router.push('chat', { sessionId: 'sess_mock' });
    for (let i = 0; i < 50 && !document.querySelector('[data-guide-focus="composer"]'); i++) await wait(100);
    const inp = document.querySelector('[data-guide-focus="composer"]');
    const proto = inp.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(inp, '设备端测试');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(150);
    document.querySelector('[data-guide-tap="send"]').click();
    for (let i = 0; i < 120; i++) {
      const send = document.querySelector('[data-guide-tap="send"]');
      const done = send && (send.textContent || '').indexOf('发送') >= 0;
      const bubbles = document.querySelectorAll('.msg.ai .msg-bubble');
      if (done && bubbles.length > 0 && (bubbles[bubbles.length - 1].innerText || '').length > 3 && i > 6) break;
      await wait(200);
    }
    const bubbles = Array.from(document.querySelectorAll('.msg.ai .msg-bubble')).map(x => x.innerText || '');
    const last = bubbles[bubbles.length - 1] || '';
    const all = document.body.innerText || '';
    const msgs = await App.DB.byIndex('messages', 'sessionId', 'sess_mock');
    return { last: last, count: msgs.length, hasNullInBubbles: /null/.test(bubbles.join('\n')), saved: (msgs[msgs.length - 1] || {}) };
  })()`);
  if (ui && !ui.hasNullInBubbles && /你好/.test(ui.last)) ok('UI 层：气泡正文「' + ui.last.trim() + '」无 null');
  else bad('UI 层 null 回归失败：' + JSON.stringify(ui));
  if (ui && ui.count >= 2) ok('设备端消息已落库（' + ui.count + ' 条）');
  else bad('设备端消息未落库：' + JSON.stringify(ui && { count: ui.count }));

  await page.screenshot(path.join(SHOTS, '20-null-regression.png'));
  console.log('');
  console.log('[设备 null 回归] 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
