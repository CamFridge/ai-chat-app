/* ============================================================
 * api-list.js —— API 管理（底部 Tab）
 * 职责：列出全部供应商（含引导 API / 默认聊天 API 徽标与最近连通状态）、
 *       新增 / 编辑入口、测试连接、设为默认聊天 API、设为引导 API、
 *       复制配置（不含 Key）、删除（含后果确认与 Key 清除）。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App;

  App.Router.register('apiList', {
    tab: true,
    title: 'API 管理',
    tabLabel: 'API',
    tabIcon: 'api',

    async build(root, params, page) {
      var UI = App.UI;
      var Util = App.Util;
      var DB = App.DB;

      var state = {
        loading: true,
        error: null,
        providers: [],
        guideId: null,
        defaultId: null
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

      function getErrorInfo(error) {
        try {
          if (App.API && typeof App.API.errorInfo === 'function') {
            return App.API.errorInfo(error) || {};
          }
        } catch (e) {
          /* 降级 */
        }
        return { code: error && error.code, title: '连接失败', hint: '请检查配置后重试。' };
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

      // ---------- 页面骨架 ----------
      root.textContent = '';
      var wrap = el('div', { class: 'cfg-page cfg-api-page' });
      root.appendChild(wrap);

      page.setActions([
        {
          icon: 'plus',
          label: '新增 API',
          onClick: function () {
            App.Router.push('apiEdit', {});
          }
        }
      ]);

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

      // 从编辑页返回 / 切回本 Tab 时刷新列表
      try {
        unsubRoute = App.Router.onChange(function (info) {
          var name = typeof info === 'string' ? info : info && info.name;
          // 注意：page.guide() 内部会同步 notify()，这里不排除自身 guide 调用会形成刷新死循环
          if (name === 'apiList' && !destroyed && !inGuide) scheduleRefresh();
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
          var results = await Promise.all([
            DB.all('providers'),
            DB.settings.get('guide_provider_id', null),
            DB.settings.get('default_chat_provider_id', null)
          ]);
          state.providers = (results[0] || []).slice().sort(function (a, b) {
            var ag = a.role === 'guide' ? 0 : 1;
            var bg = b.role === 'guide' ? 0 : 1;
            if (ag !== bg) return ag - bg;
            return String(a.name || '').localeCompare(String(b.name || ''));
          });
          state.guideId = results[1] || null;
          state.defaultId = results[2] || null;
        } catch (e) {
          state.error = e;
        }
        state.loading = false;
      }

      async function loadAndRender() {
        await load();
        if (!destroyed) render();
      }

      function updateGuide() {
        inGuide = true;
        try {
          page.guide({
            pageId: 'apiList',
            title: 'API 管理',
            stage: null,
            totalSteps: null,
            filledFields: { hasProvider: state.providers.length > 0 },
            missingFields: state.providers.length > 0 ? [] : ['provider'],
            error: state.error ? { code: 'unknown', message: errText(state.error) } : null
          });
        } catch (e) {
          /* 忽略 */
        } finally {
          inGuide = false;
        }
      }

      function effectiveGuideId() {
        for (var i = 0; i < state.providers.length; i++) {
          if (state.providers[i] && state.providers[i].role === 'guide') return state.providers[i].id;
        }
        return state.guideId;
      }

      // ---------- 通用块 ----------
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

      function emptyBox() {
        return el(
          'div',
          { class: 'empty cfg-empty' },
          el('div', { class: 'empty-icon', html: UI.icon('api') }),
          el('div', { class: 'empty-title', text: '还没有配置 API' }),
          el('div', {
            class: 'empty-desc',
            text: '首次使用需要先配置一个引导 API，它同时负责帮助问答与角色 / 世界观补全。'
          }),
          el(
            'div',
            { class: 'cfg-empty-actions' },
            el('button', {
              class: 'btn primary',
              attrs: { type: 'button' },
              text: '去引导配置',
              on: {
                click: function () {
                  App.Router.push('onboarding', {});
                }
              }
            }),
            el('button', {
              class: 'btn',
              attrs: { type: 'button' },
              text: '新增 API',
              on: {
                click: function () {
                  App.Router.push('apiEdit', {});
                }
              }
            })
          )
        );
      }

      function statusBadge(p) {
        var status = p && p.lastStatus;
        var cls = 'cfg-badge cfg-status-unknown';
        var text = '未测试';
        if (status === 'ok') {
          cls = 'cfg-badge cfg-status-ok';
          text = '连通';
        } else if (status === 'error') {
          cls = 'cfg-badge cfg-status-error';
          text = '失败';
        }
        return el('span', { class: cls, text: text, attrs: status === 'error' && p.lastError && p.lastError.message ? { title: String(p.lastError.message) } : {} });
      }

      // ---------- 列表行 ----------
      function providerRow(p) {
        var guideId = effectiveGuideId();
        var isGuide = p.role === 'guide' || p.id === guideId;
        var isDefault = p.id === state.defaultId;

        var title = el(
          'div',
          { class: 'title cfg-row-title' },
          el('span', { class: 'cfg-row-name ellipsis', text: p.name || '未命名 API' }),
          isGuide ? el('span', { class: 'badge green cfg-badge', text: '引导' }) : null,
          isDefault ? el('span', { class: 'badge gray cfg-badge', text: '默认' }) : null
        );
        var sub = el('div', { class: 'sub cfg-row-sub ellipsis', text: p.baseUrl || '未填写 Base URL' });
        var modelCount = p.models && p.models.length ? ' · 共 ' + p.models.length + ' 个模型' : '';
        var sub2 = el('div', {
          class: 'cfg-row-sub2 ellipsis',
          text: (p.defaultModel ? '模型：' + p.defaultModel : '未设置默认模型') + modelCount
        });
        var main = el('div', { class: 'main' }, title, sub, sub2);
        var meta = el(
          'div',
          { class: 'meta cfg-row-meta' },
          statusBadge(p),
          el('div', {
            class: 'cfg-row-time small muted',
            text: p.lastCheckedAt ? Util.fmtTime(p.lastCheckedAt) : ''
          })
        );

        var moreBtn = el('button', {
          class: 'cfg-more',
          attrs: { type: 'button', 'aria-label': '更多操作' },
          html: UI.icon('more')
        });
        moreBtn.addEventListener('click', function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          if (ev && ev.preventDefault) ev.preventDefault();
          openMenu(p);
        });

        var row = el(
          'div',
          { class: 'cell cfg-api-row', dataset: { id: p.id } },
          el('div', { class: 'avatar cfg-api-avatar', html: UI.icon('api') }),
          main,
          meta,
          moreBtn
        );

        // 长按等效「…」菜单（点击进编辑）
        var lastLongPress = 0;
        attachLongPress(row, function () {
          lastLongPress = Date.now();
          openMenu(p);
        });
        row.addEventListener('click', function (ev) {
          if (Date.now() - lastLongPress < 800) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
            return;
          }
          editProvider(p);
        });

        return row;
      }

      function attachLongPress(node, fn) {
        var timer = null;
        function clear() {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
        node.addEventListener(
          'touchstart',
          function () {
            clear();
            timer = setTimeout(function () {
              timer = null;
              try {
                if (navigator.vibrate) navigator.vibrate(10);
              } catch (e) {
                /* 忽略 */
              }
              fn();
            }, 550);
          },
          { passive: true }
        );
        node.addEventListener('touchend', clear, { passive: true });
        node.addEventListener('touchcancel', clear, { passive: true });
        node.addEventListener('touchmove', clear, { passive: true });
        node.addEventListener('contextmenu', function (ev) {
          if (ev && ev.preventDefault) ev.preventDefault();
          fn();
        });
      }

      // ---------- 渲染 ----------
      function render() {
        if (destroyed) return;
        wrap.textContent = '';

        if (state.loading) {
          wrap.appendChild(el('div', { class: 'cfg-list-wrap' }, loadingBox('正在读取 API 配置…')));
          return;
        }
        if (state.error) {
          wrap.appendChild(
            el(
              'div',
              { class: 'cfg-list-wrap' },
              errorBox('读取 API 配置失败', errText(state.error), function () {
                loadAndRender();
              })
            )
          );
          return;
        }
        if (!state.providers.length) {
          wrap.appendChild(emptyBox());
          updateGuide();
          return;
        }

        var list = el('div', { class: 'list cfg-api-list' });
        state.providers.forEach(function (p) {
          list.appendChild(providerRow(p));
        });
        wrap.appendChild(list);
        wrap.appendChild(
          el('div', {
            class: 'cfg-footnote',
            text: '提示：点「…」或长按可以测试连接、设为默认聊天 API、设为引导 API、复制配置或删除。'
          })
        );
        updateGuide();
      }

      // ---------- 操作 ----------
      function editProvider(p) {
        App.Router.push('apiEdit', { id: p.id });
      }

      async function testConnection(p) {
        toast('正在测试连接…');
        try {
          var res;
          if (App.API && typeof App.API.testProvider === 'function') {
            res = await App.API.testProvider(p);
          } else {
            res = await App.Bridge.call('net.test', { baseUrl: p.baseUrl, timeoutMs: 20000 });
          }
          var now = Util.now();
          p.lastCheckedAt = now;
          p.updatedAt = now;
          if (res && res.ok) {
            p.lastStatus = 'ok';
            p.lastError = null;
            if (Array.isArray(res.models)) p.models = res.models.filter(Boolean);
            await DB.put('providers', p);
            toast('连接成功' + (p.models && p.models.length ? '，共 ' + p.models.length + ' 个模型' : ''));
            await loadAndRender();
            return;
          }
          p.lastStatus = 'error';
          p.lastError = (res && res.error) || { code: 'unknown', message: '测试接口未返回结果' };
          await DB.put('providers', p);
          await loadAndRender();
          var info = getErrorInfo(p.lastError);
          var needHelp = await safeConfirm({
            title: '连接失败',
            message:
              (info.title || '连接失败') +
              (info.code ? '（' + info.code + '）' : '') +
              (info.hint ? '；' + info.hint : '') +
              (p.lastError && p.lastError.message ? '；原始信息：' + p.lastError.message : ''),
            okText: '这是什么意思？',
            cancelText: '知道了'
          });
          if (needHelp) openErrorHelp(p.lastError, p.name);
        } catch (e) {
          toast('测试失败：' + errText(e));
        }
      }

      function openErrorHelp(error, name) {
        try {
          if (App.Help && typeof App.Help.open === 'function') {
            App.Help.open({
              source: 'error_hint',
              page: 'API 管理' + (name ? ' · ' + name : ''),
              error: { code: (error && error.code) || 'unknown', message: (error && error.message) || '' }
            });
          } else {
            toast('引导助手尚未就绪');
          }
        } catch (e) {
          toast('无法打开帮助');
        }
      }

      async function setDefault(p) {
        try {
          if (state.defaultId === p.id) {
            await DB.settings.set('default_chat_provider_id', null);
            toast('已取消默认聊天 API');
          } else {
            await DB.settings.set('default_chat_provider_id', p.id);
            toast('已设为默认聊天 API');
          }
          await loadAndRender();
        } catch (e) {
          toast('设置失败：' + errText(e));
        }
      }

      async function setGuide(p) {
        if (p.role === 'guide') {
          toast('这已经是引导 API');
          return;
        }
        var ok = await safeConfirm({
          title: '设为引导 API',
          message:
            '将把「' +
            (p.name || '未命名 API') +
            '」设为引导 API：帮助问答、世界观与角色补全默认使用它；原来的引导 API 会自动降为普通聊天 API。',
          okText: '设为引导',
          cancelText: '取消'
        });
        if (!ok) return;
        try {
          var all = await DB.all('providers');
          for (var i = 0; i < all.length; i++) {
            var q = all[i];
            if (q && q.role === 'guide' && q.id !== p.id) {
              q.role = 'chat';
              q.updatedAt = Util.now();
              await DB.put('providers', q);
            }
          }
          p.role = 'guide';
          p.updatedAt = Util.now();
          await DB.put('providers', p);
          await DB.settings.set('guide_provider_id', p.id);
          toast('已设为引导 API');
          await loadAndRender();
        } catch (e) {
          toast('设置失败：' + errText(e));
        }
      }

      async function copyConfig(p) {
        var lines = [
          '名称：' + (p.name || ''),
          'Base URL：' + (p.baseUrl || ''),
          '默认模型：' + (p.defaultModel || ''),
          p.models && p.models.length ? '模型列表：' + p.models.join(', ') : '',
          '（不含 API Key）'
        ];
        var text = lines.filter(Boolean).join('\n');
        try {
          if (Util && typeof Util.copyText === 'function') {
            await Util.copyText(text);
          } else {
            await App.Bridge.call('ui.copy', { text: text });
          }
          toast('已复制配置（不含 Key）');
        } catch (e) {
          toast('复制失败：' + errText(e));
        }
      }

      async function deleteKeyOf(id) {
        try {
          // api.js 导出的删除方法名为 delKey；deleteKey 仅作兼容兜底
          if (App.API && typeof App.API.delKey === 'function') {
            await App.API.delKey(id);
            return;
          }
          if (App.API && typeof App.API.deleteKey === 'function') {
            await App.API.deleteKey(id);
            return;
          }
          await App.Bridge.call('secure.del', { key: 'key:' + id });
        } catch (e) {
          /* Key 不存在或原生失败时忽略，不阻断删除 */
        }
      }

      async function removeProvider(p) {
        var isGuide = p.role === 'guide';
        var isDefault = state.defaultId === p.id;
        var parts = [];
        if (isGuide) {
          parts.push('这是引导 API：删除后帮助问答与 AI 补全不可用，下次启动会重新进入引导流程。');
        }
        if (isDefault) {
          parts.push('这是默认聊天 API：删除后会清空「默认聊天 API」设置。');
        }
        parts.push('API Key 会一并从本机安全存储删除，操作不可恢复。');
        var ok = await safeConfirm({
          title: '删除「' + (p.name || '未命名 API') + '」',
          message: parts.join(' '),
          okText: '删除',
          cancelText: '取消'
        });
        if (!ok) return;

        try {
          await deleteKeyOf(p.id);
          await DB.del('providers', p.id);

          if (isGuide) {
            await DB.settings.set('guide_provider_id', null);
            // 引导 API 被删除 => 引导未完成，下次启动重新引导
            await DB.settings.set('onboarding_completed', false);
          }
          if (isDefault) {
            await DB.settings.set('default_chat_provider_id', null);
          }
          var genId = await DB.settings.get('character_gen_provider_id', null);
          if (genId === p.id) {
            await DB.settings.set('character_gen_provider_id', null);
            await DB.settings.set('character_gen_model', '');
          }
          toast(isGuide ? '已删除引导 API，需重新配置引导' : '已删除');
          await loadAndRender();
        } catch (e) {
          toast('删除失败：' + errText(e));
        }
      }

      async function openMenu(p) {
        var isDefault = state.defaultId === p.id;
        var isGuide = p.role === 'guide';
        var items = [
          { label: '测试连接', value: 'test' },
          { label: isDefault ? '取消默认聊天 API' : '设为默认聊天 API', value: 'default' },
          { label: isGuide ? '当前已是引导 API' : '设为引导 API', value: 'guide' },
          { label: '复制配置（不含 Key）', value: 'copy' },
          { label: '删除', value: 'delete', danger: true }
        ];
        if (isGuide) {
          items = items.filter(function (it) {
            return it.value !== 'guide';
          });
        }
        var picked = await pickSheet(p.name || 'API 操作', items);
        if (!picked) return;
        if (picked === 'test') return testConnection(p);
        if (picked === 'default') return setDefault(p);
        if (picked === 'guide') return setGuide(p);
        if (picked === 'copy') return copyConfig(p);
        if (picked === 'delete') return removeProvider(p);
      }

      // ---------- 启动 ----------
      render();
      await loadAndRender();
    }
  });
})();
