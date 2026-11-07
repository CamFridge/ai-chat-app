/* ============================================================
 * pages/lorebook.js —— 某角色的世界书条目列表（二级页）
 *
 * 参数：{ characterId }
 * 职责：展示条目数 / 启用态 / 优先级；点条目进编辑页；
 *       右下/底部按钮提供「一键生成条目」「新建条目」；
 *       右上「⋯」菜单可开关整本世界书、改 token 预算、重新加载。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App;

  App.Router.register('lorebook', {
    tab: false,
    title: '世界书',

    build: function (root, params, page) {
      var UI = App.UI;
      var U = App.Util;

      var state = {
        characterId: String((params && params.characterId) || ''),
        character: null,
        book: null,
        entries: [],
        loading: true,
        error: null,
        busy: false,
        ready: false,
        destroyed: false,
        offRouter: null
      };

      function el(tag, attrs) {
        var extra = Array.prototype.slice.call(arguments, 2);
        return UI.el.apply(UI, [tag, attrs].concat(extra));
      }

      function toast(text, type) {
        try { UI.toast(text, type); } catch (e) { /* 忽略 */ }
      }

      function errText(e) {
        if (!e) return '未知错误';
        if (typeof e === 'string') return e;
        if (e.message) return String(e.message);
        return '未知错误';
      }

      function nowMs() {
        try { return U.now(); } catch (e) { return Date.now(); }
      }

      function lorebookApi() {
        return App.Lorebook && typeof App.Lorebook.ensureForCharacter === 'function' ? App.Lorebook : null;
      }

      function budgetText() {
        var b = state.book;
        var n = b && b.tokenBudget ? Number(b.tokenBudget) : 0;
        if (!n) return '不限制';
        return n + ' tokens';
      }

      page.onDestroy(function () {
        state.destroyed = true;
        if (state.offRouter) {
          try { state.offRouter(); } catch (e) { /* 忽略 */ }
          state.offRouter = null;
        }
      });

      root.textContent = '';
      try { page.setTitle('世界书'); } catch (e) { /* 忽略 */ }

      var scroll = el('div', { class: 'lorebook-scroll' });
      root.appendChild(scroll);

      /* ---------------- 加载 ---------------- */

      function showLoading() {
        scroll.textContent = '';
        var box = el('div', { class: 'lorebook-loading-inline' });
        if (UI.spinnerEl) {
          try { box.appendChild(UI.spinnerEl()); } catch (e) { /* 忽略 */ }
        }
        box.appendChild(el('span', { text: '正在读取世界书…' }));
        scroll.appendChild(box);
      }

      function load(first) {
        var L = lorebookApi();
        if (!L) {
          state.loading = false;
          state.error = new Error('世界书模块未就绪');
          renderError();
          return Promise.resolve();
        }
        state.loading = true;
        state.error = null;
        if (first) showLoading();
        return (App.DB && typeof App.DB.get === 'function'
          ? App.DB.get('characters', state.characterId).catch(function () { return null; })
          : Promise.resolve(null)
        ).then(function (ch) {
          state.character = ch || null;
          return L.ensureForCharacter(state.characterId);
        }).then(function (book) {
          state.book = book;
          return L.listEntries(book.id);
        }).then(function (entries) {
          if (state.destroyed) return;
          state.entries = Array.isArray(entries) ? entries : [];
          state.loading = false;
          state.ready = true;
          renderAll();
          bindRouterChange();
        }).catch(function (err) {
          if (state.destroyed) return;
          state.loading = false;
          state.error = err;
          renderError();
        });
      }

      // 从编辑页 / 生成页返回时静默刷新（页面本身不重建）
      function bindRouterChange() {
        if (state.offRouter) return;
        if (!App.Router || typeof App.Router.onChange !== 'function') return;
        state.offRouter = App.Router.onChange(function (cur) {
          if (state.destroyed) return;
          if (!cur || cur.page !== page) return;
          // 首次进入时页面还没加载完，跳过；之后每次「回到本页」都刷新
          if (!state.ready) return;
          load(false);
        });
      }

      /* ---------------- 渲染 ---------------- */

      function renderAll() {
        renderOverview();
        renderList();
        renderPageActions();
      }

      function renderFatal(message) {
        scroll.textContent = '';
        scroll.appendChild(UI.errorState({
          icon: 'warning',
          title: '打不开世界书',
          desc: message,
          actionText: '返回',
          onAction: function () { App.Router.pop(); }
        }));
      }

      function renderError() {
        var msg = errText(state.error);
        var desc = '读取失败：' + msg + '\n数据表可能还没就绪，请重试；如果一直失败，请退出重进 App。';
        scroll.textContent = '';
        scroll.appendChild(el('div', { class: 'lorebook-error-wrap' }, UI.errorState({
          icon: 'warning',
          title: '世界书加载失败',
          desc: desc,
          actionText: '重试',
          onAction: function () { load(true); }
        })));
        try { page.setActions([{ icon: 'refresh', label: '重试', onClick: function () { load(true); } }]); } catch (e) { /* 忽略 */ }
      }

      function renderOverview() {
        var book = state.book;
        UI.clear(scroll);
        if (!book) return;

        var enabledCount = 0;
        var alwaysCount = 0;
        for (var i = 0; i < state.entries.length; i++) {
          if (state.entries[i].enabled !== false) enabledCount++;
          if (state.entries[i].alwaysOn) alwaysCount++;
        }

        var sw = el('div', { class: 'switch' + (book.enabled ? ' on' : ''), attrs: { role: 'switch', 'aria-checked': book.enabled ? 'true' : 'false', 'aria-label': '启用整本世界书' } });
        sw.addEventListener('click', function (ev) {
          ev.stopPropagation();
          toggleBook(book.enabled === false);
        });

        var head = el('div', { class: 'lorebook-overview' },
          el('div', { class: 'lorebook-overview-top' },
            el('div', { class: 'lorebook-overview-main' },
              el('div', { class: 'lorebook-overview-name', text: book.name || '世界书' }),
              el('div', { class: 'lorebook-overview-sub', text: book.enabled ? '已启用 · 提到触发词时自动注入设定' : '已关闭 · 聊天不会注入任何条目' })
            ),
            sw
          ),
          el('div', { class: 'lorebook-stats' },
            el('div', { class: 'lorebook-stat' },
              el('div', { class: 'lorebook-stat-num', text: String(state.entries.length) }),
              el('div', { class: 'lorebook-stat-label', text: '条目' })
            ),
            el('div', { class: 'lorebook-stat' },
              el('div', { class: 'lorebook-stat-num', text: String(enabledCount) }),
              el('div', { class: 'lorebook-stat-label', text: '启用' })
            ),
            el('div', { class: 'lorebook-stat' },
              el('div', { class: 'lorebook-stat-num', text: String(alwaysCount) }),
              el('div', { class: 'lorebook-stat-label', text: '常驻' })
            ),
            el('div', { class: 'lorebook-stat-grow' }),
            (function () {
              var b = el('button', { class: 'btn ghost small lorebook-budget-btn', attrs: { type: 'button' }, text: '预算 ' + budgetText() });
              b.addEventListener('click', function () { editBudget(); });
              return b;
            })()
          )
        );
        scroll.appendChild(head);

        var note = '世界书只在对话里出现触发词时注入对应设定；常驻条目每条消息都会带上。' +
          (state.entries.length ? '' : '先「一键生成条目」或手动新建一条试试。');
        scroll.appendChild(el('div', { class: 'lorebook-note', text: note }));

        var overflow = false;
        for (var k = 0; k < state.entries.length; k++) {
          var c = String(state.entries[k].content || '');
          if (U.estimateTokens && U.estimateTokens(c) > (book.tokenBudget || 0)) { overflow = true; break; }
        }
        if (overflow && book.tokenBudget) {
          scroll.appendChild(el('div', { class: 'lorebook-note warn', text: '有单条正文超过 ' + book.tokenBudget + ' tokens 预算，该条可能不会被注入。可以调大预算或精简正文。' }));
        }
      }

      function appendKeyChips(target, keys, max, cls) {
        var list = Array.isArray(keys) ? keys : [];
        for (var i = 0; i < list.length && i < max; i++) {
          target.appendChild(el('span', { class: 'lorebook-key' + (cls ? ' ' + cls : ''), text: String(list[i]) }));
        }
        if (list.length > max) {
          target.appendChild(el('span', { class: 'lorebook-key more', text: '+' + (list.length - max) }));
        }
      }

      function renderList() {
        var book = state.book;
        if (!book) return;

        if (!state.entries.length) {
          var wrap = el('div', { class: 'lorebook-empty-wrap' });
          wrap.appendChild(UI.empty({
            icon: 'world',
            title: '还没有世界书条目',
            desc: '条目就是一段设定：当对话里出现它的触发词时，这段设定会悄悄加进上下文，让角色记得更清楚。',
            actionText: '一键生成条目',
            onAction: goGenerate
          }));
          var manual = el('button', { class: 'btn outline small', attrs: { type: 'button' }, text: '手动新建一条' });
          manual.addEventListener('click', goNew);
          wrap.appendChild(manual);
          scroll.appendChild(wrap);
          return;
        }

        var listBox = el('div', { class: 'list section' });
        state.entries.forEach(function (entry) {
          listBox.appendChild(entryRow(entry));
        });
        scroll.appendChild(listBox);
        scroll.appendChild(el('div', {
          class: 'lorebook-note',
          text: '点条目可以编辑；右侧开关可以单独停用某条。共 ' + state.entries.length + ' 条。'
        }));
      }

      function entryRow(entry) {
        var displayName = String(entry.name || '').trim() || (entry.keys && entry.keys[0]) || '未命名条目';
        var row = el('div', {
          class: 'cell lorebook-entry' + (entry.enabled === false ? ' lorebook-entry-off' : ''),
          attrs: { role: 'button', tabindex: '0' }
        });

        var main = el('div', { class: 'lorebook-entry-main' });
        var head = el('div', { class: 'lorebook-entry-head' },
          el('span', { class: 'lorebook-entry-name', text: displayName })
        );
        if (entry.alwaysOn) head.appendChild(el('span', { class: 'badge orange', text: '常驻' }));
        if (entry.caseSensitive) head.appendChild(el('span', { class: 'badge', text: '区分大小写' }));
        main.appendChild(head);

        if ((entry.keys && entry.keys.length) || (entry.secondaryKeys && entry.secondaryKeys.length)) {
          var keysWrap = el('div', { class: 'lorebook-entry-keys' });
          appendKeyChips(keysWrap, entry.keys || [], 4);
          appendKeyChips(keysWrap, entry.secondaryKeys || [], 2, 'secondary');
          main.appendChild(keysWrap);
        }

        main.appendChild(el('div', { class: 'lorebook-entry-body', text: String(entry.content || '') }));
        row.appendChild(main);

        var side = el('div', { class: 'lorebook-entry-side' });
        side.appendChild(el('span', {
          class: 'lorebook-prio' + (Number(entry.priority) >= 150 ? ' high' : ''),
          text: 'P' + String(entry.priority === 0 ? 0 : (entry.priority || 100))
        }));
        var sw = el('div', {
          class: 'switch' + (entry.enabled === false ? '' : ' on'),
          attrs: { role: 'switch', 'aria-checked': entry.enabled === false ? 'false' : 'true', 'aria-label': '启用这条条目' }
        });
        sw.addEventListener('click', function (ev) {
          ev.stopPropagation();
          ev.preventDefault();
          toggleEntry(entry, entry.enabled === false);
        });
        side.appendChild(sw);
        row.appendChild(side);

        row.addEventListener('click', function () {
          gotoEdit(entry.id);
        });
        return row;
      }

      function renderPageActions() {
        var gen = el('button', { class: 'btn primary', attrs: { type: 'button' }, text: '一键生成条目' });
        gen.addEventListener('click', goGenerate);
        var add = el('button', { class: 'btn', attrs: { type: 'button' }, text: '新建条目' });
        add.addEventListener('click', goNew);
        UI.clear(root.querySelector('.page-actions'));
        var bar = root.querySelector('.page-actions');
        if (!bar) {
          bar = el('div', { class: 'page-actions' });
          root.appendChild(bar);
        }
        bar.appendChild(gen);
        bar.appendChild(add);

        try {
          page.setActions([{
            icon: 'more', label: '更多', onClick: openMore
          }]);
        } catch (e) { /* 忽略 */ }
      }

      /* ---------------- 导航 ---------------- */

      function goGenerate() {
        try {
          App.Router.push('lorebookGen', { characterId: state.characterId });
        } catch (e) {
          toast('打不开生成页：' + errText(e), 'error');
        }
      }

      function goNew() {
        gotoEdit('');
      }

      function gotoEdit(id) {
        try {
          App.Router.push('lorebookEdit', { characterId: state.characterId, id: id || '' });
        } catch (e) {
          toast('打不开编辑页：' + errText(e), 'error');
        }
      }

      /* ---------------- 更多菜单 / 整本开关 / 预算 ---------------- */

      function openMore() {
        var book = state.book;
        if (!book) {
          load(true);
          return;
        }
        var items = [
          { id: 'gen', label: '一键生成条目', desc: '按角色卡自动生成 3~6 条', icon: 'spark' },
          { id: 'new', label: '新建条目', icon: 'plus' },
          {
            id: 'bookToggle',
            label: book.enabled ? '关闭整本世界书' : '打开整本世界书',
            desc: book.enabled ? '关闭后聊天不再注入任何条目' : '打开后按触发词自动注入',
            icon: book.enabled ? 'pause' : 'play'
          },
          { id: 'budget', label: '设置 token 预算', desc: '当前 ' + budgetText(), icon: 'settings' },
          { id: 'refresh', label: '重新加载', icon: 'refresh' }
        ];
        UI.sheet({ title: book.name || '世界书', items: items }).then(function (item) {
          if (!item || state.destroyed) return;
          if (item.id === 'gen') return goGenerate();
          if (item.id === 'new') return goNew();
          if (item.id === 'bookToggle') return toggleBook(book.enabled === false);
          if (item.id === 'budget') return editBudget();
          if (item.id === 'refresh') return load(true);
          return null;
        }).catch(function (err) {
          console.warn('[lorebook] 菜单操作失败', err);
        });
      }

      function saveBook(patch) {
        var book = state.book;
        if (!book) return Promise.resolve(null);
        var rec = {};
        for (var k in book) {
          if (Object.prototype.hasOwnProperty.call(book, k)) rec[k] = book[k];
        }
        for (var p in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, p)) rec[p] = patch[p];
        }
        rec.updatedAt = nowMs();
        return App.DB.put('lorebooks', rec).then(function (saved) {
          state.book = saved && saved.id ? saved : rec;
          return state.book;
        });
      }

      function toggleBook(next) {
        if (state.busy) return Promise.resolve();
        state.busy = true;
        return saveBook({ enabled: !!next }).then(function () {
          state.busy = false;
          if (state.destroyed) return;
          renderAll();
          toast(next ? '已打开世界书' : '已关闭世界书，聊天不再注入', 'ok');
        }).catch(function (err) {
          state.busy = false;
          toast('保存失败：' + errText(err), 'error');
        });
      }

      function editBudget() {
        var cur = state.book && state.book.tokenBudget ? String(state.book.tokenBudget) : '400';
        UI.prompt({
          title: '世界书 token 预算',
          message: '每次注入世界书最多用多少 tokens（0 表示不限制）。条目按优先级累加，超预算就停。',
          value: cur,
          placeholder: '例如 400'
        }).then(function (v) {
          if (v === null || v === undefined || state.destroyed) return null;
          var n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
          if (!isFinite(n) || n < 0) {
            toast('请输入 0 或正整数');
            return null;
          }
          n = Math.min(n, 8000);
          state.busy = true;
          return saveBook({ tokenBudget: n }).then(function () {
            state.busy = false;
            renderAll();
            toast(n ? '预算已设为 ' + n + ' tokens' : '已设为不限制', 'ok');
          });
        }).catch(function (err) {
          state.busy = false;
          toast('保存失败：' + errText(err), 'error');
        });
      }

      function toggleEntry(entry, next) {
        if (state.busy) return;
        state.busy = true;
        var rec = {};
        for (var k in entry) {
          if (Object.prototype.hasOwnProperty.call(entry, k)) rec[k] = entry[k];
        }
        rec.enabled = !!next;
        rec.updatedAt = nowMs();
        App.DB.put('loreEntries', rec).then(function () {
          state.busy = false;
          entry.enabled = !!next;
          if (state.destroyed) return;
          renderAll();
        }).catch(function (err) {
          state.busy = false;
          toast('保存失败：' + errText(err), 'error');
          if (!state.destroyed) renderAll();
        });
      }

      /* ---------------- 启动 ---------------- */

      if (!state.characterId) {
        renderFatal('没有指定角色，无法打开世界书。请从角色编辑页进入。');
        return;
      }
      if (!lorebookApi()) {
        renderFatal('世界书模块未加载，请更新 App 后重试。');
        return;
      }
      load(true);
    }
  });
})();
