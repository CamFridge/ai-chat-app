/* 设备端 v1.2.0 冒烟：主动消息本地通知 + 问候语（需先安装 debug 包并 adb forward CDP）
   前置：
     adb shell pm grant com.aichat.client android.permission.POST_NOTIFICATIONS
     adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
   用法：node scripts/device-proactive.js 9333
*/
'use strict';
const path = require('path');
const { CdpPage } = require('./cdp');

const PORT = Number(process.argv[2] || 9333);
const SHOTS = path.join(__dirname, '..', 'build', 'device');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const ok = (m, extra) => console.log('  \u2713 ' + m + (extra ? '  \u2192 ' + JSON.stringify(extra) : ''));
const bad = (m, extra) => { problems.push(m); console.log('  \u2717 ' + m + (extra ? '  \u2192 ' + JSON.stringify(extra) : '')); };

async function evalJson(page, expr) {
  const raw = await page.eval(`(async () => { try { return JSON.stringify(await (async () => (${expr}))()); } catch (e) { return JSON.stringify({ __error: String(e && e.message || e) }); } })()`);
  try { return JSON.parse(raw); } catch (e) { return { __error: 'parse: ' + String(raw).slice(0, 120) }; }
}

async function waitFor(page, expr, timeoutMs = 8000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await page.eval(expr)) return true; } catch (e) {}
    await sleep(intervalMs);
  }
  return false;
}

(async () => {
  const page = await CdpPage.connect(PORT);
  await page.init();
  console.log('[设备冒烟] v1.2.0 主动消息 + 问候语');

  // 1. 原生通知桥
  const status = await evalJson(page, `App.Bridge.call('notify.status')`);
  if (status && status.permission) ok('notify.status 返回', status);
  else bad('notify.status 异常', status);

  const sched = await evalJson(page, `App.Bridge.call('notify.schedule', { delayMs: 2500, title: 'AI 聊天', body: '设备端主动消息测试' })`);
  if (sched && sched.ok !== false) ok('notify.schedule 调用成功', sched);
  else bad('notify.schedule 失败', sched);
  await sleep(5000);
  // 通知是否真的发出，由调用方用 adb shell dumpsys notification 校验（本脚本只保证桥调用成功）
  const cancel = await evalJson(page, `App.Bridge.call('notify.cancel')`);
  if (cancel && cancel.ok !== false) ok('notify.cancel 调用成功', cancel);
  else bad('notify.cancel 失败', cancel);

  // 2. 问候语数据与聊天页「换个开场白」入口
  const seed = await evalJson(page, `(async () => {
    await App.DB.put('characters', {
      id: 'char_dev_greet', type: 'companion', name: '林夏', avatar: '', worldviewId: 'wv-modern',
      personality: '开朗直率', habits: '爱聊吃的', background: '', speechStyle: '', catchphrases: '', scenario: '',
      firstMessage: '设备首选问候：今天也来啦？', alternateGreetings: ['设备备选一：带了你爱吃的。', '设备备选二：进来躲躲雨？'],
      exampleDialogues: [], systemPrompt: '', fieldOrigin: {}, generatedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now()
    });
    await App.DB.put('sessions', { id: 'sess_dev_greet', title: '林夏', characterId: 'char_dev_greet', personaId: '', presetId: '', model: 'gpt-4o', providerId: 'prov_mock', pinned: false, unread: 0, greetingIndex: 0, updatedAt: Date.now(), createdAt: Date.now() });
    await App.DB.put('messages', { id: 'mdev1', sessionId: 'sess_dev_greet', role: 'assistant', content: '设备首选问候：今天也来啦？', variantIndex: 0, isActive: true, status: 'ok', createdAt: Date.now() });
    return { ok: true };
  })()`);
  if (seed && seed.ok) ok('写入设备问候语种子数据');
  else bad('种子数据写入失败', seed);

  await page.eval(`(async () => { await App.Router.push('chat', { sessionId: 'sess_dev_greet' }); await new Promise(r => setTimeout(r, 900)); return true; })()`);
  const pageName = await evalJson(page, `(App.Router.current() || {}).name`);
  if (pageName === 'chat') ok('聊天页已打开');
  else bad('聊天页未打开', pageName);

  await page.eval(`(() => { const b = document.querySelector('.nav-action'); if (b) b.click(); return true; })()`);
  await sleep(600);
  const sheetLabels = await page.eval(`JSON.stringify(Array.from(document.querySelectorAll('.sheet-item')).map(e => (e.textContent || '').trim()))`);
  let labels = [];
  try { labels = JSON.parse(sheetLabels); } catch (e) {}
  if (labels.some((l) => l.indexOf('换个开场白') >= 0)) ok('会话菜单含「换个开场白」', labels.slice(0, 4));
  else bad('会话菜单缺少「换个开场白」', labels);

  await page.eval(`(() => { const items = Array.from(document.querySelectorAll('.sheet-item')); const it = items.find(e => (e.textContent || '').indexOf('换个开场白') >= 0); if (it) it.click(); return true; })()`);
  await sleep(600);
  const greetLabels = await page.eval(`JSON.stringify(Array.from(document.querySelectorAll('.sheet-item')).map(e => (e.textContent || '').trim()))`);
  let glabels = [];
  try { glabels = JSON.parse(greetLabels); } catch (e) {}
  if (glabels.some((l) => l.indexOf('备选 1') >= 0) && glabels.some((l) => l.indexOf('首选') >= 0)) ok('问候语面板含首选与备选', glabels.slice(0, 3));
  else bad('问候语面板内容异常', glabels);
  await page.screenshot(path.join(SHOTS, '22-greeting-sheet.png'));

  await page.eval(`(() => { const items = Array.from(document.querySelectorAll('.sheet-item')); const it = items.find(e => (e.textContent || '').indexOf('备选 1') >= 0); if (it) it.click(); return true; })()`);
  await waitFor(page, `(async () => {
    const rows = await App.DB.byIndex('messages', 'sessionId', 'sess_dev_greet');
    return rows.some(m => /设备备选一/.test(String(m.content || '')));
  })()`, 6000);
  const after = await evalJson(page, `(async () => {
    const sess = await App.DB.get('sessions', 'sess_dev_greet');
    const rows = (await App.DB.byIndex('messages', 'sessionId', 'sess_dev_greet')).sort((a,b) => (a.createdAt||0)-(b.createdAt||0));
    return { greetingIndex: sess.greetingIndex, first: String(rows[0] && rows[0].content || '') };
  })()`);
  if (after && after.greetingIndex === 1 && /设备备选一/.test(after.first)) ok('设备端换开场白生效', after);
  else bad('设备端换开场白失败', after);
  await page.screenshot(path.join(SHOTS, '23-greeting-applied.png'));

  // 3. 设置页主动消息开关存在
  await page.eval(`(async () => { await App.Router.tab('settings'); await new Promise(r => setTimeout(r, 800)); return true; })()`);
  await page.eval(`(() => { const row = document.querySelector('[data-guide-focus="proactive"]'); if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(600);
  const hasSwitch = await page.eval(`!!document.querySelector('[data-guide-focus="proactive"] .cfg-switch')`);
  if (hasSwitch) ok('设置页主动消息开关存在');
  else bad('设置页主动消息开关缺失');
  await page.screenshot(path.join(SHOTS, '24-proactive-setting.png'));

  console.log('\n========== 设备冒烟结果 ==========');
  if (problems.length) {
    console.log('失败 ' + problems.length + ' 项：');
    problems.forEach((p) => console.log('  - ' + p));
    process.exit(1);
  } else {
    console.log('全部通过');
  }
  process.exit(0);
})().catch((e) => {
  console.error('[设备冒烟] 异常', e && (e.stack || e.message || e));
  process.exit(1);
});
