/* 导入人格 E2E（.md / DS 聊天记录 / 聊天截图）
   用法：node scripts/e2e-import.js 9222 http://127.0.0.1:8321 */
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
  for (let i = 0; i < 120 && !(window.App && App.DB && App.Router); i++) await wait(50);
  await App.DB.ready;
  const now = Date.now();
  await App.DB.put('providers', { id: 'prov_guide', name: '示例引导 API', baseUrl: 'https://api.example.com/v1', defaultModel: 'gpt-4o-mini', role: 'guide', createdAt: now, updatedAt: now });
  await App.Bridge.call('secure.set', { key: 'key:prov_guide', value: 'sk-demo-guide-123456' });
  await App.DB.settings.set('onboarding_completed', true);
  await App.DB.settings.set('guide_provider_id', 'prov_guide');
  await App.DB.settings.set('character_gen_provider_id', 'prov_guide');
  await App.DB.settings.set('last_tab', 'characters');
  return { ok: true };
})()`;

async function waitFor(page, expr, timeoutMs = 10000, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await page.eval(expr)) return true; } catch (e) {}
    await sleep(intervalMs);
  }
  return false;
}

const jsClickText = (sel, text) => `(() => {
  const list = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
  const t = list.find(e => (e.textContent || '').includes(${JSON.stringify(text)}));
  if (!t) return 'notfound';
  t.click();
  return 'ok';
})()`;

const jsStep = `(() => {
  const cur = App.Router.current();
  const label = document.querySelector('.ck-step-label');
  const foot = document.querySelector('.ck-wizard-foot');
  const body = document.querySelector('.ck-wizard-body');
  return {
    page: cur && cur.name,
    stepLabel: label ? (label.textContent || '').trim() : '',
    count: document.querySelectorAll('.ck-ai-tag').length,
    userTags: document.querySelectorAll('.ck-user-tag').length,
    thumb: !!document.querySelector('.ck-img-thumb'),
    foot: foot ? (foot.textContent || '').trim() : '',
    head: body ? (body.textContent || '').slice(0, 400) : ''
  };
})()`;

async function openCreate(page) {
  await page.navigate(APP_URL + '/index.html?import=' + Date.now(), 1800);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);
  await page.eval(`(async () => {
    try { await App.DB.settings.del('draft_character'); } catch (e) {}
    try { await App.DB.settings.del('draft_worldview'); } catch (e) {}
    await App.Router.push('characterCreate', {}, {});
    await new Promise(r => setTimeout(r, 700));
    return true;
  })()`);
  await sleep(300);
}

(async () => {
  const page = await CdpPage.connect(PORT);
  await page.init();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenWidth: 390, screenHeight: 844 });

  console.log('[E2E] 导入人格');

  await page.navigate('about:blank', 300);
  await page.clearStorage(ORIGIN);
  await page.navigate(APP_URL + '/index.html', 900);
  await waitFor(page, `(() => !!(window.App && App.DB && App.Router && App.Router.current()))()`, 8000);
  await page.eval(`(async () => { try { await App.DB.clearAll(); } catch (e) {} try { localStorage.clear(); } catch (e) {} return true; })()`);
  await page.navigate(APP_URL + '/index.html?fresh=' + Date.now(), 900);
  await waitFor(page, `(() => !!(window.App && App.Router && App.Router.current()))()`, 8000);
  const seeded = await page.eval(SEED);
  if (!seeded || !seeded.ok) bad('种子数据写入失败');

  const DOC = '# 沈墨\n\n男，28 岁，旧书店老板。外冷内热，话少但会默默照顾人。睡前一定要喝一杯热牛奶。说话短句，语气平淡。\n\n初次见面会说：「欢迎光临。」';
  await openCreate(page);

  // ---------- 1. 入口 ----------
  const entry = await page.eval(`(() => ({
    file: !!document.querySelector('[data-guide-tap="importPersona"]'),
    image: !!document.querySelector('[data-guide-tap="importPersonaImage"]')
  }))()`);
  if (entry.file) ok('Step1 有「导入设定文件 / 聊天记录」入口');
  else bad('没有文件导入入口');
  if (entry.image) ok('Step1 有「上传聊天截图」入口');
  else bad('没有截图导入入口');
  await page.screenshot(path.join(SHOTS, '110-import-entry.png'));

  // 公共 mock：补全 API 返回合法角色卡（.md 文件路径）
  const mockCard = {
    name: '沈墨', gender: 'male', personality: '外冷内热，话少但会默默照顾人',
    habits: '睡前喝一杯热牛奶', background: '旧城区二手书店老板，开了三十年',
    speechStyle: '短句，语气平淡', catchphrases: '', scenario: '雨天进店躲雨',
    firstMessage: '欢迎光临。', alternateGreetings: ['又见面了。'], exampleDialogues: []
  };
  await page.eval(`(() => {
    window.__AICHAT_MOCK_FILE__ = { name: '沈墨.persona.md', data: ${JSON.stringify(DOC)} };
    window.__AICHAT_MOCK_IMAGE__ = { name: 'chat.png', dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
    window.__mockImportCompletion = function () {
      return Promise.resolve({ ok: true, text: JSON.stringify(${JSON.stringify(mockCard)}), error: null });
    };
    App.API.completion = window.__mockImportCompletion;
    return true;
  })()`);
  await sleep(200);

  if ((await page.eval(jsClickText('button', '导入设定文件 / 聊天记录'))) === 'ok') ok('点击文件导入按钮');
  else bad('点不到文件导入按钮');
  const toPreview = await waitFor(page, `(() => { var f = document.querySelector('.ck-wizard-foot'); return !!(f && (f.textContent || '').indexOf('保存') >= 0 && document.querySelector('.ck-ai-tag')); })()`, 20000);
  let st = await page.eval(jsStep);
  if (toPreview) ok('文件导入后直接进入预览');
  else bad('文件导入后没有进入预览：' + JSON.stringify(st).slice(0, 200));
  if (st.head.indexOf('沈墨') >= 0) ok('从 .md 文件识别出角色名「沈墨」');
  else bad('预览页没有识别出的名字：' + st.head.slice(0, 120));
  if (st.count >= 4) ok('AI 补全字段有标签（' + st.count + ' 个）');
  else bad('AI 字段标签过少：' + st.count);
  const notSaved = await page.eval(`(async () => (await App.DB.count('characters')) === 0)()`);
  if (notSaved) ok('预览阶段没有自动保存角色');
  else bad('预览阶段就写入了角色（不应自动保存）');
  await page.screenshot(path.join(SHOTS, '111-import-doc.png'));

  // ---------- 2. DS 聊天记录（JSON） ----------
  const LOG = JSON.stringify({
    title: '林夏',
    conversations: [{
      title: '林夏',
      messages: [
        { role: 'user', content: '你好呀' },
        { role: 'assistant', content: '今天也来啦？外面雨好大，先进来躲一下吧。' },
        { role: 'user', content: '好啊' },
        { role: 'assistant', content: '我这有新到的旧唱片，要听听看吗？' }
      ]
    }]
  });
  await openCreate(page);
  const chatCard = Object.assign({}, mockCard, { name: '林夏', gender: 'female', firstMessage: '今天也来啦？' });
  await page.eval(`(() => {
    window.__AICHAT_MOCK_FILE__ = { name: 'deepseek-chat.json', data: ${JSON.stringify(LOG)} };
    App.API.completion = function () { return Promise.resolve({ ok: true, text: ${JSON.stringify(JSON.stringify(chatCard))}, error: null }); };
    return true;
  })()`);
  await sleep(200);
  if ((await page.eval(jsClickText('button', '导入设定文件 / 聊天记录'))) === 'ok') ok('点击导入 DS 聊天记录');
  else bad('点不到导入按钮（聊天记录）');
  const chatOk = await waitFor(page, `(() => { var f = document.querySelector('.ck-wizard-foot'); return !!(f && (f.textContent || '').indexOf('保存') >= 0 && document.querySelector('.ck-ai-tag')); })()`, 20000);
  st = await page.eval(jsStep);
  if (chatOk) ok('DS 聊天记录导入后进入预览');
  else bad('DS 聊天记录没有导入成功：' + JSON.stringify(st).slice(0, 200));
  if (st.head.indexOf('林夏') >= 0) ok('从聊天记录识别出角色「林夏」');
  else bad('聊天记录没有识别出角色名');
  await page.screenshot(path.join(SHOTS, '112-import-chatlog.png'));

  // ---------- 3. 聊天截图（视觉模型） ----------
  await openCreate(page);
  const shotCard = Object.assign({}, mockCard, { name: '阿澄', gender: 'other', firstMessage: '这张截图里的对话是我吗？' });
  await page.eval(`(() => {
    App.API.chatOnce = function () { return Promise.resolve({ ok: true, text: ${JSON.stringify(JSON.stringify(shotCard))}, error: null }); };
    window.__AICHAT_MOCK_IMAGE__ = { name: 'chat.png', dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
    return true;
  })()`);
  await sleep(150);
  if ((await page.eval(jsClickText('button', '上传聊天截图，AI 识别人格'))) === 'ok') ok('点击截图导入按钮');
  else bad('点不到截图导入按钮');
  await sleep(300);
  const pickOpts = await page.eval(`JSON.stringify(window.__AICHAT_PICK_OPTS__ || {})`);
  let pickObj = {};
  try { pickObj = JSON.parse(pickOpts || '{}'); } catch (e) { pickObj = {}; }
  if (Number(pickObj.maxWidth) >= 900 || Number(pickObj.maxSide) >= 1200) ok('截图识别使用高清晰度（' + JSON.stringify(pickObj) + '）');
  else bad('截图识别分辨率过低：' + pickOpts);
  if (pickObj.slice === true) ok('截图识别请求长截图切片');
  else bad('截图识别没有请求长截图切片：' + pickOpts);
  const shotOk = await waitFor(page, `(() => { var f = document.querySelector('.ck-wizard-foot'); return !!(f && (f.textContent || '').indexOf('保存') >= 0 && document.querySelector('.ck-ai-tag')); })()`, 20000);
  st = await page.eval(jsStep);
  if (shotOk) ok('截图识别人格后进入预览');
  else bad('截图识别没有进入预览：' + JSON.stringify(st).slice(0, 200));
  if (st.head.indexOf('阿澄') >= 0) ok('从截图识别出角色「阿澄」');
  else bad('截图没有识别出角色名');
  await page.screenshot(path.join(SHOTS, '113-import-screenshot.png'));

  // ---------- 3b. 长截图：应按宽度切片，多段一起送给模型 ----------
  await openCreate(page);
  await page.eval(`(() => {
    // 画一张 600x3000 的「长截图」，模拟滚动截屏
    var cv = document.createElement('canvas');
    cv.width = 600; cv.height = 3000;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0, 0, 600, 3000);
    ctx.font = '20px sans-serif';
    for (var i = 0; i < 60; i++) {
      var y = 40 + i * 48;
      ctx.fillStyle = i % 2 ? '#ffffff' : '#d8f5d8';
      ctx.fillRect(30, y - 26, 420, 40);
      ctx.fillStyle = '#333333';
      ctx.fillText('第 ' + (i + 1) + ' 行聊天内容：今天过得怎么样？', 44, y);
    }
    var tall = cv.toDataURL('image/png');
    window.__AICHAT_MOCK_IMAGE__ = { name: 'long-chat.png', dataUri: tall };
    window.__longShotContent = null;
    App.API.chatOnce = function (opts) {
      window.__longShotContent = JSON.stringify((opts && opts.messages) || []);
      return Promise.resolve({ ok: true, text: JSON.stringify({ name: '长图角色', gender: 'female', personality: '温柔有耐心', habits: '爱发长消息', background: '从长截图里读出来的角色', speechStyle: '轻柔', firstMessage: '今天也聊聊天吧。' }), error: null });
    };
    return true;
  })()`);
  await sleep(150);
  if ((await page.eval(jsClickText('button', '上传聊天截图，AI 识别人格'))) === 'ok') ok('点击长截图导入按钮');
  else bad('点不到长截图导入按钮');
  const longOk = await waitFor(page, `(() => { var f = document.querySelector('.ck-wizard-foot'); return !!(f && (f.textContent || '').indexOf('保存') >= 0 && document.querySelector('.ck-ai-tag')); })()`, 20000);
  const longContent = await page.eval(`window.__longShotContent || ''`);
  st = await page.eval(jsStep);
  if (longOk) ok('长截图识别人格后进入预览');
  else bad('长截图识别没有进入预览：' + JSON.stringify(st).slice(0, 200));
  if (st.head.indexOf('长图角色') >= 0) ok('从长截图识别出角色「长图角色」');
  else bad('长截图没有识别出角色名');
  let imgCount = 0;
  try {
    const parsed = JSON.parse(longContent || '[]');
    parsed.forEach(function (m) {
      if (Array.isArray(m.content)) m.content.forEach(function (c) { if (c && c.type === 'image_url') imgCount++; });
    });
  } catch (e) { imgCount = 0; }
  if (imgCount >= 2) ok('长截图被切成多段一起送给模型（image_url=' + imgCount + '）');
  else bad('长截图没有切片或只送了 1 张：' + String(longContent).slice(0, 200));
  if (String(longContent).indexOf('长截图') >= 0 && String(longContent).indexOf('第 2/') >= 0) ok('多段图片带「长截图/第 2 段」提示');
  else bad('缺少长截图分段提示：' + String(longContent).slice(0, 500));
  await page.screenshot(path.join(SHOTS, '117-import-longshot.png'));

  // ---------- 4. 截图里读不出内容时，必须给出明确反馈（不能静默） ----------
  await openCreate(page);
  await page.eval(`(() => {
    App.API.chatOnce = function () {
      return Promise.resolve({ ok: true, text: JSON.stringify({ name: '', personality: '', habits: '', background: '', speechStyle: '', firstMessage: '' }), error: null });
    };
    window.__AICHAT_MOCK_IMAGE__ = { name: 'blurry.png', dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
    return true;
  })()`);
  await sleep(150);
  if ((await page.eval(jsClickText('button', '上传聊天截图，AI 识别人格'))) === 'ok') ok('再次点击截图导入');
  else bad('点不到截图导入按钮（第二次）');
  const errShown = await waitFor(page, `!!document.querySelector('.ck-import-error')`, 20000);
  if (errShown) ok('识别不出结果时显示错误卡片');
  else bad('识别失败时没有任何反馈');
  const errText = await page.eval(`(() => { var e = document.querySelector('.ck-import-error'); return e ? (e.textContent || '') : ''; })()`);
  if (errText.indexOf('没有从截图里读到') >= 0 || errText.indexOf('没有识别出结果') >= 0) ok('错误卡片说明了原因');
  else bad('错误说明不明确：' + String(errText).slice(0, 120));
  const stillStep1 = await page.eval(`(() => !!document.querySelector('.ck-import-box'))()`);
  if (stillStep1) ok('失败后仍停留在导入步骤，可重试');
  else bad('失败后页面状态异常');
  await page.screenshot(path.join(SHOTS, '116-import-no-result.png'));

  // ---------- 4) 粘贴长文字自动生成人格 ----------
  await openCreate(page);
  await page.eval(`(() => {
    App.API.completion = function () {
      return Promise.resolve({ ok: true, text: JSON.stringify({
        name: '阿苔', gender: 'female', personality: '话不多，爱观察', habits: '随身带速写本',
        background: '旧城区的钟表匠学徒，喜欢收集坏掉的小零件', speechStyle: '短句，偶尔用比喻',
        firstMessage: '你也是来修表的吗？', alternateGreetings: [], scenario: '雨天的钟表铺'
      }), error: null });
    };
    return true;
  })()`);
  await sleep(150);
  if ((await page.eval(jsClickText('button', '粘贴长文字，自动生成人格'))) === 'ok') ok('点击「粘贴长文字生成人格」');
  else bad('找不到粘贴长文字入口');
  const taShown = await waitFor(page, `!!document.querySelector('.ck-text-import-input')`, 4000);
  if (taShown) ok('长文字输入弹窗已打开');
  else bad('长文字输入弹窗没有打开');
  const LONG_TEXT = "阿苔是旧城区钟表匠的学徒。她话不多，喜欢观察别人手上的细小动作，随身带着一本速写本，里面画满了坏掉的齿轮和客人的手。她习惯用比喻说话，比如把失眠比作走慢的表。她住在一间下雨会漏水的阁楼里，最珍惜的东西是师傅留下的一把镊子。";
  await page.eval(`(() => {
    var ta = document.querySelector('.ck-text-import-input');
    if (!ta) return false;
    ta.value = window.__E2E_LONG_TEXT__;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`.replace('window.__E2E_LONG_TEXT__', JSON.stringify(LONG_TEXT)));
  await sleep(120);
  const genClicked = await page.eval(`(() => {
    var b = document.querySelector('.modal-wrap.show .modal-foot .btn.primary');
    if (!b) return 'no';
    b.click(); return 'ok';
  })()`);
  if (genClicked === 'ok') ok('点击「生成」');
  else bad('生成按钮不可用');
  const textPreview = await waitFor(page, `(() => {
    if (!document.querySelector('.ck-ai-tag')) return false;
    var body = document.body.textContent || '';
    return body.indexOf('阿苔') >= 0;
  })()`, 20000);
  if (textPreview) ok('长文字生成后进入预览，角色名「阿苔」');
  else bad('长文字生成没有进入预览');
  const notSavedText = await page.eval(`(async () => (await App.DB.all('characters')).length)()`);
  if (notSavedText === 0) ok('长文字生成不自动保存');
  else bad('长文字生成后自动保存了：' + notSavedText);
  await page.screenshot(path.join(SHOTS, '122-import-text.png'));
  const errors = await page.eval(`JSON.stringify(window.__e2eErrors || [])`);
  const errList = JSON.parse(errors || '[]');
  if (!errList.length) ok('无未捕获 JS 异常');
  else bad('出现未捕获异常：' + errors);

  console.log('\n========== 导入人格 E2E 结果 ==========');
  if (problems.length) {
    console.log('失败 ' + problems.length + ' 项：');
    problems.forEach((p) => console.log('  - ' + p));
    process.exitCode = 1;
  } else {
    console.log('全部通过');
  }
  try { page.close(); } catch (e) {}
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('E2E 异常：', e);
  process.exit(1);
});
