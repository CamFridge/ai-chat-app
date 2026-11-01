/* ============================================================
 * settings.js —— 设置（底部 Tab）
 * 分组（微信式 cell）：外观 / 补全设置 / 引导助手 / 悬浮气泡 / 数据。
 * 关键约束：
 *   1. 主题即时生效（App.UI.setTheme + settings.theme）；
 *   2. 导出备份必须剔除 API Key（Provider 只导出元数据）；
 *   3. 导入 / 清空数据都要二次确认，清空需手输「删除」，完成后回到引导。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App;

  var THEME_LABELS = { light: '浅色', dark: '深色', amoled: 'AMOLED' };
  var BUBBLE_DEFAULT_POSITION = { edge: 'right', y: 0.62 };
  // v1.2.0 角色主动消息：可选间隔（分钟），默认 60
  var PROACTIVE_INTERVALS = [15, 30, 60, 120];
  var PROACTIVE_DEFAULT_INTERVAL = 60;
  var PROACTIVE_RANDOM_INTERVAL = 0;
  // 随机模式：用户可调上下限，范围 0~24 小时（单位：分钟）
  var PROACTIVE_RANDOM_MIN_DEFAULT = 60;
  var PROACTIVE_RANDOM_MAX_DEFAULT = 480;
  var PROACTIVE_RANDOM_MAX_MINUTES = 24 * 60;
  var PROACTIVE_BOUND_HOURS = [0, 0.5, 1, 2, 3, 4, 6, 8, 12, 18, 24];

  App.Router.register('settings', {
    tab: true,
    title: '设置',
    tabLabel: '设置',
    tabIcon: 'settings',

    async build(root, params, page) {
      var UI = App.UI;
      var Util = App.Util;
      var DB = App.DB;

      var state = {
        loading: true,
        error: null,
        settingsMap: {},
        providers: [],
        presets: [],
        version: '',
        theme: 'light',
        godMode: false,
        proactiveEnabled: false,
        proactiveIntervalMin: PROACTIVE_DEFAULT_INTERVAL,
        proactiveRandomMin: PROACTIVE_RANDOM_MIN_DEFAULT,
        proactiveRandomMax: PROACTIVE_RANDOM_MAX_DEFAULT,
        // v1.3.0 聊天界面（App.Style 为数据源，这里保存兜底副本）
        chatStyle: 'wechat',
        chatBg: '',
        userAvatar: '',
        bubbleEnabled: true,
        bubblePosition: BUBBLE_DEFAULT_POSITION,
        guideProvider: null,
        defaultPreset: null,
        genProvider: null,
        genModel: '',
        exporting: false,
        importing: false
      };

      var destroyed = false;
      var refreshTimer = null;
      var unsubRoute = null;
      // 标记：正在调用 page.guide()，此时 Router 的 notify 不应触发本页刷新
      var inGuide = false;

      function el(tag, attrs) {
        var args = Array.prototype.slice.call(arguments, 2);
        return UI.el.apply(UI, [tag, attrs].concat(args));
      }

      function errText(e) {
        if (!e) return '未知错误';
        if (typeof e === 'string') return e;
        if (e.message) return e.message;
        if (e.error && e.error.message) return e.error.message;
        return String(e);
      }

      function toast(text) {
        try {
          UI.toast(text);
        } catch (e) {
          /* 忽略 */
        }
      }

      function refreshBubble() {
        try {
          if (App.Bubble && typeof App.Bubble.refresh === 'function') App.Bubble.refresh();
        } catch (e) {
          /* 气泡模块未就绪时忽略 */
        }
      }

      function safeConfirm(opts) {
        try {
          return Promise.resolve(UI.confirm(opts)).then(function (v) {
            return !!v;
          });
        } catch (e) {
          return Promise.resolve(false);
        }
      }

      function safePrompt(opts) {
        try {
          if (!UI || typeof UI.prompt !== 'function') return Promise.resolve(null);
          return Promise.resolve(UI.prompt(opts)).catch(function () {
            return null;
          });
        } catch (e) {
          return Promise.resolve(null);
        }
      }

      // ---------- 选择菜单：优先 App.UI.sheet，失败时用内置兜底面板 ----------
      function normalizePick(sel) {
        if (typeof sel === 'string') return sel;
        if (sel && typeof sel === 'object') {
          if (sel.value !== undefined) return sel.value;
          if (sel.id !== undefined) return sel.id;
          if (sel.key !== undefined) return sel.key;
          if (sel.label !== undefined) return sel.label;
        }
        return null;
      }

      function fallbackPick(title, items) {
        return new Promise(function (resolve) {
          var overlay = document.getElementById('overlay-root') || document.body;
          var closed = false;
          function close(value) {
            if (closed) return;
            closed = true;
            mask.remove();
            resolve(value);
          }
          var mask = el('div', {
            class: 'cfg-picker-mask',
            on: {
              click: function (ev) {
                if (ev && ev.target === mask) close(null);
              }
            }
          });
          var panel = el('div', { class: 'cfg-picker' });
          panel.appendChild(el('div', { class: 'cfg-picker-title', text: title || '请选择' }));
          items.forEach(function (item) {
            panel.appendChild(
              el('div', {
                class: 'cfg-picker-item' + (item.danger ? ' danger' : ''),
                text: item.label,
                on: {
                  click: function () {
                    close(item.value !== undefined ? item.value : item.label);
                  }
                }
              })
            );
          });
          panel.appendChild(
            el('div', {
              class: 'cfg-picker-item cfg-picker-cancel',
              text: '取消',
              on: {
                click: function () {
                  close(null);
                }
              }
            })
          );
          mask.appendChild(panel);
          overlay.appendChild(mask);
        });
      }

      function pickSheet(title, items) {
        return Promise.resolve()
          .then(function () {
            if (!UI || typeof UI.sheet !== 'function') return fallbackPick(title, items);
            return Promise.resolve(UI.sheet({ title: title, items: items, options: items })).then(function (sel) {
              if (sel === null || sel === undefined) return null;
              return normalizePick(sel);
            });
          })
          .catch(function () {
            return fallbackPick(title, items);
          });
      }

      // ---------- 设置数据归一化 ----------
      function settingsMapOf(raw) {
        var map = {};
        if (!raw) return map;
        if (Array.isArray(raw)) {
          raw.forEach(function (row) {
            if (row && row.key !== undefined) map[row.key] = row.value;
          });
          return map;
        }
        if (typeof raw === 'object') {
          Object.keys(raw).forEach(function (k) {
            map[k] = raw[k];
          });
        }
        return map;
      }

      function settingsEntriesOf(raw) {
        var entries = [];
        if (!raw) return entries;
        if (Array.isArray(raw)) {
          raw.forEach(function (row) {
            if (row && row.key !== undefined) entries.push({ key: row.key, value: row.value });
          });
          return entries;
        }
        if (typeof raw === 'object') {
          Object.keys(raw).forEach(function (k) {
            entries.push({ key: k, value: raw[k] });
          });
        }
        return entries;
      }

      function deleteKeyOf(id) {
        return Promise.resolve()
          .then(function () {
            // api.js 中删除方法名为 delKey；deleteKey 仅作兼容兜底
            if (App.API && typeof App.API.delKey === 'function') return App.API.delKey(id);
            if (App.API && typeof App.API.deleteKey === 'function') return App.API.deleteKey(id);
            return App.Bridge.call('secure.del', { key: 'key:' + id });
          })
          .catch(function () {
            /* Key 不存在时忽略 */
          });
      }

      // ---------- 页面骨架 ----------
      root.textContent = '';
      var wrap = el('div', { class: 'cfg-page cfg-settings-page' });
      root.appendChild(wrap);

      page.onDestroy(function () {
        destroyed = true;
        if (refreshTimer) {
          clearTimeout(refreshTimer);
          refreshTimer = null;
        }
        if (typeof unsubRoute === 'function') {
          try {
            unsubRoute();
          } catch (e) {
            /* 忽略 */
          }
        }
      });

      // 从 API 管理等页面回来后刷新（引导 API 状态可能已变化）
      try {
        unsubRoute = App.Router.onChange(function (info) {
          var name = typeof info === 'string' ? info : info && info.name;
          if (name === 'settings' && !destroyed && !inGuide) scheduleRefresh();
        });
      } catch (e) {
        unsubRoute = null;
      }

      function scheduleRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () {
          refreshTimer = null;
          if (!destroyed) loadAndRender();
        }, 60);
      }

      // ---------- 数据 ----------
      async function load() {
        state.loading = true;
        state.error = null;
        try {
          var results = await Promise.all([DB.settings.all(), DB.all('providers'), DB.all('presets')]);
          state.settingsMap = settingsMapOf(results[0]);
          state.providers = results[1] || [];
          state.presets = results[2] || [];

          var map = state.settingsMap;
          state.theme = map.theme || (UI && typeof UI.theme === 'function' ? UI.theme() : 'light') || 'light';
          state.godMode = map.god_mode === true;
          state.proactiveEnabled = map.proactive_enabled === true;
          state.proactiveIntervalMin = normalizeProactiveInterval(map.proactive_interval_min);
          state.proactiveRandomMin = normalizeRandomBound(map.proactive_random_min, PROACTIVE_RANDOM_MIN_DEFAULT);
          state.proactiveRandomMax = normalizeRandomBound(map.proactive_random_max, PROACTIVE_RANDOM_MAX_DEFAULT);
          if (state.proactiveRandomMin > state.proactiveRandomMax) state.proactiveRandomMax = state.proactiveRandomMin;
          state.bubbleEnabled = map.bubble_enabled !== false;
          state.bubblePosition =
            map.bubble_position && typeof map.bubble_position === 'object'
              ? map.bubble_position
              : BUBBLE_DEFAULT_POSITION;

          // v1.3.0 聊天界面：样式 / 背景 / 我的头像
          state.chatStyle = map.chat_style === 'imessage' || map.chat_style === 'qq' ? map.chat_style : 'wechat';
          state.chatBg = typeof map.chat_bg === 'string' ? map.chat_bg : '';
          state.userAvatar = typeof map.user_avatar === 'string' ? map.user_avatar : '';

          state.guideProvider =
            findById(state.providers, map.guide_provider_id) ||
            findByRole(state.providers, 'guide') ||
            null;
          state.defaultPreset = findById(state.presets, map.default_preset_id);
          state.genProvider =
            findById(state.providers, map.character_gen_provider_id) || state.guideProvider;
          state.genModel = map.character_gen_model || '';
        } catch (e) {
          state.error = e;
        }
        state.loading = false;

        // 版本号（原生信息；浏览器 mock 也有假实现）
        try {
          var info = await App.Bridge.call('app.info', {});
          state.version = (info && (info.version || info.name || info.appVersion)) || '';
        } catch (e) {
          state.version = '';
        }
      }

      function findById(list, id) {
        if (!id) return null;
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === id) return list[i];
        }
        return null;
      }

      function findByRole(list, role) {
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].role === role) return list[i];
        }
        return null;
      }

      async function loadAndRender() {
        await load();
        if (!destroyed) render();
      }

      function updateGuide() {
        inGuide = true;
        try {
          page.guide({
            pageId: 'settings',
            title: '设置',
            stage: null,
            totalSteps: null,
            filledFields: {},
            missingFields: [],
            error: state.error ? { code: 'unknown', message: errText(state.error) } : null
          });
        } catch (e) {
          /* 忽略 */
        } finally {
          inGuide = false;
        }
      }

      // ---------- 通用块 ----------
      function group(title, cells) {
        var g = el('div', { class: 'cfg-group' });
        if (title) g.appendChild(el('div', { class: 'cfg-group-title', text: title }));
        var list = el('div', { class: 'list cfg-group-list' });
        cells.forEach(function (c) {
          if (c) list.appendChild(c);
        });
        g.appendChild(list);
        return g;
      }

      function cell(opts) {
        var children = [
          el(
            'div',
            { class: 'main' },
            el('div', { class: 'title', text: opts.title || '' }),
            opts.sub ? el('div', { class: 'sub', text: opts.sub }) : null
          )
        ];
        if (opts.value !== undefined && opts.value !== null && opts.value !== '') {
          children.push(el('div', { class: 'meta cfg-cell-value ellipsis', text: String(opts.value) }));
        }
        if (opts.right) children.push(opts.right);
        if (opts.chev) children.push(el('div', { class: 'chev cfg-chev', html: UI.icon('chev') }));
        var cellAttrs = {
          class:
            'cell cfg-cell' +
            (opts.danger ? ' cfg-danger' : '') +
            (opts.onClick ? ' cfg-clickable' : '')
        };
        // 供引导气泡定位（如 data-guide-focus="godMode"）
        if (opts.dataset && typeof opts.dataset === 'object') cellAttrs.dataset = opts.dataset;
        var node = el('div', cellAttrs, children);
        if (opts.onClick) {
          node.addEventListener('click', function () {
            if (typeof opts.onClick === 'function') opts.onClick();
          });
        }
        return node;
      }

      function switchCell(opts) {
        var sw = el('div', { class: 'cfg-switch' + (opts.checked ? ' on' : '') });
        var node = cell({
          title: opts.title,
          sub: opts.sub,
          right: sw,
          chev: false,
          dataset: opts.dataset,
          onClick: function () {
            opts.checked = !opts.checked;
            if (opts.checked) sw.classList.add('on');
            else sw.classList.remove('on');
            if (typeof opts.onChange === 'function') opts.onChange(opts.checked);
          }
        });
        return node;
      }

      function loadingBox(text) {
        return el(
          'div',
          { class: 'loading cfg-loading' },
          el('div', { class: 'spinner' }),
          el('div', { class: 'muted small', text: text || '加载中…' })
        );
      }

      function errorBox(title, desc, onRetry) {
        var box = el(
          'div',
          { class: 'error-box cfg-error-box' },
          el('div', { class: 'cfg-error-title', text: title }),
          el('div', { class: 'cfg-error-hint', text: desc })
        );
        if (onRetry) {
          box.appendChild(
            el('button', {
              class: 'btn small',
              attrs: { type: 'button' },
              text: '重试',
              on: { click: onRetry }
            })
          );
        }
        return box;
      }

      // ---------- 各分组渲染 ----------
      function themeLabel() {
        return THEME_LABELS[state.theme] || '浅色';
      }

      function genProviderLabel() {
        if (!state.genProvider) return '未设置';
        return (
          (state.genProvider.name || '未命名 API') +
          (state.genProvider.role === 'guide' ? '（引导）' : '')
        );
      }

      function guideCell() {
        var p = state.guideProvider;
        var has = !!p;
        return cell({
          title: '引导 API',
          sub: has
            ? (p.name || '未命名 API') + ' · ' + (p.defaultModel || '未设置模型')
            : '未设置引导 API：帮助问答、世界观与角色补全不可用，请先去配置',
          value: has ? '' : '去配置',
          chev: true,
          danger: !has,
          onClick: function () {
            goApiList();
          }
        });
      }

      // ---------- 角色与聊天 ----------
      // 上帝模式：只写 settings.god_mode，聊天页加载时读取并拼进系统提示词
      async function onGodModeToggle(checked) {
        var next = !!checked;
        try {
          await DB.settings.set('god_mode', next);
          state.godMode = next;
          state.settingsMap.god_mode = next;
          toast(next ? '已开启上帝模式' : '已关闭上帝模式');
        } catch (e) {
          // 写入失败时回滚开关视觉状态
          toast('保存失败：' + errText(e));
          if (!destroyed) render();
        }
      }

      // 图片库/发图帮助入口（帮助抽屉由 help.js 提供）
      function openMediaHelp() {
        try {
          if (App.Help && typeof App.Help.open === 'function') {
            App.Help.open({ source: 'media_help' });
          } else {
            toast('帮助页暂不可用');
          }
        } catch (e) {
          toast('打开帮助失败：' + errText(e));
        }
      }

      // ---------- 角色主动消息（v1.2.0） ----------
      // 15/30/60/120，或 0 表示「随机间隔」（每次从 15~120 分钟重新随机）
      function normalizeProactiveInterval(value) {
        var n = typeof value === 'number' ? value : parseInt(value, 10);
        if (!isFinite(n)) return PROACTIVE_DEFAULT_INTERVAL;
        if (n === PROACTIVE_RANDOM_INTERVAL) return n;
        if (PROACTIVE_INTERVALS.indexOf(n) < 0) return PROACTIVE_DEFAULT_INTERVAL;
        return n;
      }

      function proactiveIntervalLabel(n) {
        return n === PROACTIVE_RANDOM_INTERVAL ? randomRangeLabel() : n + ' 分钟';
      }

      function normalizeRandomBound(value, def) {
        var n = typeof value === 'number' ? value : parseInt(value, 10);
        if (!isFinite(n)) return def;
        return Math.max(0, Math.min(PROACTIVE_RANDOM_MAX_MINUTES, Math.round(n)));
      }

      function randomBoundLabel(n) {
        if (n === 0) return '0 分钟';
        if (n % 60 === 0) return (n / 60) + ' 小时';
        return (n / 60).toFixed(1).replace(/\.0$/, '') + ' 小时';
      }

      function randomRangeLabel() {
        return '随机（' + randomBoundLabel(state.proactiveRandomMin) + '~' + randomBoundLabel(state.proactiveRandomMax) + '）';
      }

      // 设置随机间隔的下限或上限（0~24 小时，0.5 小时步进）
      function chooseRandomBound(which) {
        var isMin = which === 'min';
        var current = isMin ? state.proactiveRandomMin : state.proactiveRandomMax;
        var items = PROACTIVE_BOUND_HOURS.map(function (h) {
          var min = Math.round(h * 60);
          return { id: String(min), value: String(min), label: randomBoundLabel(min) };
        });
        var task;
        try {
          if (UI && typeof UI.sheet === 'function') {
            task = Promise.resolve(
              UI.sheet({
                title: isMin ? '随机间隔下限' : '随机间隔上限',
                items: items,
                selected: String(current)
              })
            );
          } else {
            task = fallbackPick(isMin ? '随机间隔下限' : '随机间隔上限', items);
          }
        } catch (e) {
          task = fallbackPick(isMin ? '随机间隔下限' : '随机间隔上限', items);
        }
        Promise.resolve(task)
          .then(async function (picked) {
            if (picked === null || picked === undefined) return;
            var raw = normalizePick(picked);
            var value = normalizeRandomBound(raw, current);
            var lo = isMin ? value : state.proactiveRandomMin;
            var hi = isMin ? state.proactiveRandomMax : value;
            if (lo > hi) {
              if (isMin) hi = lo;
              else lo = hi;
            }
            await DB.settings.set('proactive_random_min', lo);
            await DB.settings.set('proactive_random_max', hi);
            var P = proactive();
            if (P && typeof P.setRandomRange === 'function') {
              try { P.setRandomRange(lo, hi); } catch (e2) { /* 忽略 */ }
            }
            state.proactiveRandomMin = lo;
            state.proactiveRandomMax = hi;
            state.settingsMap.proactive_random_min = lo;
            state.settingsMap.proactive_random_max = hi;
            if (!destroyed) render();
            toast('随机间隔已设为 ' + randomBoundLabel(lo) + '~' + randomBoundLabel(hi));
          })
          .catch(function (e) {
            toast('保存失败：' + errText(e));
          });
      }

      function proactive() {
        return App.Proactive || null;
      }

      // 开关：App.Proactive 存在时交给它处理权限与调度，否则直接写 settings
      async function onProactiveToggle(checked) {
        var next = !!checked;
        var P = proactive();
        try {
          if (P && typeof P.setEnabled === 'function') {
            await P.setEnabled(next);
          } else {
            await DB.settings.set('proactive_enabled', next);
          }
          // 兜底确保 DB 与 UI 状态一致（setEnabled 内部也会写，重复写同值无害）
          try {
            await DB.settings.set('proactive_enabled', next);
          } catch (e0) {
            /* 忽略兜底写失败，以 setEnabled 结果为准 */
          }
          state.proactiveEnabled = next;
          state.settingsMap.proactive_enabled = next;
          if (!next) {
            toast('已关闭角色主动消息');
            return;
          }
          // 通知权限：不阻止开启，仅提示前台生效
          var permission = '';
          try {
            if (P && typeof P.status === 'function') {
              var st = await P.status();
              permission = (st && st.permission) || '';
            }
          } catch (e1) {
            permission = '';
          }
          if (permission === 'denied') {
            toast('已开启；通知权限未授予，仅 App 打开时生效');
          } else {
            toast('已开启角色主动消息');
          }
        } catch (e) {
          // 失败回滚开关视觉状态（state 未改，重新渲染即可恢复）
          if (!destroyed) render();
          toast(next ? '开启失败，请重试' : '关闭失败，请重试');
        }
      }

      function chooseProactiveInterval() {
        var items = PROACTIVE_INTERVALS.map(function (n) {
          return { id: n, value: n, label: n + ' 分钟' };
        });
        items.push({
          id: 'random',
          value: PROACTIVE_RANDOM_INTERVAL,
          label: '随机间隔（0~24 小时，可调上下限）',
          desc: '时间到后角色会先读上下文，再决定这次发不发；每次都会重新随机'
        });
        var selected = state.proactiveIntervalMin === PROACTIVE_RANDOM_INTERVAL ? 'random' : state.proactiveIntervalMin;
        var task;
        try {
          if (UI && typeof UI.sheet === 'function') {
            task = Promise.resolve(
              UI.sheet({
                title: '主动消息间隔',
                items: items,
                selected: selected
              })
            );
          } else {
            task = fallbackPick('主动消息间隔', items);
          }
        } catch (e) {
          task = fallbackPick('主动消息间隔', items);
        }
        Promise.resolve(task)
          .then(async function (picked) {
            if (picked === null || picked === undefined) return;
            var raw = normalizePick(picked);
            var n = raw === 'random' ? PROACTIVE_RANDOM_INTERVAL : normalizeProactiveInterval(raw);
            if (n !== PROACTIVE_RANDOM_INTERVAL && PROACTIVE_INTERVALS.indexOf(n) < 0) return;
            await DB.settings.set('proactive_interval_min', n);
            // 同步给前端轮询器（存在时）；它内部可能也会写一次 DB
            var P = proactive();
            if (P && typeof P.setIntervalMin === 'function') {
              try {
                P.setIntervalMin(n);
              } catch (e2) {
                /* 忽略 */
              }
            }
            state.proactiveIntervalMin = n;
            state.settingsMap.proactive_interval_min = n;
            if (!destroyed) render();
            toast('已设为' + (n === PROACTIVE_RANDOM_INTERVAL ? '随机间隔，可在下方调整上下限' : ' ' + n + ' 分钟'));
          })
          .catch(function (e) {
            toast('保存失败：' + errText(e));
          });
      }

      // ---------- 聊天界面（v1.3.0：样式 / 背景 / 我的头像，数据源 App.Style） ----------
      function styleApi() {
        return App.Style || null;
      }

      function requireStyle() {
        var S = styleApi();
        if (!S || typeof S.setStyle !== 'function') {
          toast('聊天界面模块不可用，请重启 App');
          return null;
        }
        return S;
      }

      function chatStyleId() {
        var S = styleApi();
        try {
          if (S && typeof S.getStyle === 'function') return S.getStyle();
        } catch (e) {
          /* 用兜底副本 */
        }
        return state.chatStyle;
      }

      function chatStyleLabel() {
        var S = styleApi();
        var id = chatStyleId();
        try {
          if (S && typeof S.styleName === 'function') return S.styleName(id);
        } catch (e) {
          /* 用兜底文案 */
        }
        var fallback = { wechat: '微信', imessage: 'iMessage', qq: 'QQ' };
        return fallback[id] || '微信';
      }

      function hasChatBg() {
        var S = styleApi();
        try {
          if (S && typeof S.getBackground === 'function') return !!S.getBackground();
        } catch (e) {
          /* 用兜底副本 */
        }
        return !!state.chatBg;
      }

      function hasUserAvatar() {
        var S = styleApi();
        try {
          if (S && typeof S.getUserAvatar === 'function') return !!S.getUserAvatar();
        } catch (e) {
          /* 用兜底副本 */
        }
        return !!state.userAvatar;
      }

      function pickStyleImage() {
        var M = App.Media;
        if (!M || typeof M.pickImage !== 'function') return Promise.reject(new Error('相册功能不可用'));
        return Promise.resolve(M.pickImage());
      }

      // 通用选择面板：优先 UI.sheet，失败时用内置兜底面板；返回选中的 value
      function openPickSheet(title, items, selected) {
        var task;
        try {
          if (UI && typeof UI.sheet === 'function') {
            task = Promise.resolve(UI.sheet({ title: title, items: items, selected: selected }));
          } else {
            task = fallbackPick(title, items);
          }
        } catch (e) {
          task = fallbackPick(title, items);
        }
        return Promise.resolve(task).then(function (picked) {
          if (picked === null || picked === undefined) return null;
          return normalizePick(picked);
        });
      }

      function chooseChatStyle() {
        var S = requireStyle();
        if (!S) return;
        var styles =
          Array.isArray(S.STYLES) && S.STYLES.length
            ? S.STYLES
            : [{ id: 'wechat', name: '微信', desc: '绿色气泡，默认样式' }];
        var items = styles.map(function (s) {
          return { id: s.id, value: s.id, label: s.name || s.id, desc: s.desc || '' };
        });
        openPickSheet('聊天界面样式', items, chatStyleId())
          .then(async function (id) {
            if (!id || id === chatStyleId()) return;
            await S.setStyle(id);
            state.chatStyle = id;
            state.settingsMap.chat_style = id;
            if (!destroyed) render();
            toast('已切换为' + chatStyleLabel());
          })
          .catch(function (e) {
            toast('切换失败：' + errText(e));
            if (!destroyed) render();
          });
      }

      // 背景 / 头像共用的相册选择 -> 写入流程
      function pickAndApplyImage(kind) {
        var S = requireStyle();
        if (!S) return;
        var isBg = kind === 'bg';
        var setter = isBg ? S.setBackground : S.setUserAvatar;
        if (typeof setter !== 'function') {
          toast('聊天界面模块不可用，请重启 App');
          return;
        }
        pickStyleImage()
          .then(async function (att) {
            if (!att || !att.dataUri) return; // 用户取消
            await setter.call(S, att.dataUri);
            if (isBg) {
              state.chatBg = att.dataUri;
              state.settingsMap.chat_bg = att.dataUri;
            } else {
              state.userAvatar = att.dataUri;
              state.settingsMap.user_avatar = att.dataUri;
            }
            if (!destroyed) render();
            toast(isBg ? '聊天背景已更新' : '头像已更新');
          })
          .catch(function (e) {
            toast((isBg ? '设置背景失败：' : '设置头像失败：') + errText(e));
          });
      }

      // 恢复默认：背景 / 头像共用
      function clearStyleImage(kind) {
        var S = requireStyle();
        if (!S) return;
        var isBg = kind === 'bg';
        var clearer = isBg ? S.clearBackground : S.clearUserAvatar;
        if (typeof clearer !== 'function') {
          toast('聊天界面模块不可用，请重启 App');
          return;
        }
        Promise.resolve(clearer.call(S))
          .then(function () {
            if (isBg) {
              state.chatBg = '';
              state.settingsMap.chat_bg = '';
            } else {
              state.userAvatar = '';
              state.settingsMap.user_avatar = '';
            }
            if (!destroyed) render();
            toast(isBg ? '已恢复默认聊天背景' : '已恢复默认头像');
          })
          .catch(function (e) {
            toast('恢复默认失败：' + errText(e));
          });
      }

      function chooseChatBg() {
        var items = [{ id: 'pick', value: 'pick', label: '从相册选择', desc: '选择一张图片作为聊天页背景' }];
        if (hasChatBg()) {
          items.push({ id: 'clear', value: 'clear', label: '恢复默认', desc: '清除当前自定义背景', danger: true });
        }
        openPickSheet('聊天背景', items, '')
          .then(function (action) {
            if (action === 'pick') pickAndApplyImage('bg');
            else if (action === 'clear') clearStyleImage('bg');
          })
          .catch(function (e) {
            toast('操作失败：' + errText(e));
          });
      }

      function chooseUserAvatar() {
        var items = [{ id: 'pick', value: 'pick', label: '从相册选择', desc: '选择一张图片作为你的头像' }];
        if (hasUserAvatar()) {
          items.push({ id: 'clear', value: 'clear', label: '恢复默认', desc: '恢复为默认头像', danger: true });
        }
        openPickSheet('我的头像', items, '')
          .then(function (action) {
            if (action === 'pick') pickAndApplyImage('avatar');
            else if (action === 'clear') clearStyleImage('avatar');
          })
          .catch(function (e) {
            toast('操作失败：' + errText(e));
          });
      }

      function render() {
        if (destroyed) return;
        wrap.textContent = '';

        if (state.loading) {
          wrap.appendChild(loadingBox('正在读取设置…'));
          return;
        }
        if (state.error) {
          wrap.appendChild(
            errorBox('读取设置失败', errText(state.error), function () {
              loadAndRender();
            })
          );
          return;
        }

        // 外观
        wrap.appendChild(
          group('外观', [
            cell({
              title: '主题',
              sub: '浅色 / 深色 / AMOLED 纯黑，切换后立即生效',
              value: themeLabel(),
              chev: true,
              onClick: chooseTheme
            }),
            cell({
              title: '默认预设',
              sub: '新建会话时默认使用的生成参数预设',
              value: state.defaultPreset ? state.defaultPreset.name || '未命名预设' : '未设置',
              chev: true,
              onClick: chooseDefaultPreset
            })
          ])
        );

        // 补全设置
        wrap.appendChild(
          group('补全设置', [
            cell({
              title: '默认补全 API',
              sub: '创建角色 / 补全世界观时的默认供应商',
              value: genProviderLabel(),
              chev: true,
              onClick: chooseGenProvider
            }),
            cell({
              title: '默认补全模型',
              sub: '留空则跟随该 API 的默认模型',
              value: state.genModel || '跟随 API 默认',
              chev: true,
              onClick: editGenModel
            })
          ])
        );

        // 角色与聊天（本次迭代新增：上帝模式开关 + 图片库/发图帮助入口）
        wrap.appendChild(
          group('角色与聊天', [
            switchCell({
              title: '上帝模式',
              sub: '开启后角色知道自己只是虚拟角色，可以和你聊这件事',
              checked: state.godMode,
              dataset: { guideFocus: 'godMode' },
              onChange: onGodModeToggle
            }),
            cell({
              title: '图片库与发图',
              sub: '在角色编辑页管理角色图片库；聊天页和帮助抽屉可以发送图片与文件',
              chev: true,
              dataset: { guideFocus: 'mediaHelp' },
              onClick: openMediaHelp
            })
          ])
        );

        // 聊天界面（v1.3.0）：样式 / 背景 / 我的头像
        wrap.appendChild(
          group('聊天界面', [
            cell({
              title: '聊天界面样式',
              sub: '聊天页气泡风格与配色，切换后立即生效',
              value: chatStyleLabel(),
              chev: true,
              dataset: { guideFocus: 'chatStyle' },
              onClick: chooseChatStyle
            }),
            cell({
              title: '聊天背景',
              sub: '从相册选择一张图片作为聊天页背景',
              value: hasChatBg() ? '已设置' : '默认',
              chev: true,
              dataset: { guideFocus: 'chatBg' },
              onClick: chooseChatBg
            }),
            cell({
              title: '我的头像',
              sub: '聊天中显示在你自己消息旁的头像',
              value: hasUserAvatar() ? '已设置' : '默认',
              chev: true,
              dataset: { guideFocus: 'userAvatar' },
              onClick: chooseUserAvatar
            })
          ])
        );

        // 角色主动消息（v1.2.0）：开关 + 间隔选择
        wrap.appendChild(
          group('角色主动消息', [
            switchCell({
              title: '允许角色主动发消息',
              sub: '空闲时角色可能主动找你聊天；锁屏/后台会以通知提醒（每天最多 3 条）',
              checked: state.proactiveEnabled,
              dataset: { guideFocus: 'proactive' },
              onChange: onProactiveToggle
            }),
            cell({
              title: '主动消息间隔',
              sub: state.proactiveIntervalMin === PROACTIVE_RANDOM_INTERVAL
                ? '到点后角色会先读上下文，再决定这次发不发'
                : '距上次聊天超过这个时长后，角色可能主动发来消息',
              value: proactiveIntervalLabel(state.proactiveIntervalMin),
              chev: true,
              onClick: chooseProactiveInterval
            }),
            state.proactiveIntervalMin === PROACTIVE_RANDOM_INTERVAL
              ? cell({
                  title: '随机间隔下限',
                  sub: '每次至少等待这么久',
                  value: randomBoundLabel(state.proactiveRandomMin),
                  chev: true,
                  onClick: function () { chooseRandomBound('min'); }
                })
              : null,
            state.proactiveIntervalMin === PROACTIVE_RANDOM_INTERVAL
              ? cell({
                  title: '随机间隔上限',
                  sub: '每次最多等待这么久（0~24 小时）',
                  value: randomBoundLabel(state.proactiveRandomMax),
                  chev: true,
                  onClick: function () { chooseRandomBound('max'); }
                })
              : null,
          ])
        );

        // 引导助手
        wrap.appendChild(
          group('引导助手', [
            guideCell(),
            cell({
              title: '使用帮助',
              sub: '向引导助手提问 App 用法与 API 配置问题',
              chev: true,
              onClick: openHelp
            }),
            cell({
              title: '关于',
              sub: '版本信息与产品说明',
              chev: true,
              onClick: goAbout
            }),
            cell({
              title: '版本',
              value: state.version || '未知'
            })
          ])
        );

        // 悬浮助手气泡
        wrap.appendChild(
          group('悬浮助手气泡', [
            switchCell({
              title: '显示悬浮气泡',
              sub: '常驻小球的快捷问引导入口（可拖动、可关闭）',
              checked: state.bubbleEnabled,
              onChange: onBubbleToggle
            }),
            cell({
              title: '重置气泡位置',
              sub: '恢复到右侧边缘、垂直约 62% 的位置',
              chev: true,
              onClick: resetBubblePosition
            })
          ])
        );

        // 数据
        wrap.appendChild(
          group('数据', [
            cell({
              title: '导出备份',
              sub: '导出全部数据为 JSON 文件（不含 API Key）',
              value: state.exporting ? '导出中…' : '',
              chev: true,
              onClick: exportBackup
            }),
            cell({
              title: '导入备份',
              sub: '从 JSON 备份恢复（会覆盖当前全部数据）',
              value: state.importing ? '导入中…' : '',
              chev: true,
              onClick: importBackup
            }),
            cell({
              title: '清空数据',
              sub: '删除全部本机数据与 API Key，并重新进入引导',
              right: el('div', { class: 'cfg-danger-label', text: '清空' }),
              chev: false,
              danger: true,
              onClick: clearAllData
            })
          ])
        );

        wrap.appendChild(
          el('div', {
            class: 'cfg-footnote',
            text: '所有数据只保存在本机；API Key 存放在系统加密存储中，不会写入数据库、不会出现在导出备份里。'
          })
        );

        updateGuide();
      }

      // ---------- 主题 ----------
      function chooseTheme() {
        pickSheet('选择主题', [
          { label: '浅色', value: 'light' },
          { label: '深色', value: 'dark' },
          { label: 'AMOLED（纯黑）', value: 'amoled' }
        ]).then(async function (picked) {
          if (!picked) return;
          try {
            if (UI && typeof UI.setTheme === 'function') {
              await UI.setTheme(picked);
            }
            await DB.settings.set('theme', picked);
            state.theme = picked;
            if (!destroyed) render();
            toast('已切换为' + (THEME_LABELS[picked] || picked) + '主题');
          } catch (e) {
            toast('切换主题失败：' + errText(e));
          }
        });
      }

      // ---------- 默认预设 ----------
      function chooseDefaultPreset() {
        if (!state.presets.length) {
          toast('暂无可用预设，请先在角色相关页面创建预设');
          return;
        }
        var items = state.presets.map(function (p) {
          return { label: p.name || '未命名预设', value: p.id };
        });
        pickSheet('默认预设', items).then(async function (picked) {
          if (!picked) return;
          try {
            await DB.settings.set('default_preset_id', picked);
            state.defaultPreset = findById(state.presets, picked);
            if (!destroyed) render();
            toast('已设置默认预设');
          } catch (e) {
            toast('保存失败：' + errText(e));
          }
        });
      }

      // ---------- 补全设置 ----------
      function chooseGenProvider() {
        if (!state.providers.length) {
          toast('还没有配置 API，请先到「API 管理」添加');
          return;
        }
        var items = state.providers.map(function (p) {
          return {
            label: (p.name || '未命名 API') + (p.role === 'guide' ? '（引导）' : ''),
            value: p.id
          };
        });
        pickSheet('补全使用哪个 API', items).then(async function (picked) {
          if (!picked) return;
          try {
            await DB.settings.set('character_gen_provider_id', picked);
            state.genProvider = findById(state.providers, picked);
            // 换 API 后若原来没有自定义模型，则沿用新 API 的默认模型
            if (state.genProvider && !state.genModel) {
              await DB.settings.set('character_gen_model', state.genProvider.defaultModel || '');
              state.genModel = state.genProvider.defaultModel || '';
            }
            if (!destroyed) render();
            toast('已设置默认补全 API');
          } catch (e) {
            toast('保存失败：' + errText(e));
          }
        });
      }

      function editGenModel() {
        safePrompt({
          title: '默认补全模型',
          message: '留空表示跟随所选 API 的默认模型',
          placeholder: '例如 gpt-4o-mini',
          value: state.genModel || '',
          okText: '保存',
          cancelText: '取消'
        }).then(async function (value) {
          if (value === null || value === undefined) return;
          var model = String(value).trim();
          try {
            await DB.settings.set('character_gen_model', model);
            state.genModel = model;
            if (!destroyed) render();
            toast('已保存默认补全模型');
          } catch (e) {
            toast('保存失败：' + errText(e));
          }
        });
      }

      // ---------- 引导助手 / 关于 ----------
      function openHelp() {
        try {
          if (App.Help && typeof App.Help.open === 'function') {
            App.Help.open({ source: 'settings_help' });
          } else {
            toast('引导助手尚未就绪，请稍后再试');
          }
        } catch (e) {
          toast('无法打开帮助：' + errText(e));
        }
      }

      function goAbout() {
        try {
          App.Router.push('about', {});
        } catch (e) {
          toast('关于页暂不可用：' + errText(e));
        }
      }

      function goApiList() {
        try {
          App.Router.tab('apiList');
        } catch (e) {
          try {
            App.Router.push('apiList', {});
          } catch (e2) {
            toast('无法打开 API 管理');
          }
        }
      }

      // ---------- 悬浮气泡 ----------
      async function onBubbleToggle(checked) {
        state.bubbleEnabled = !!checked;
        try {
          await DB.settings.set('bubble_enabled', !!checked);
          refreshBubble();
          toast(checked ? '已开启悬浮气泡' : '已关闭悬浮气泡');
        } catch (e) {
          toast('保存失败：' + errText(e));
        }
      }

      async function resetBubblePosition() {
        try {
          await DB.settings.set('bubble_position', {
            edge: BUBBLE_DEFAULT_POSITION.edge,
            y: BUBBLE_DEFAULT_POSITION.y
          });
          state.bubblePosition = {
            edge: BUBBLE_DEFAULT_POSITION.edge,
            y: BUBBLE_DEFAULT_POSITION.y
          };
          refreshBubble();
          toast('已重置悬浮气泡位置');
        } catch (e) {
          toast('重置失败：' + errText(e));
        }
      }

      // ---------- 数据：导出 ----------
      function timestampName() {
        var d = new Date();
        function p(n) {
          return (n < 10 ? '0' : '') + n;
        }
        return (
          d.getFullYear() +
          p(d.getMonth() + 1) +
          p(d.getDate()) +
          '-' +
          p(d.getHours()) +
          p(d.getMinutes()) +
          p(d.getSeconds())
        );
      }

      // Provider 只保留元数据，双重保险地剔除 Key 字段（DB 本就不存 Key）
      function sanitizeProviders(list) {
        return (list || []).map(function (p) {
          var copy = {};
          Object.keys(p || {}).forEach(function (k) {
            if (k === 'apiKey' || k === 'api_key' || k === 'key') return;
            copy[k] = p[k];
          });
          return copy;
        });
      }

      async function exportBackup() {
        if (state.exporting || state.importing) return;
        state.exporting = true;
        if (!destroyed) render();
        try {
          // 优先复用 db.js 的导出格式：{ app:'aichat', version:1, exportedAt, tables, settings }
          var payload = null;
          if (DB && typeof DB.exportAll === 'function') {
            payload = await DB.exportAll();
          }
          if (!payload || typeof payload !== 'object') {
            payload = { app: 'aichat', version: 1, exportedAt: Util.now(), tables: {}, settings: {} };
            var tables = [
              'providers',
              'characters',
              'worldviews',
              'presets',
              'sessions',
              'messages',
              'personas',
              'helpSessions',
              'helpMessages'
            ];
            for (var i = 0; i < tables.length; i++) {
              payload.tables[tables[i]] = await DB.all(tables[i]);
            }
            payload.settings = settingsMapOf(await DB.settings.all());
          }
          if (!payload.tables || typeof payload.tables !== 'object') payload.tables = {};
          if (!payload.settings || typeof payload.settings !== 'object') {
            payload.settings = settingsMapOf(await DB.settings.all());
          }
          if (!payload.app) payload.app = 'aichat';
          if (!payload.version) payload.version = 1;
          if (!payload.exportedAt) payload.exportedAt = Util.now();
          // 双重保险：即使 DB 里存过 apiKey 字段也不会进入备份
          payload.tables.providers = sanitizeProviders(
            payload.tables.providers || (await DB.all('providers'))
          );

          var text = JSON.stringify(payload);
          var name = 'ai-chat-backup-' + timestampName() + '.json';
          var res = await App.Bridge.call('file.export', {
            name: name,
            mime: 'application/json',
            data: text
          });
          if (res && res.ok === false) {
            toast('导出失败：' + (res.message || '未知原因'));
          } else {
            toast('备份已导出（不含 API Key）');
          }
        } catch (e) {
          toast('导出失败：' + errText(e));
        } finally {
          state.exporting = false;
          if (!destroyed) render();
        }
      }

      // ---------- 数据：导入 ----------
      async function importBackup() {
        if (state.importing || state.exporting) return;
        state.importing = true;
        if (!destroyed) render();
        try {
          var file = await App.Bridge.call('file.import', {});
          if (!file || !file.data) {
            toast('没有读取到备份文件');
            return;
          }
          var payload = null;
          try {
            payload = JSON.parse(String(file.data).replace(/^\uFEFF/, ''));
          } catch (e) {
            // 兜底：允许带代码围栏 / 尾逗号等轻微损坏的 JSON
            if (Util && typeof Util.parseJSONLoose === 'function') {
              payload = Util.parseJSONLoose(String(file.data));
            }
          }
          if (!payload || typeof payload !== 'object') {
            toast('文件不是有效的 JSON');
            return;
          }
          // 兼容 db.js 导出格式（tables）与旧版自建格式（data）
          var appName = payload.app || '';
          if (appName !== 'ai-chat-app' && appName !== 'aichat') {
            toast('这不是本 App 导出的备份文件');
            return;
          }
          if (Number(payload.version) !== 1) {
            toast('备份版本不受支持（v' + String(payload.version || '?') + '）');
            return;
          }
          var data = payload.tables || payload.data;
          if (!data || typeof data !== 'object') {
            toast('备份内容结构不正确');
            return;
          }

          var ok = await safeConfirm({
            title: '导入备份',
            message:
              '导入会先清空当前全部数据，再用备份内容覆盖，操作不可撤销。注意：备份不含 API Key，导入后需要到「API 管理」重新填写 Key。',
            okText: '继续导入',
            cancelText: '取消'
          });
          if (!ok) return;

          // 清空旧数据前先删除旧 Key，避免遗留
          var oldProviders = await DB.all('providers');
          for (var i = 0; i < oldProviders.length; i++) {
            if (oldProviders[i] && oldProviders[i].id) await deleteKeyOf(oldProviders[i].id);
          }

          var tables = [
            'providers',
            'characters',
            'worldviews',
            'presets',
            'sessions',
            'messages',
            'personas',
            'helpSessions',
            'helpMessages'
          ];
          for (var t = 0; t < tables.length; t++) {
            await DB.clear(tables[t]);
          }
          for (var t2 = 0; t2 < tables.length; t2++) {
            var rows = Array.isArray(data[tables[t2]]) ? data[tables[t2]] : [];
            for (var r = 0; r < rows.length; r++) {
              var row = rows[r];
              // 允许缺省 id（DB.put 会自动生成），但只接受对象行
              if (row && typeof row === 'object') await DB.put(tables[t2], row);
            }
          }

          // 设置项重写
          await DB.clear('settings');
          var entries = settingsEntriesOf(payload.settings);
          for (var s = 0; s < entries.length; s++) {
            await DB.settings.set(entries[s].key, entries[s].value);
          }

          // 主题立即生效
          try {
            var theme = await DB.settings.get('theme', null);
            if (theme && UI && typeof UI.setTheme === 'function') await UI.setTheme(theme);
          } catch (e) {
            /* 忽略主题失败 */
          }
          refreshBubble();

          toast('导入完成');
          var completed = await DB.settings.get('onboarding_completed', false);
          if (completed) {
            goChatList();
          } else {
            goOnboarding();
          }
        } catch (e) {
          toast('导入失败：' + errText(e));
        } finally {
          state.importing = false;
          if (!destroyed) render();
        }
      }

      // ---------- 数据：清空 ----------
      async function clearAllData() {
        var ok = await safeConfirm({
          title: '清空数据',
          message:
            '将删除本机的全部聊天记录、角色、世界观、预设、API 配置与设置，并清除所有 API Key。此操作不可恢复。',
          okText: '继续',
          cancelText: '取消'
        });
        if (!ok) return;

        var typed = await safePrompt({
          title: '确认清空',
          message: '请输入「删除」两个字以确认清空全部数据',
          placeholder: '删除',
          value: '',
          okText: '清空',
          cancelText: '取消'
        });
        if (typed === null || typed === undefined) return;
        if (String(typed).trim() !== '删除') {
          toast('输入不匹配，已取消清空');
          return;
        }

        try {
          var providers = await DB.all('providers');
          for (var i = 0; i < providers.length; i++) {
            if (providers[i] && providers[i].id) await deleteKeyOf(providers[i].id);
          }
          await DB.clearAll();
          try {
            if (UI && typeof UI.setTheme === 'function') await UI.setTheme('light');
          } catch (e) {
            /* 忽略 */
          }
          refreshBubble();
          toast('已清空全部数据');
          goOnboarding();
        } catch (e) {
          toast('清空失败：' + errText(e));
        }
      }

      function goChatList() {
        try {
          App.Router.tab('chatList');
        } catch (e) {
          try {
            App.Router.push('chatList', {});
          } catch (e2) {
            toast('无法进入聊天列表');
          }
        }
      }

      function goOnboarding() {
        try {
          // main.js 提供的统一入口：会清空页面栈并强制重新引导
          if (typeof App.recheckOnboarding === 'function') {
            App.recheckOnboarding();
            return;
          }
          App.Router.push('onboarding', { firstRun: true }, { root: true, noBack: true, fullscreen: true });
        } catch (e) {
          toast('无法进入引导：' + errText(e));
        }
      }

      // ---------- 启动 ----------
      render();
      await loadAndRender();
    }
  });
})();
