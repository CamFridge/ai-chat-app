/* ============================================================
 * pages/lorebook-gen.js —— 根据角色卡 AI 生成世界书条目（二级页）
 *
 * 参数：{ characterId, worldviewId? }
 * 流程：读角色卡 → 拼 worldText → App.Lorebook.generateEntries({preview:true})
 *       → 条目卡片（勾选 / 全选 / 直接改正文）→ 保存选中的 N 条 → 返回列表页
 * 说明：生成请求本身不可中断，所以做真实计时 + 明确的失败态 + 可重试。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App;

  var MAX_CONTENT = 800;

  App.Router.register('lorebookGen', {
    tab: false,
    title: 'AI 生成条目',

    build: function (root, params, page) {
      var UI = App.UI;
      var U = App.Util;

      var state = {
        characterId: String((params && params.characterId) || ''),
        worldviewId: String((params && params.worldviewId) || ''),
        character: null,
        spec: null,
        book: null,
        provider: null,
        model: '',
        phase: 'loading', // loading | generating | preview | error | saving
        entries: [],      // [{ entry, checked }]
        error: null,
        startedAt: 0,
        timer: null,
        onSelChange: null,
        destroyed: false
      };

      var HINTS = [
        '正在把角色卡拆成可触发的设定条目…',
        '正在挑选容易在对话里出现的触发词…',
        '等待模型返回结果（通常 5~20 秒）…',
        '接口有点慢，还在等…',
        '还在等模型把最后一句话说完…'
      ];

      var timerEl = null;
      var descEl = null;

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
        return e.message ? String(e.message) : '未知错误';
      }

      function api() {
        return App.Lorebook && typeof App.Lorebook.generateEntries === 'function' ? App.Lorebook : null;
      }

      function nowMs() {
        try { return U.now(); } catch (e) { return Date.now(); }
      }

      function characterName() {
        var c = state.character || {};
        return String(c.name || c.nickname || '').trim();
      }

      page.onDestroy(function () {
        state.destroyed = true;
        stopTimer();
      });

      root.textContent = '';
      try { page.setTitle('AI 生成条目'); } catch (e) { /* 忽略 */ }

      var scroll = el('div', { class: 'lorebook-scroll' });
      root.appendChild(scroll);

      /* ---------------- 计时器（真实耗时） ---------------- */

      function stopTimer() {
        if (state.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
      }

      function timerText() {
        var s = Math.max(0, Date.now() - state.startedAt) / 1000;
        return '已用 ' + (s < 10 ? s.toFixed(1) : Math.round(s)) + ' 秒';
      }

      function startTimer() {
        stopTimer();
        state.startedAt = Date.now();
        var ticks = 0;
        if (timerEl) timerEl.textContent = timerText();
        state.timer = setInterval(function () {
          if (state.destroyed) { stopTimer(); return; }
          ticks++;
          if (timerEl) {
            try { timerEl.textContent = timerText(); } catch (e) { /* 忽略 */ }
          }
          if (descEl && ticks % 15 === 0) {
            var idx = Math.min(Math.floor(ticks / 15), HINTS.length - 1);
            try { descEl.textContent = HINTS[idx]; } catch (e2) { /* 忽略 */ }
          }
        }, 200);
      }

      /* ---------------- 启动：读卡 → 找世界观 → 建书 → 选接口 → 生成 ---------------- */

      loadAndGenerate();

      function loadAndGenerate() {
        var L = api();
        if (!L) {
          state.phase = 'error';
          state.error = new Error('世界书模块未就绪，请更新 App 后重试');
          renderError();
          return Promise.resolve();
        }
        if (!state.characterId) {
          state.phase = 'error';
          state.error = new Error('缺少角色信息，请从角色编辑页进入');
          renderError();
          return Promise.resolve();
        }
        state.phase = 'loading';
        state.error = null;
        renderGenerating('正在读取角色卡…');

        return (App.DB && typeof App.DB.get === 'function'
          ? App.DB.get('characters', state.characterId).catch(function () { return null; })
          : Promise.resolve(null)
        ).then(function (ch) {
          state.character = ch || null;
          if (!state.character) throw new Error('找不到这个角色，可能已经被删除了');
          return loadSpec();
        }).then(function (spec) {
          state.spec = spec;
          return L.ensureForCharacter(state.characterId);
        }).then(function (book) {
          state.book = book;
          return loadProvider();
        }).then(function () {
          if (state.destroyed) return null;
          return generate();
        }).catch(function (err) {
          if (state.destroyed) return;
          stopTimer();
          state.phase = 'error';
          state.error = err;
          renderError();
        });
      }

      // 世界观记录（可选，补充给模型的设定）
      function loadSpec() {
        var kit = App.CharKit;
        if (!state.worldviewId || !kit || typeof kit.loadWorldviews !== 'function') return Promise.resolve(null);
        return Promise.resolve().then(function () {
          return kit.loadWorldviews();
        }).then(function (res) {
          var all = (res && res.all) || [];
          for (var i = 0; i < all.length; i++) {
            if (all[i] && String(all[i].id) === state.worldviewId) return all[i];
          }
          return null;
        }).catch(function () { return null; });
      }

      function loadProvider() {
        var kit = App.CharKit;
        var listPromise;
        if (kit && typeof kit.loadProviders === 'function') {
          listPromise = Promise.resolve().then(function () { return kit.loadProviders(); });
        } else if (App.DB && typeof App.DB.all === 'function') {
          listPromise = App.DB.all('providers');
        } else {
          listPromise = Promise.resolve([]);
        }
        return Promise.resolve(listPromise).then(function (list) {
          var arr = Array.isArray(list) ? list : [];
          var pick = null;
          if (kit && typeof kit.findGuide === 'function') {
            try { pick = kit.findGuide(arr); } catch (e) { pick = null; }
          }
          if (!pick && arr.length) pick = arr[0];
          state.provider = pick || null;
          state.model = pick ? String(pick.defaultModel || pick.model || '') : '';
          if (!pick) {
            var err = new Error('还没有可用的 AI 接口');
            err.code = 'noprovider';
            throw err;
          }
          if (App.API && typeof App.API.checkProviderReady === 'function') {
            var ready = null;
            try { ready = App.API.checkProviderReady(pick); } catch (e2) { ready = null; }
            if (ready && ready.ok === false) {
              var err2 = new Error(ready.reason || '这个 AI 接口还没配置好');
              err2.code = 'noprovider';
              throw err2;
            }
          }
          return pick;
        });
      }

      function worldText() {
        var L = api();
        if (L && typeof L.buildWorldText === 'function') {
          try {
            var t = L.buildWorldText(state.character, state.spec);
            if (t) return t;
          } catch (e) { /* 走兜底 */ }
        }
        return '';
      }

      function genOpts() {
        var opts = {
          lorebookId: state.book && state.book.id ? state.book.id : '',
          worldText: worldText(),
          preview: true
        };
        if (state.provider) opts.provider = state.provider;
        if (state.model) opts.model = state.model;
        return opts;
      }

      function applyResult(res) {
        var list = res && Array.isArray(res.entries) ? res.entries : [];
        if (!list.length) {
          var err = new Error('AI 没有生成可用的条目');
          err.code = 'empty';
          throw err;
        }
        state.entries = [];
        for (var i = 0; i < list.length; i++) {
          if (list[i]) state.entries.push({ entry: list[i], checked: true });
        }
        state.phase = 'preview';
        stopTimer();
        renderPreview();
      }

      function generate() {
        var L = api();
        state.phase = 'generating';
        renderGenerating('正在把角色卡拆成设定条目…');
        startTimer();
        var opts;
        try {
          opts = genOpts();
          if (!opts.worldText) {
            var err = new Error('这个角色还没有足够的设定（性格 / 背景 / 场景），先去补充一下再来生成');
            err.code = 'nocontent';
            throw err;
          }
        } catch (e) {
          stopTimer();
          state.phase = 'error';
          state.error = e;
          renderError();
          return Promise.resolve();
        }
        return Promise.resolve().then(function () {
          return L.generateEntries(opts);
        }).then(function (res) {
          if (state.destroyed) return;
          applyResult(res);
        }).catch(function (err) {
          if (state.destroyed) return;
          stopTimer();
          state.phase = 'error';
          state.error = err;
          renderError();
        });
      }

      function retry() {
        if (state.destroyed || state.phase === 'saving') return;
        if (!state.book) { loadAndGenerate(); return; }
        if (!state.provider) {
          loadProvider().then(function () { return generate(); }).catch(function (err) {
            if (state.destroyed) return;
            state.phase = 'error';
            state.error = err;
            renderError();
          });
          return;
        }
        generate();
      }

      /* ---------------- 生成中 ---------------- */

      function renderGenerating(desc) {
        scroll.textContent = '';
        timerEl = el('div', { class: 'lorebook-gen-timer', text: '' });
        descEl = el('div', { class: 'lorebook-gen-status-desc', text: desc || HINTS[0] });

        var spin = el('div', { class: 'lorebook-gen-spinner' });
        if (UI.spinnerEl) {
          try { spin.appendChild(UI.spinnerEl()); } catch (e) { /* 忽略 */ }
        }
        scroll.appendChild(el('div', { class: 'lorebook-gen-status' },
          spin,
          el('div', { class: 'lorebook-gen-status-main' },
            el('div', { class: 'lorebook-gen-status-title', text: '正在生成世界书条目' }),
            descEl
          ),
          timerEl
        ));

        if (state.provider) {
          var pname = String(state.provider.name || state.provider.label || 'AI 接口');
          var model = state.model ? (' · ' + state.model) : '';
          scroll.appendChild(el('div', { class: 'lorebook-note', text: '使用 ' + pname + model + ' 生成。' }));
        }

        var chName = characterName();
        if (chName) {
          scroll.appendChild(el('div', { class: 'lorebook-note', text: '正在读「' + chName + '」的角色卡。' }));
        }

        scroll.appendChild(el('div', {
          class: 'lorebook-note warn',
          text: '生成过程中不能中途取消；如果失败会给出错误原因，可以直接重试。'
        }));

        var back = el('button', { class: 'btn ghost block', attrs: { type: 'button' }, text: '先返回（请求会在后台自然结束）' });
        back.addEventListener('click', function () {
          try { App.Router.pop(); } catch (e) { /* 忽略 */ }
        });
        scroll.appendChild(el('div', { class: 'lorebook-pad' }, back));

        try { page.setActions([]); } catch (e) { /* 忽略 */ }
        renderLayoutActions([]);
      }

      /* ---------------- 错误态 ---------------- */

      function errorInfo(err) {
        var info = { title: '生成失败', hint: errText(err) };
        var code = err && err.code ? String(err.code) : '';
        if (App.API && typeof App.API.errorInfo === 'function') {
          try {
            var ei = App.API.errorInfo(err);
            if (ei && ei.title) info.title = ei.title;
            if (ei && ei.hint) info.hint = ei.hint;
          } catch (e) { /* 忽略 */ }
        }
        if (code === 'noprovider') {
          info.title = '还没有可用的 AI 接口';
          info.hint = '请先到「设置 → API 管理」里添加并启用一个接口，再回来生成。';
        } else if (code === 'badjson') {
          info.title = 'AI 返回的格式不对';
          info.hint = '已自动重试过一次仍然失败。可以再点「重试」，或到设置里换一个模型。';
        } else if (code === 'empty') {
          info.title = 'AI 没生成出可用条目';
          info.hint = '可以重试；如果一直是空的，试着把角色卡写得更具体一点。';
        } else if (code === 'nocontent') {
          info.title = '角色卡内容太少';
          info.hint = '先去角色编辑页补充「性格 / 背景 / 场景」，再回来生成。';
        }
        var first = err && err.firstError ? String(err.firstError) : '';
        if (first && first !== info.hint) info.hint += '（第一次尝试：' + first + '）';
        return info;
      }

      function renderError() {
        stopTimer();
        var info = errorInfo(state.error);
        scroll.textContent = '';
        scroll.appendChild(el('div', { class: 'lorebook-gen-error' }, UI.errorState({
          icon: 'warning',
          title: info.title,
          desc: info.hint,
          actionText: '重试',
          onAction: function () { retry(); }
        })));

        var chName = characterName();
        if (chName) {
          scroll.appendChild(el('div', { class: 'lorebook-note', text: '角色：' + chName }));
        }
        scroll.appendChild(el('div', {
          class: 'lorebook-note',
          text: '如果反复失败，可以去「设置 → API 管理」检查 Key、Base URL 和模型名。'
        }));

        renderLayoutActions([
          { text: '返回', cls: 'btn ghost', onClick: function () { try { App.Router.pop(); } catch (e) { /* 忽略 */ } } },
          { text: '重试', cls: 'btn primary', onClick: function () { retry(); } }
        ]);
        try {
          page.setActions([{ icon: 'refresh', label: '重试', onClick: function () { retry(); } }]);
        } catch (e) { /* 忽略 */ }
      }

      /* ---------------- 预览：勾选 / 全选 / 改正文 ---------------- */

      function selectedCount() {
        var n = 0;
        for (var i = 0; i < state.entries.length; i++) {
          if (state.entries[i].checked) n++;
        }
        return n;
      }

      function renderPreview() {
        scroll.textContent = '';
        var total = state.entries.length;

        var headCount = el('div', { class: 'lorebook-gen-head-count', text: '' });
        var selBtn = el('button', { class: 'btn ghost small', attrs: { type: 'button' }, text: '全选' });
        selBtn.addEventListener('click', function () { selectAll(selectedCount() !== total); });

        scroll.appendChild(el('div', { class: 'lorebook-gen-head' },
          el('div', null,
            el('div', { class: 'lorebook-gen-head-title', text: '生成好了，共 ' + total + ' 条' }),
            headCount
          ),
          selBtn
        ));

        var chName = characterName();
        scroll.appendChild(el('div', {
          class: 'lorebook-note',
          text: (chName ? '来自「' + chName + '」的角色卡。' : '') +
            '勾选要保留的条目，正文可以直接在卡片里修改；保存后回到世界书列表。'
        }));

        var listBox = el('div', { class: 'lorebook-gen-list' });
        for (var i = 0; i < state.entries.length; i++) {
          listBox.appendChild(genCard(state.entries[i]));
        }
        scroll.appendChild(listBox);

        scroll.appendChild(el('div', {
          class: 'lorebook-note',
          text: '小提示：触发词别用「他 / 她 / 这个」这类常用词，否则几乎每条消息都会命中，白白占用预算。'
        }));

        state.onSelChange = function () {
          var n = selectedCount();
          headCount.textContent = '已选 ' + n + ' / ' + total;
          selBtn.textContent = n === total ? '取消全选' : '全选';
          var bar = root.querySelector('.page-actions');
          if (!bar) return;
          var btns = bar.querySelectorAll('.btn');
          for (var b = 0; b < btns.length; b++) {
            if ((' ' + btns[b].className + ' ').indexOf(' primary ') >= 0) {
              btns[b].textContent = '保存选中的 ' + n + ' 条';
            }
          }
        };

        renderLayoutActions([
          { text: '重新生成', cls: 'btn ghost', onClick: function () { regenerate(); } },
          { text: '保存选中的 ' + selectedCount() + ' 条', cls: 'btn primary', onClick: function () { saveSelected(); } }
        ]);

        try {
          page.setActions([{ icon: 'refresh', label: '重新生成', onClick: function () { regenerate(); } }]);
        } catch (e) { /* 忽略 */ }

        updateSelectionUi();
      }

      function updateSelectionUi() {
        if (state.onSelChange) {
          try { state.onSelChange(); } catch (e) { /* 忽略 */ }
        }
      }

      function genCard(item) {
        var entry = item.entry;
        var displayName = String(entry.name || (entry.keys && entry.keys[0]) || '未命名条目');
        var card = el('div', { class: 'lorebook-gen-card' + (item.checked ? ' selected' : '') });

        var check = el('div', {
          class: 'lorebook-gen-check' + (item.checked ? ' on' : ''),
          attrs: { role: 'checkbox', 'aria-checked': item.checked ? 'true' : 'false', 'aria-label': '选择这条' },
          html: UI.icon('check', 14)
        });
        var meta = el('div', { class: 'lorebook-gen-meta' },
          el('span', { class: 'badge', text: '优先级 ' + String(entry.priority === 0 ? 0 : (entry.priority || 100)) })
        );
        if (entry.alwaysOn) meta.appendChild(el('span', { class: 'badge orange', text: '常驻' }));

        var head = el('div', { class: 'lorebook-gen-card-head' },
          check,
          el('div', { class: 'lorebook-gen-title-wrap' },
            el('div', { class: 'lorebook-gen-title', text: displayName }),
            meta
          )
        );
        head.addEventListener('click', function () {
          if (state.phase !== 'preview') return;
          item.checked = !item.checked;
          check.className = 'lorebook-gen-check' + (item.checked ? ' on' : '');
          check.setAttribute('aria-checked', item.checked ? 'true' : 'false');
          card.className = 'lorebook-gen-card' + (item.checked ? ' selected' : '');
          updateSelectionUi();
        });
        card.appendChild(head);

        var keysRow = el('div', { class: 'lorebook-gen-keys' });
        var keys = Array.isArray(entry.keys) ? entry.keys : [];
        for (var k = 0; k < keys.length; k++) {
          keysRow.appendChild(el('span', { class: 'lorebook-key', text: String(keys[k]) }));
        }
        var sec = Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys : [];
        for (var s = 0; s < sec.length; s++) {
          keysRow.appendChild(el('span', { class: 'lorebook-key secondary', text: String(sec[s]) }));
        }
        card.appendChild(keysRow);

        var area = el('textarea', {
          class: 'lorebook-gen-textarea',
          attrs: { maxlength: String(MAX_CONTENT), placeholder: '条目正文（可以直接改）' }
        });
        area.value = String(entry.content || '');
        var count = el('div', { class: 'lorebook-gen-card-count', text: '' });

        function updateCount() {
          var n = area.value.length;
          count.textContent = n + ' / ' + MAX_CONTENT + ' 字';
          count.className = 'lorebook-gen-card-count' + (n >= MAX_CONTENT ? ' lorebook-count error' : '');
        }
        area.addEventListener('input', function () {
          var v = String(area.value || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
          entry.content = v.slice(0, MAX_CONTENT);
          updateCount();
        });
        updateCount();
        card.appendChild(el('div', { class: 'lorebook-gen-body' }, area));

        var dropBtn = el('button', { class: 'btn ghost small', attrs: { type: 'button' }, text: '不要这条' });
        dropBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (state.phase !== 'preview') return;
          item.checked = false;
          check.className = 'lorebook-gen-check';
          check.setAttribute('aria-checked', 'false');
          card.className = 'lorebook-gen-card';
          updateSelectionUi();
        });

        card.appendChild(el('div', { class: 'lorebook-gen-card-foot' }, count, dropBtn));
        return card;
      }

      function selectAll(on) {
        for (var i = 0; i < state.entries.length; i++) {
          state.entries[i].checked = !!on;
        }
        renderPreview();
      }

      function regenerate() {
        if (state.phase === 'saving') return;
        state.entries = [];
        generate();
      }

      /* ---------------- 保存 ---------------- */

      function saveSelected() {
        if (state.phase !== 'preview') return;
        var L = api();
        var picked = [];
        var skipped = 0;
        for (var i = 0; i < state.entries.length; i++) {
          if (!state.entries[i].checked) continue;
          var entry = state.entries[i].entry;
          var content = String(entry.content || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
          if (!content) { skipped++; continue; }
          var rec = {};
          for (var k in entry) {
            if (Object.prototype.hasOwnProperty.call(entry, k)) rec[k] = entry[k];
          }
          rec.content = content.slice(0, MAX_CONTENT);
          rec.lorebookId = state.book && state.book.id ? state.book.id : rec.lorebookId;
          if (!rec.name) rec.name = (rec.keys && rec.keys[0]) || '未命名条目';
          picked.push(rec);
        }
        if (!picked.length) {
          toast(skipped ? '选中的条目正文都是空的，先补一点内容吧' : '先勾选要保存的条目');
          return;
        }
        if (skipped) toast('已跳过 ' + skipped + ' 条正文为空的条目');

        state.phase = 'saving';
        var bar = root.querySelector('.page-actions');
        var saveBtn = null;
        if (bar) {
          var btns = bar.querySelectorAll('.btn');
          for (var b = 0; b < btns.length; b++) {
            if ((' ' + btns[b].className + ' ').indexOf(' primary ') >= 0) saveBtn = btns[b];
            btns[b].setAttribute('disabled', 'disabled');
          }
          if (saveBtn) {
            saveBtn.className = 'btn primary loading';
            saveBtn.textContent = '保存中…';
          }
        }

        var task = L && typeof L.saveEntries === 'function'
          ? L.saveEntries(picked, state.book.id)
          : Promise.reject(new Error('保存接口缺失'));
        task.then(function () {
          if (state.destroyed) return;
          toast('已保存 ' + picked.length + ' 条条目', 'ok');
          try { App.Router.pop(); } catch (e) { /* 忽略 */ }
        }).catch(function (err) {
          state.phase = 'preview';
          if (state.destroyed) return;
          toast('保存失败：' + errText(err), 'error');
          renderPreview();
        });
      }

      /* ---------------- 底部固定动作 ---------------- */

      function renderLayoutActions(actions) {
        var bar = root.querySelector('.page-actions');
        if (!bar) {
          bar = el('div', { class: 'page-actions' });
          root.appendChild(bar);
        }
        UI.clear(bar);
        if (!actions || !actions.length) {
          if (bar.parentNode) bar.parentNode.removeChild(bar);
          return;
        }
        for (var i = 0; i < actions.length; i++) {
          (function (a) {
            var btn = el('button', { class: a.cls || 'btn', attrs: { type: 'button' }, text: a.text });
            btn.addEventListener('click', function () { if (a.onClick) a.onClick(); });
            bar.appendChild(btn);
          })(actions[i]);
        }
      }

      /* ---------------- 启动 ---------------- */
      // 注意：真正的入口调用在 build 开头（loadAndGenerate()，函数声明提升所以能调用）
    }
  });
})();
