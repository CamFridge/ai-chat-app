/* ============================================================
 * pages/lorebook-edit.js —— 新建 / 编辑世界书条目（二级页）
 *
 * 参数：{ characterId, id? }　id 为空表示新建
 * 字段：名称、触发词（chips）、次要触发词、正文(≤800字)、
 *       优先级、常驻、区分大小写、启用、删除
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App;

  var MAX_CONTENT = 800;

  App.Router.register('lorebookEdit', {
    tab: false,
    title: '编辑条目',

    build: function (root, params, page) {
      var UI = App.UI;
      var U = App.Util;

      var state = {
        characterId: String((params && params.characterId) || ''),
        entryId: String((params && params.id) || ''),
        character: null,
        book: null,
        entry: null,
        loading: true,
        busy: false,
        destroyed: false
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
        return e.message ? String(e.message) : '未知错误';
      }

      function nowMs() {
        try { return U.now(); } catch (e) { return Date.now(); }
      }

      function api() {
        return App.Lorebook && typeof App.Lorebook.ensureForCharacter === 'function' ? App.Lorebook : null;
      }

      page.onDestroy(function () {
        state.destroyed = true;
      });

      root.textContent = '';
      try { page.setTitle(state.entryId ? '编辑条目' : '新建条目'); } catch (e) { /* 忽略 */ }

      var scroll = el('div', { class: 'lorebook-scroll' });
      root.appendChild(scroll);

      /* ---------------- 加载 ---------------- */

      function renderLoading() {
        scroll.textContent = '';
        var box = el('div', { class: 'lorebook-loading-inline' });
        if (UI.spinnerEl) {
          try { box.appendChild(UI.spinnerEl()); } catch (e) { /* 忽略 */ }
        }
        box.appendChild(el('span', { text: '正在读取条目…' }));
        scroll.appendChild(box);
      }

      function renderFatal(title, desc) {
        scroll.textContent = '';
        scroll.appendChild(UI.errorState({
          icon: 'warning',
          title: title || '打不开条目',
          desc: desc || '',
          actionText: '返回',
          onAction: function () { App.Router.pop(); }
        }));
        try { page.setActions([]); } catch (e) { /* 忽略 */ }
      }

      function load() {
        var L = api();
        if (!L) {
          renderFatal('世界书模块未就绪', '请更新 App 后重试。');
          return Promise.resolve();
        }
        if (!state.characterId) {
          renderFatal('缺少角色信息', '请从角色编辑页进入世界书。');
          return Promise.resolve();
        }
        renderLoading();
        return (App.DB && typeof App.DB.get === 'function'
          ? App.DB.get('characters', state.characterId).catch(function () { return null; })
          : Promise.resolve(null)
        ).then(function (ch) {
          state.character = ch || null;
          return L.ensureForCharacter(state.characterId);
        }).then(function (book) {
          state.book = book;
          if (!state.entryId) return null;
          return App.DB.get('loreEntries', state.entryId);
        }).then(function (entry) {
          if (state.destroyed) return;
          if (state.entryId && !entry) {
            renderFatal('条目不存在', '它可能已经被删除了。');
            return;
          }
          state.entry = entry || null;
          state.loading = false;
          renderForm();
        }).catch(function (err) {
          if (state.destroyed) return;
          renderFatal('加载失败', errText(err));
        });
      }

      /* ---------------- 表单小件 ---------------- */

      function fieldWrap(label, control, hint) {
        var wrap = el('div', { class: 'lorebook-field' },
          el('div', { class: 'lorebook-field-label', text: label }),
          control
        );
        var hintEl = null;
        if (hint) {
          hintEl = el('div', { class: 'lorebook-field-hint', text: hint });
          wrap.appendChild(hintEl);
        }
        return { el: wrap, hintEl: hintEl };
      }

      function textInputValue(value, placeholder, maxLen) {
        var attrs = { type: 'text', placeholder: placeholder || '' };
        if (maxLen) attrs.maxlength = String(maxLen);
        return el('input', { class: 'lorebook-input', attrs: attrs, value: value || '' });
      }

      function switchRow(label, desc, on) {
        var row = el('div', { class: 'lorebook-switch-row' },
          el('div', { class: 'lorebook-switch-text' },
            el('div', { class: 'lorebook-switch-title', text: label }),
            el('div', { class: 'lorebook-switch-desc', text: desc })
          )
        );
        var sw = el('div', {
          class: 'switch' + (on ? ' on' : ''),
          attrs: { role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label }
        });
        var checked = !!on;
        sw.addEventListener('click', function () {
          checked = !checked;
          sw.className = 'switch' + (checked ? ' on' : '');
          sw.setAttribute('aria-checked', checked ? 'true' : 'false');
        });
        row.appendChild(sw);
        return {
          el: row,
          get: function () { return checked; },
          set: function (v) {
            checked = !!v;
            sw.className = 'switch' + (checked ? ' on' : '');
            sw.setAttribute('aria-checked', checked ? 'true' : 'false');
          }
        };
      }

      // 关键词 chips 编辑器：回车 / 逗号 / 分号 / 顿号 添加，点 × 删除
      function chipsEditor(values, placeholder, emptyText) {
        var list = [];
        var i;
        var src = Array.isArray(values) ? values : [];
        for (i = 0; i < src.length; i++) {
          var v = String(src[i] || '').trim();
          if (v && list.indexOf(v) < 0) list.push(v);
        }

        var box = el('div', { class: 'lorebook-chips' });
        var input = el('input', {
          class: 'lorebook-input lorebook-chip-input',
          attrs: { type: 'text', placeholder: placeholder || '输入后按回车添加', enterkeyhint: 'done' }
        });
        var addBtn = el('button', { class: 'btn ghost small', attrs: { type: 'button' }, text: '添加' });
        var inputRow = el('div', { class: 'lorebook-input-row' });
        inputRow.appendChild(input);
        inputRow.appendChild(addBtn);

        function renderChips() {
          box.textContent = '';
          if (!list.length) {
            box.appendChild(el('div', { class: 'lorebook-chips-empty', text: emptyText || '还没有关键词' }));
            return;
          }
          for (var k = 0; k < list.length; k++) {
            (function (idx) {
              var chip = el('span', { class: 'lorebook-chip' },
                el('span', { class: 'lorebook-chip-text', text: list[idx] })
              );
              var x = el('button', {
                class: 'lorebook-chip-x',
                attrs: { type: 'button', 'aria-label': '移除 ' + list[idx] },
                html: UI.icon('close', 12)
              });
              x.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                list.splice(idx, 1);
                renderChips();
              });
              chip.appendChild(x);
              box.appendChild(chip);
            })(k);
          }
        }

        function pushTokens(raw) {
          var text = String(raw || '');
          var parts = text.split(/[,，、;；\n\r\t]+/);
          var changed = false;
          for (var k = 0; k < parts.length; k++) {
            var t = parts[k].trim();
            if (!t) continue;
            if (t.length > 40) t = t.slice(0, 40);
            if (list.indexOf(t) < 0) {
              list.push(t);
              changed = true;
            }
          }
          if (text && !changed && text.trim()) {
            toast('这个关键词已经有了');
          }
          renderChips();
        }

        function commitInput() {
          var v = input.value;
          if (!v || !v.trim()) { input.value = ''; return; }
          pushTokens(v);
          input.value = '';
        }

        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ',' || ev.key === '，' || ev.key === '、' || ev.key === ';') {
            ev.preventDefault();
            commitInput();
          } else if (ev.key === 'Backspace' && !input.value && list.length) {
            list.pop();
            renderChips();
          }
        });
        input.addEventListener('blur', function () { commitInput(); });
        addBtn.addEventListener('click', function (ev) {
          ev.preventDefault();
          commitInput();
          input.focus();
        });

        renderChips();

        var wrap = el('div', { class: 'lorebook-chips-wrap' }, box, inputRow);

        return {
          el: wrap,
          get: function () {
            commitInput();
            return list.slice();
          },
          set: function (arr) {
            list = [];
            var src2 = Array.isArray(arr) ? arr : [];
            for (var k = 0; k < src2.length; k++) {
              var t = String(src2[k] || '').trim();
              if (t && list.indexOf(t) < 0) list.push(t);
            }
            renderChips();
          }
        };
      }

      /* ---------------- 表单 ---------------- */

      function renderForm() {
        var entry = state.entry;
        var isEdit = !!(entry && entry.id);
        var book = state.book;
        var chName = state.character && (state.character.name || state.character.nickname) ? String(state.character.name || state.character.nickname) : '';

        scroll.textContent = '';

        if (chName) {
          scroll.appendChild(el('div', { class: 'lorebook-head' },
            el('div', { class: 'lorebook-head-title', text: chName + ' · 世界书' }),
            el('div', { class: 'lorebook-head-sub', text: isEdit ? '修改这条设定' : '新增一条设定' })
          ));
        }

        // 名称
        var form = el('div', { class: 'lorebook-form' });
        var nameInput = textInputValue(entry ? entry.name : '', '例如：艾琳的身世（可留空）', 60);
        var nameField = fieldWrap('名称', nameInput, '只用于在这张列表里标识，不会进入对话。');
        form.appendChild(nameField.el);

        // 触发词
        var keysEd = chipsEditor(entry ? entry.keys : [], '例如：艾琳、队长', '还没有触发词');
        var keysField = fieldWrap('触发词', keysEd.el, '对话里出现任意一个词时，这段设定就会被加进上下文（逗号分隔）。');
        form.appendChild(keysField.el);

        // 次要触发词
        var secEd = chipsEditor(entry ? entry.secondaryKeys : [], '例如：旧城、北境', '没有次要触发词');
        var secField = fieldWrap('次要触发词', secEd.el, '填了次要触发词时，必须与触发词同时命中才注入；留空则不限制。');
        form.appendChild(secField.el);

        // 正文
        var contentArea = el('textarea', {
          class: 'lorebook-textarea',
          attrs: { placeholder: '写这段设定：外貌、身世、口癖、关系、禁忌……', maxlength: String(MAX_CONTENT), rows: '6' }
        });
        contentArea.value = entry ? String(entry.content || '') : '';
        var countEl = el('div', { class: 'lorebook-count', text: '' });
        function updateCount() {
          var n = contentArea.value.length;
          countEl.textContent = n + ' / ' + MAX_CONTENT + ' 字';
          countEl.className = 'lorebook-count' + (n >= MAX_CONTENT ? ' error' : (n >= MAX_CONTENT * 0.9 ? ' warn' : ''));
        }
        contentArea.addEventListener('input', updateCount);
        updateCount();
        var contentField = fieldWrap('正文', contentArea, '');
        contentField.el.appendChild(countEl);
        form.appendChild(contentField.el);

        // 优先级
        var prioInput = el('input', {
          class: 'lorebook-input lorebook-prio-input',
          attrs: { type: 'number', min: '0', max: '9999', step: '1', inputmode: 'numeric', placeholder: '100' }
        });
        prioInput.value = String(entry && entry.priority !== undefined && entry.priority !== null ? entry.priority : 100);
        var prioField = fieldWrap('优先级', prioInput, '数字越大越优先注入；预算不够时低优先级的条目会被截掉。默认 100。');
        form.appendChild(prioField.el);
        scroll.appendChild(form);

        // 开关组
        scroll.appendChild(el('div', { class: 'lorebook-section-title', text: '注入规则' }));
        var switches = el('div', { class: 'lorebook-block' });
        var alwaysOnCtl = switchRow('常驻条目', '不论有没有触发词，每条消息都会注入（占预算，慎用）。', entry ? entry.alwaysOn : false);
        var caseCtl = switchRow('区分大小写', '英文触发词要大小写完全一致才算命中。', entry ? entry.caseSensitive : false);
        var enabledCtl = switchRow('启用这条条目', '关掉后保留内容但不再注入。', entry ? entry.enabled !== false : true);
        switches.appendChild(alwaysOnCtl.el);
        switches.appendChild(caseCtl.el);
        switches.appendChild(enabledCtl.el);
        scroll.appendChild(switches);

        // 提示
        scroll.appendChild(el('div', {
          class: 'lorebook-note',
          text: '提示：一段正文越短越省预算。同一段设定不要拆成太多条，容易同时命中、白占预算。'
        }));

        // 删除
        if (isEdit) {
          var delBtn = el('button', { class: 'btn danger block', attrs: { type: 'button' }, text: '删除这条条目' });
          delBtn.addEventListener('click', function () { removeEntry(); });
          scroll.appendChild(el('div', { class: 'lorebook-danger' }, delBtn));
        }

        // 底部保存
        var saveBtn = el('button', { class: 'btn primary', attrs: { type: 'button' }, text: '保存' });
        saveBtn.addEventListener('click', function () { submit(saveBtn); });
        UI.clear(root.querySelector('.page-actions'));
        var bar = root.querySelector('.page-actions');
        if (!bar) {
          bar = el('div', { class: 'page-actions' });
          root.appendChild(bar);
        }
        bar.appendChild(saveBtn);

        try {
          page.setActions([{ icon: 'check', label: '保存', onClick: function () { submit(saveBtn); } }]);
        } catch (e) { /* 忽略 */ }

        function collect() {
          var keys = keysEd.get();
          var sec = secEd.get();
          var alwaysOn = alwaysOnCtl.get();
          var content = String(contentArea.value || '').replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
          if (!content) throw new Error('正文不能为空');
          if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT);
          if (!keys.length && !alwaysOn) throw new Error('请至少填一个触发词，或打开「常驻条目」');
          var prioRaw = String(prioInput.value || '').replace(/[^\d-]/g, '');
          var prio = parseInt(prioRaw, 10);
          if (!isFinite(prio)) prio = 100;
          if (prio < 0) prio = 0;
          if (prio > 9999) prio = 9999;
          prioInput.value = String(prio);

          var rec = {};
          if (entry) {
            for (var k in entry) {
              if (Object.prototype.hasOwnProperty.call(entry, k)) rec[k] = entry[k];
            }
          }
          rec.lorebookId = book && book.id ? book.id : (entry && entry.lorebookId) || '';
          rec.name = String(nameInput.value || '').trim().slice(0, 60);
          rec.keys = keys;
          rec.secondaryKeys = sec;
          rec.content = content;
          rec.priority = prio;
          rec.alwaysOn = alwaysOn;
          rec.caseSensitive = caseCtl.get();
          rec.enabled = enabledCtl.get();
          rec.updatedAt = nowMs();
          if (!rec.createdAt) rec.createdAt = nowMs();
          if (!rec.lorebookId) throw new Error('世界书还没准备好，请返回重进');
          return rec;
        }

        function submit() {
          if (state.busy) return;
          var rec;
          try {
            rec = collect();
          } catch (err) {
            toast(errText(err));
            return;
          }
          state.busy = true;
          if (saveBtn) { saveBtn.className = 'btn primary loading'; saveBtn.setAttribute('disabled', 'disabled'); }
          var L = api();
          var task = L && typeof L.saveEntry === 'function'
            ? L.saveEntry(rec, rec.lorebookId)
            : (App.DB && typeof App.DB.put === 'function' ? App.DB.put('loreEntries', rec) : Promise.reject(new Error('保存接口缺失')));
          task.then(function () {
            state.busy = false;
            if (state.destroyed) return;
            toast(isEdit ? '已保存修改' : '已新建条目', 'ok');
            try { App.Router.pop(); } catch (e) { /* 忽略 */ }
          }).catch(function (err) {
            state.busy = false;
            if (saveBtn) { saveBtn.className = 'btn primary'; saveBtn.removeAttribute('disabled'); }
            toast('保存失败：' + errText(err), 'error');
          });
        }

        function removeEntry() {
          if (state.busy || !isEdit) return;
          UI.confirm({
            title: '删除这条条目？',
            message: '「' + (String(entry.name || '').trim() || (entry.keys && entry.keys[0]) || '未命名条目') + '」删除后无法恢复。',
            okText: '删除',
            danger: true
          }).then(function (ok) {
            if (!ok || state.destroyed) return null;
            state.busy = true;
            var L = api();
            var task = L && typeof L.deleteEntry === 'function'
              ? L.deleteEntry(entry.id)
              : App.DB.del('loreEntries', entry.id);
            return task.then(function () {
              state.busy = false;
              toast('已删除', 'ok');
              try { App.Router.pop(); } catch (e) { /* 忽略 */ }
            }).catch(function (err) {
              state.busy = false;
              toast('删除失败：' + errText(err), 'error');
            });
          }).catch(function (err) {
            state.busy = false;
            toast('删除失败：' + errText(err), 'error');
          });
        }
      }

      load();
    }
  });
})();
