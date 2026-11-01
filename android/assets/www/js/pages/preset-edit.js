/* preset-edit.js —— 预设编辑页（二级页）
   参数：{id?} 编辑指定预设；{sessionId} 编辑会话绑定的生成参数；{characterType} 新建时的默认适用类型
   内置预设只读 → 「复制为新预设」后可编辑；保存写 presets 表；会话场景保存后立即绑定到会话 */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var U = App.Util;
  var D = App.DB;
  var K = App.ChatKit;

  var DEFAULT_PARAMS = {
    temperature: 0.8,
    top_p: 1,
    top_k: 0,
    max_tokens: 2000,
    presence_penalty: 0,
    frequency_penalty: 0,
    stop: []
  };

  function blankParams() {
    var p = {};
    Object.keys(DEFAULT_PARAMS).forEach(function (k) {
      p[k] = Array.isArray(DEFAULT_PARAMS[k]) ? DEFAULT_PARAMS[k].slice() : DEFAULT_PARAMS[k];
    });
    return p;
  }

  function blankPreset(typeHint) {
    return {
      name: '我的预设',
      mode: 'chat',
      appliesTo: typeHint === 'assistant' ? 'assistant' : (typeHint === 'companion' ? 'companion' : 'both'),
      instructTemplate: '',
      params: blankParams(),
      isBuiltin: false,
      createdAt: U.now(),
      updatedAt: U.now()
    };
  }

  function presetFromBase(base, name) {
    var rec = blankPreset(base && base.appliesTo);
    if (base) {
      rec.name = name || ((base.name || '预设') + ' · 副本');
      rec.mode = base.mode === 'text' ? 'text' : 'chat';
      rec.appliesTo = base.appliesTo || rec.appliesTo;
      rec.instructTemplate = base.instructTemplate || '';
      rec.params = Object.assign(blankParams(), base.params || {});
      if (!Array.isArray(rec.params.stop)) {
        rec.params.stop = rec.params.stop ? String(rec.params.stop).split(/[,，]/) : [];
      }
    }
    return rec;
  }

  function clampNumber(raw, label, min, max, fallback, integer) {
    var text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!text) return fallback;
    var n = Number(text);
    if (!isFinite(n)) throw new Error(label + ' 必须是数字');
    if (integer) n = Math.round(n);
    if (typeof min === 'number' && n < min) throw new Error(label + ' 不能小于 ' + min);
    if (typeof max === 'number' && n > max) throw new Error(label + ' 不能大于 ' + max);
    return n;
  }

  App.Router.register('presetEdit', {
    tab: false,
    title: '预设',
    build: function (root, params, page) {
      params = params || {};
      var st = {
        preset: null,
        readonly: false,
        sessionId: params.sessionId || '',
        session: null,
        characterType: params.characterType || '',
        loading: true,
        saving: false
      };
      var f = {}; // 控件引用

      var scroll = App.UI.el('div', { class: 'page-scroll' });
      var headEl = App.UI.el('div', { class: 'preset-head' });
      var bannerEl = App.UI.el('div', { class: 'preset-banner hidden' });
      var formEl = App.UI.el('div', { class: 'form preset-form' });
      var actionsEl = App.UI.el('div', { class: 'page-actions preset-actions' });
      var body = App.UI.el('div', { class: 'preset-body' }, headEl, bannerEl, formEl);
      scroll.appendChild(body);
      root.appendChild(scroll);
      root.appendChild(actionsEl);

      try { page.setTitle(params.sessionId ? '生成设置' : (params.id ? '编辑预设' : '新建预设')); } catch (e) { /* 忽略 */ }

      function toast(text, type) { K.toast(text, type); }

      /* ---------------- 顶部信息 ---------------- */
      function renderHead() {
        K.clear(headEl);
        var isBuiltin = !!(st.preset && st.preset.isBuiltin);
        var cards = [];
        var titleRow = App.UI.el('div', { class: 'preset-title-row' },
          App.UI.el('div', { class: 'preset-title', text: (st.preset && st.preset.name) || '预设' }),
          isBuiltin ? App.UI.el('span', { class: 'badge', text: '内置 · 只读' }) : null,
          st.sessionId ? App.UI.el('span', { class: 'badge green', text: '应用于当前会话' }) : null
        );
        cards.push(titleRow);
        cards.push(App.UI.el('div', {
          class: 'preset-desc',
          text: isBuiltin
            ? '内置预设不可直接修改；点「复制为新预设」会得到一份可编辑的副本。'
            : '这里的系统提示词与采样参数会用于之后发送的新消息（已生成的历史消息不受影响）。'
        }));
        if (st.sessionId) {
          cards.push(App.UI.el('div', {
            class: 'preset-desc',
            text: '保存后会立即绑定到当前会话，不需要重启应用。'
          }));
        }
        cards.forEach(function (n) { if (n) headEl.appendChild(n); });
      }

      /* ---------------- 表单控件 ---------------- */
      function makeSeg(options, current, onPick, key) {
        var wrap = App.UI.el('div', { class: 'segmented' });
        var btns = {};
        options.forEach(function (opt) {
          var btn = App.UI.el('button', {
            class: 'seg' + (current === opt.value ? ' active' : ''),
            attrs: { type: 'button' },
            text: opt.label
          });
          btn.addEventListener('click', function () {
            if (st.readonly) return;
            Object.keys(btns).forEach(function (k) { btns[k].classList.toggle('active', k === opt.value); });
            if (st.preset) st.preset[key] = opt.value;
            syncGuide();
          });
          btns[opt.value] = btn;
          wrap.appendChild(btn);
        });
        return wrap;
      }

      function makeInput(key, type, placeholder, step) {
        var attrs = { type: type || 'text' };
        if (placeholder) attrs.placeholder = placeholder;
        if (step) attrs.step = step;
        if (type === 'number') attrs.inputmode = 'decimal';
        var input = App.UI.el('input', { class: 'input', attrs: attrs });
        if (st.readonly) input.disabled = true;
        f[key] = input;
        return input;
      }

      function makeTextarea(key, rows) {
        var ta = App.UI.el('textarea', { class: 'textarea preset-template', attrs: { rows: String(rows || 6) } });
        if (st.readonly) ta.disabled = true;
        f[key] = ta;
        return ta;
      }

      function addField(labelText, control, hint) {
        var field = App.UI.el('div', { class: 'field' },
          App.UI.el('label', { text: labelText }),
          control,
          hint ? App.UI.el('div', { class: 'hint', text: hint }) : null
        );
        formEl.appendChild(field);
        return field;
      }

      function addParam(key, labelText, hint, step) {
        var input = makeInput(key, 'number', '', step);
        var box = App.UI.el('div', { class: 'preset-param' },
          App.UI.el('label', { text: labelText }),
          input,
          hint ? App.UI.el('div', { class: 'hint', text: hint }) : null
        );
        return box;
      }

      function applyValues() {
        var p = st.preset || {};
        var prm = Object.assign(blankParams(), p.params || {});
        if (f.name) f.name.value = p.name || '';
        if (f.instructTemplate) f.instructTemplate.value = p.instructTemplate || '';
        if (f.temperature) f.temperature.value = String(prm.temperature);
        if (f.top_p) f.top_p.value = String(prm.top_p);
        if (f.top_k) f.top_k.value = String(prm.top_k);
        if (f.max_tokens) f.max_tokens.value = String(prm.max_tokens);
        if (f.presence_penalty) f.presence_penalty.value = String(prm.presence_penalty);
        if (f.frequency_penalty) f.frequency_penalty.value = String(prm.frequency_penalty);
        if (f.stop) {
          f.stop.value = Array.isArray(prm.stop) ? prm.stop.join(', ') : (prm.stop ? String(prm.stop) : '');
        }
        if (f.mode && f.mode.setActive) f.mode.setActive(p.mode === 'text' ? 'text' : 'chat');
        if (f.appliesTo && f.appliesTo.setActive) f.appliesTo.setActive(p.appliesTo || 'both');
        if (st.readonly) {
          Object.keys(f).forEach(function (k) {
            var c = f[k];
            if (c && typeof c.disabled !== 'undefined') c.disabled = true;
          });
        }
      }

      function renderForm() {
        K.clear(formEl);
        f = {};
        var p = st.preset || blankPreset(st.characterType);

        addField('名称', makeInput('name', 'text', '例如：温柔陪聊'), '用于在预设列表和会话设置里识别。');

        var modeSeg = makeSeg([
          { value: 'chat', label: '聊天' },
          { value: 'text', label: '文本' }
        ], p.mode === 'text' ? 'text' : 'chat', function () { /* onPick 已在内部写回 */ }, 'mode');
        // 让 makeSeg 记录 setActive 能力：重新包一层
        modeSeg.setActive = function (v) {
          var nodes = modeSeg.querySelectorAll('.seg');
          for (var i = 0; i < nodes.length; i++) {
            var label = nodes[i].textContent;
            nodes[i].classList.toggle('active', (v === 'text' && label === '文本') || (v === 'chat' && label === '聊天'));
          }
        };
        if (st.readonly) modeSeg.classList.add('readonly');
        f.mode = modeSeg;
        addField('模式', modeSeg, '聊天：用于对话；文本：用于单次文本生成。');

        var appliesSeg = makeSeg([
          { value: 'companion', label: '陪聊角色' },
          { value: 'assistant', label: '助手角色' },
          { value: 'both', label: '通用' }
        ], p.appliesTo || 'both', function () { /* 同上 */ }, 'appliesTo');
        appliesSeg.setActive = function (v) {
          var nodes = appliesSeg.querySelectorAll('.seg');
          var map = { companion: '陪聊角色', assistant: '助手角色', both: '通用' };
          for (var i = 0; i < nodes.length; i++) {
            nodes[i].classList.toggle('active', nodes[i].textContent === map[v]);
          }
        };
        if (st.readonly) appliesSeg.classList.add('readonly');
        f.appliesTo = appliesSeg;
        addField('适用角色', appliesSeg, '陪聊角色和助手角色可以使用不同预设。');

        addField('预设系统提示词',
          makeTextarea('instructTemplate', 6),
          '会附加在角色 system prompt 之后一起发送；留空表示只使用角色自带的提示词。');

        var params = App.UI.el('div', { class: 'preset-params' });
        params.appendChild(App.UI.el('div', { class: 'preset-params-title', text: '采样参数' }));
        var grid = App.UI.el('div', { class: 'preset-grid' },
          addParam('temperature', '创意度 temperature', '0 ~ 2，越高越发散', '0.1'),
          addParam('top_p', 'top_p', '0 ~ 1，核采样', '0.05'),
          addParam('top_k', 'top_k', '0 表示不限制', '1'),
          addParam('max_tokens', 'max_tokens', '单次回复最大 token 数', '1'),
          addParam('presence_penalty', 'presence_penalty', '-2 ~ 2', '0.1'),
          addParam('frequency_penalty', 'frequency_penalty', '-2 ~ 2', '0.1')
        );
        params.appendChild(grid);
        formEl.appendChild(params);

        addField('停止词 stop', makeInput('stop', 'text', '用英文逗号分隔，例如：\n, ###'), '命中停止词即结束本次生成，留空表示不设置。');

        if (st.readonly) {
          formEl.classList.add('preset-readonly');
        } else {
          formEl.classList.remove('preset-readonly');
        }
        applyValues();
        // makeSeg 内部 onPick 已把值写回 st.preset，这里补一次初始值（避免空白状态写入 undefined）
        if (!st.preset.mode) st.preset.mode = 'chat';
        if (!st.preset.appliesTo) st.preset.appliesTo = 'both';
      }

      /* ---------------- 底部操作 ---------------- */
      function renderActions() {
        K.clear(actionsEl);
        function btn(text, cls, onClick) {
          var b = App.UI.el('button', { class: 'btn' + (cls ? ' ' + cls : ''), attrs: { type: 'button' }, text: text });
          b.addEventListener('click', function () { onClick(b); });
          return b;
        }
        if (st.loading) return;
        if (st.readonly) {
          actionsEl.appendChild(btn('复制为新预设', 'primary', function () { copyAsNew(); }));
          return;
        }
        actionsEl.appendChild(btn('保存', 'primary', function () { save(); }));
        if (st.preset && st.preset.id) {
          actionsEl.appendChild(btn('复制为新预设', '', function () { copyAsNew(); }));
        }
        if (st.preset && st.preset.id && !st.preset.isBuiltin) {
          actionsEl.appendChild(btn('删除', 'danger', function () { removePreset(); }));
        }
      }

      function renderAll() {
        renderHead();
        renderForm();
        renderActions();
        try { page.setTitle(st.sessionId ? '生成设置' : (st.preset && st.preset.id ? '编辑预设' : '新建预设')); } catch (e) { /* 忽略 */ }
        syncGuide();
      }

      function syncGuide() {
        try {
          var name = (f.name && String(f.name.value || '').trim()) || (st.preset && st.preset.name) || '';
          page.guide({
            pageId: 'presetEdit',
            title: '预设 · ' + (name || '未命名'),
            stage: 1,
            totalSteps: 1,
            filledFields: name ? { name: name } : {},
            missingFields: name ? [] : ['name'],
            error: null
          });
        } catch (e) { /* 忽略 */ }
      }

      /* ---------------- 保存 / 复制 / 删除 ---------------- */
      function collect() {
        var rec = {};
        var base = st.preset || {};
        Object.keys(base).forEach(function (k) { rec[k] = base[k]; });
        rec.name = String((f.name && f.name.value) || '').trim();
        if (!rec.name) throw new Error('请填写预设名称');
        rec.mode = base.mode === 'text' ? 'text' : 'chat';
        rec.appliesTo = base.appliesTo || 'both';
        rec.instructTemplate = String((f.instructTemplate && f.instructTemplate.value) || '');
        var stopRaw = String((f.stop && f.stop.value) || '');
        var stop = [];
        stopRaw.split(/[,，]/).forEach(function (s) {
          var t = s.trim();
          if (t) stop.push(t);
        });
        rec.params = {
          temperature: clampNumber(f.temperature && f.temperature.value, 'temperature', 0, 2, 0.8, false),
          top_p: clampNumber(f.top_p && f.top_p.value, 'top_p', 0, 1, 1, false),
          top_k: clampNumber(f.top_k && f.top_k.value, 'top_k', 0, 200, 0, true),
          max_tokens: clampNumber(f.max_tokens && f.max_tokens.value, 'max_tokens', 1, 32768, 2000, true),
          presence_penalty: clampNumber(f.presence_penalty && f.presence_penalty.value, 'presence_penalty', -2, 2, 0, false),
          frequency_penalty: clampNumber(f.frequency_penalty && f.frequency_penalty.value, 'frequency_penalty', -2, 2, 0, false),
          stop: stop
        };
        rec.isBuiltin = false;
        rec.createdAt = rec.createdAt || U.now();
        rec.updatedAt = U.now();
        return rec;
      }

      function bindToSession(presetId) {
        if (!st.sessionId) return Promise.resolve(null);
        return D.get('sessions', st.sessionId).then(function (s) {
          if (!s) return null;
          s.presetId = presetId;
          s.updatedAt = s.updatedAt || U.now();
          return D.put('sessions', s).then(function (saved) {
            st.session = saved;
            return saved;
          });
        });
      }

      function save() {
        if (st.saving) return;
        if (st.readonly) { copyAsNew(); return; }
        var data;
        try {
          data = collect();
        } catch (err) {
          toast((err && err.message) || '参数有误', 'error');
          return;
        }
        st.saving = true;
        D.put('presets', data).then(function (rec) {
          st.preset = rec;
          st.readonly = false;
          if (st.sessionId) return bindToSession(rec.id).then(function () { return rec; });
          return rec;
        }).then(function (rec) {
          st.saving = false;
          renderHead();
          renderActions();
          applyValues();
          toast(st.sessionId ? '已保存并应用到本会话' : '已保存', 'ok');
          try { page.setTitle(st.sessionId ? '生成设置' : '编辑预设'); } catch (e) { /* 忽略 */ }
          syncGuide();
          return rec;
        }).catch(function (err) {
          st.saving = false;
          console.error('[presetEdit] 保存失败', err);
          toast('保存失败：' + ((err && err.message) || '未知错误'), 'error');
        });
      }

      function copyAsNew() {
        if (st.saving) return;
        var base = st.preset || blankPreset(st.characterType);
        var rec = presetFromBase(base);
        rec.updatedAt = U.now();
        rec.createdAt = U.now();
        delete rec.id;
        rec.isBuiltin = false;
        st.saving = true;
        D.put('presets', rec).then(function (saved) {
          st.preset = saved;
          st.readonly = false;
          // 会话场景：复制出的预设直接绑定到当前会话，立即生效
          if (st.sessionId) return bindToSession(saved.id).then(function () { return saved; });
          return saved;
        }).then(function (saved) {
          st.saving = false;
          renderAll();
          toast(st.sessionId ? '已复制并应用到本会话' : '已复制为新预设，可以开始编辑', 'ok');
          return saved;
        }).catch(function (err) {
          st.saving = false;
          console.error('[presetEdit] 复制失败', err);
          toast('复制失败：' + ((err && err.message) || '未知错误'), 'error');
        });
      }

      function removePreset() {
        if (!st.preset || !st.preset.id) return;
        if (st.preset.isBuiltin) { toast('内置预设不可删除'); return; }
        var id = st.preset.id;
        K.confirm({
          title: '删除预设',
          message: '删除后不可恢复；使用该预设的会话会回退到默认预设。',
          okText: '删除',
          danger: true
        }).then(function (ok) {
          if (!ok) return;
          return D.all('sessions').then(function (sessions) {
            var affected = (sessions || []).filter(function (s) { return s && s.presetId === id; });
            return Promise.all(affected.map(function (s) {
              s.presetId = '';
              return D.put('sessions', s).catch(function () { return null; });
            })).then(function () { return null; });
          }).then(function () {
            return D.del('presets', id);
          }).then(function () {
            toast('已删除预设', 'ok');
            try { App.Router.pop(); } catch (e) { /* 忽略 */ }
          });
        }).catch(function (err) {
          console.error('[presetEdit] 删除失败', err);
          toast('删除失败：' + ((err && err.message) || '未知错误'), 'error');
        });
      }

      /* ---------------- 加载 ---------------- */
      function loadById(id) {
        return D.get('presets', id).then(function (p) {
          if (!p) throw new Error('预设不存在或已被删除');
          st.preset = p;
          st.readonly = !!p.isBuiltin;
          return null;
        });
      }

      function loadBySession(sessionId) {
        return D.get('sessions', sessionId).then(function (s) {
          if (!s) throw new Error('会话不存在或已被删除');
          st.session = s;
          st.sessionId = s.id;
          // 顺便取角色类型，决定新建预设时的默认适用角色
          if (!st.characterType && s.characterId) {
            return D.get('characters', s.characterId).then(function (c) {
              if (c && c.type) st.characterType = c.type;
              return s;
            }).catch(function () { return s; });
          }
          return s;
        }).then(function (s) {
          var pid = s && s.presetId;
          if (!pid) return null;
          return D.get('presets', pid).catch(function () { return null; });
        }).then(function (p) {
          if (p) {
            st.preset = p;
            st.readonly = !!p.isBuiltin;
            return null;
          }
          // 会话没有绑定预设（或绑定已失效）：以默认预设为蓝本新建一份，保存时绑回会话
          var fallback = (K.defaultPresetFor && K.defaultPresetFor(st.characterType)) || blankPreset(st.characterType);
          st.preset = presetFromBase(fallback, '会话生成设置');
          st.preset.appliesTo = fallback && fallback.appliesTo ? fallback.appliesTo : st.preset.appliesTo;
          st.readonly = false;
          return null;
        });
      }

      function initNew() {
        st.preset = blankPreset(st.characterType);
        st.readonly = false;
        return Promise.resolve(null);
      }

      function load() {
        var p;
        if (params.id) p = loadById(params.id);
        else if (params.sessionId) p = loadBySession(params.sessionId);
        else p = initNew();
        return p.then(function () {
          st.loading = false;
          renderAll();
          return null;
        }).catch(function (err) {
          console.error('[presetEdit] 加载失败', err);
          K.clear(root);
          root.appendChild(App.UI.errorState({
            title: '预设加载失败',
            desc: (err && err.message) || '未知错误',
            actionText: '返回',
            onAction: function () {
              try { App.Router.pop(); } catch (e) { /* 忽略 */ }
            }
          }));
          return null;
        });
      }

      return load();
    }
  });
})();
