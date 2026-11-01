/* =========================================================================
   pages/about.js —— 关于页（成员 D）
   版本来自原生 Bridge.call('app.info')；含隐私声明、开源组件、免责声明、帮助入口。
   不读 Key、不读聊天内容，纯静态展示 + 一个异步版本查询。
   ========================================================================= */
(function () {
  'use strict';
  var App = window.App = window.App || {};

  function U() { return App.Util; }
  function UI() { return App.UI; }

  var APP_NAME = 'AI 聊天';

  function infoRow(ui, label, value) {
    var row = ui.el('div', { class: 'about-kv' });
    row.appendChild(ui.el('span', { class: 'about-kv-k', text: label }));
    row.appendChild(ui.el('span', { class: 'about-kv-v', text: value }));
    return row;
  }

  function section(ui, title, iconName) {
    var box = ui.el('div', { class: 'about-section' });
    var head = ui.el('div', { class: 'about-section-head' });
    if (iconName) head.appendChild(ui.el('span', { class: 'about-section-icon', html: ui.icon(iconName, 18) }));
    head.appendChild(ui.el('span', { class: 'about-section-title', text: title }));
    box.appendChild(head);
    return box;
  }

  function para(ui, text, cls) {
    return ui.el('p', { class: 'about-p' + (cls ? ' ' + cls : ''), text: text });
  }

  function bulletList(ui, items) {
    var ul = ui.el('ul', { class: 'about-ul' });
    items.forEach(function (t) {
      ul.appendChild(ui.el('li', { text: t }));
    });
    return ul;
  }

  function buildAbout(root, params, page) {
    var ui = UI();
    page.setTitle('关于');

    var wrap = ui.el('div', { class: 'page-scroll about-page' });

    /* ---------------- 头部 ---------------- */
    var hero = ui.el('div', { class: 'about-hero' });
    var logo = ui.el('div', { class: 'about-logo', attrs: { 'aria-hidden': 'true' }, html: ui.icon('guide', 34) });
    hero.appendChild(logo);
    hero.appendChild(ui.el('div', { class: 'about-name', text: APP_NAME }));
    var versionEl = ui.el('div', { class: 'about-version', text: '版本读取中…' });
    hero.appendChild(versionEl);
    hero.appendChild(ui.el('div', { class: 'about-tagline', text: '自带 API Key 的 AI 聊天客户端：数据只存本机，模型由你选。' }));
    wrap.appendChild(hero);

    /* ---------------- 简要信息 ---------------- */
    var infoBox = ui.el('div', { class: 'about-card' });
    var platformEl = null;
    infoBox.appendChild(infoRow(ui, '应用名称', APP_NAME));
    var verRowValue = ui.el('span', { class: 'about-kv-v', text: '—' });
    var verRow = ui.el('div', { class: 'about-kv' });
    verRow.appendChild(ui.el('span', { class: 'about-kv-k', text: '版本' }));
    verRow.appendChild(verRowValue);
    infoBox.appendChild(verRow);
    var platRow = ui.el('div', { class: 'about-kv' });
    platRow.appendChild(ui.el('span', { class: 'about-kv-k', text: '运行环境' }));
    platformEl = ui.el('span', { class: 'about-kv-v', text: 'Android WebView' });
    platRow.appendChild(platformEl);
    infoBox.appendChild(platRow);
    wrap.appendChild(infoBox);

    /* ---------------- 隐私声明 ---------------- */
    var privacy = section(ui, '隐私声明', 'lock');
    privacy.appendChild(para(ui, '这个 App 没有账号系统、没有自建服务器、没有遥测统计。'));
    privacy.appendChild(bulletList(ui, [
      '聊天记录、角色、世界观、预设与引导会话只保存在本机数据库中，不上传、不同步。',
      'API Key 通过系统安全存储（加密）保存，不写入数据库、不进入备份文件、不写入日志。',
      '只有你主动发送消息或让 AI 补全时，相关文本才会发送给你配置的 API 服务商，请阅读该服务商的隐私政策。',
      '引导助手只接收「页面名 + 已填字段 + 错误码」这类结构化上下文，不会发送你的聊天正文、API Key 或备份内容。',
      '卸载 App 或清除应用数据会永久删除本机数据，无法恢复，建议先导出备份。'
    ]));
    wrap.appendChild(privacy);

    /* ---------------- 开源组件 ---------------- */
    var oss = section(ui, '开源组件与实现说明', 'spark');
    oss.appendChild(para(ui, '本 App 前端为手写原生 JavaScript，未打包 React/Vue 等第三方运行时框架，也没有 npm 运行时依赖。'));
    oss.appendChild(bulletList(ui, [
      '运行容器：Android System WebView（Chromium 内核），遵循其开源许可。',
      '界面图标：项目内联 SVG，随 App 一起打包。',
      '数据存储：WebView 内置的 IndexedDB，键值设置与业务表均保存在本机。',
      '网络与安全存储：随 App 打包的原生代码实现（Java / Android SDK），Key 不出原生安全存储。'
    ]));
    wrap.appendChild(oss);

    /* ---------------- 免责声明 ---------------- */
    var dis = section(ui, '免责声明', 'warning');
    dis.appendChild(bulletList(ui, [
      'AI 生成内容可能不准确、不完整或带有偏见，不代表开发者观点，请自行判断。',
      '医疗、法律、金融等专业问题请咨询有资质的专业人士，本 App 的回答不构成专业建议。',
      'API 调用产生的费用、账户与合规问题由服务商与你本人负责，本 App 不代扣费用、不提供模型服务。',
      '因网络、服务商故障或配置错误导致的不可用，本 App 会尽力给出错误说明，但不承担由此产生的损失。'
    ]));
    wrap.appendChild(dis);

    /* ---------------- 使用帮助入口 ---------------- */
    var helpBox = section(ui, '需要帮助？', 'help');
    helpBox.appendChild(para(ui, '遇到报错或不知道怎么配置 API，可以让引导助手结合当前页面回答；也可以看离线使用帮助。'));
    var actions = ui.el('div', { class: 'about-actions' });
    actions.appendChild(ui.el('button', {
      class: 'btn primary block', type: 'button', text: '打开引导助手',
      on: {
        click: function () {
          if (App.Help && App.Help.open) App.Help.open({ source: 'about', page: 'about' });
          else if (UI().toast) UI().toast('帮助模块未加载', 'error');
        }
      }
    }));
    actions.appendChild(ui.el('button', {
      class: 'btn block', type: 'button', text: '查看离线使用帮助',
      on: {
        click: function () {
          try {
            var ret = App.Router && App.Router.push('help');
            if (ret && ret.catch) ret.catch(function () { if (UI().toast) UI().toast('使用帮助暂时打不开', 'error'); });
          } catch (e) {
            if (UI().toast) UI().toast('使用帮助暂时打不开', 'error');
          }
        }
      }
    }));
    helpBox.appendChild(actions);
    wrap.appendChild(helpBox);

    var footer = ui.el('div', { class: 'about-footer' });
    footer.appendChild(ui.el('div', { text: '数据只存本机 · 无账号 · 无遥测' }));
    wrap.appendChild(footer);

    root.appendChild(wrap);

    /* ---------------- 版本信息（异步，失败静默降级） ---------------- */
    function applyInfo(info) {
      info = info || {};
      var version = String(info.version || '1.0.0');
      versionEl.textContent = '版本 ' + version;
      verRowValue.textContent = version;
      var platform = String(info.platform || '');
      if (platform === 'web') platformEl.textContent = '浏览器预览（演示模式）';
      else if (platform) platformEl.textContent = 'Android ' + platform + (info.apiLevel ? (' · API ' + info.apiLevel) : '');
      else platformEl.textContent = 'Android WebView';
    }
    if (App.info && App.info.version) {
      applyInfo(App.info);
    } else if (App.Bridge && App.Bridge.call) {
      App.Bridge.call('app.info', {})
        .then(function (info) { applyInfo(info); return null; })
        .catch(function () {
          versionEl.textContent = '版本信息不可用';
          return null;
        });
    } else {
      versionEl.textContent = '版本 1.0.0';
    }

    return Promise.resolve();
  }

  if (App.Router && typeof App.Router.register === 'function') {
    App.Router.register('about', {
      title: '关于',
      tab: false,
      build: buildAbout
    });
  } else {
    console.warn('[about] Router 未就绪，页面 about 注册失败');
  }
})();
