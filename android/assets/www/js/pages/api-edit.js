/* ============================================================
 * api-edit.js —— 新增 / 编辑 API（二级页，参数 {id}；无 id 为新增）
 * 职责：名称 / Base URL / API Key / 默认模型 / 拉取模型列表 /
 *       测试连接 / 设为默认聊天 API / 保存。
 * 注意：API Key 只通过 App.API.setKey 写入本机安全存储，绝不写 DB。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App;

  App.Router.register('apiEdit', {
    tab: false,
    title: 'API 配置',

    async build(root, params, page) {
      var UI = App.UI;
      var Util = App.Util;
      var DB = App.DB;

      var isNew = !(params && params.id);
      var state = {
        id: (params && params.id) || Util.uid('prov'),
        isNew: isNew,
        existing: null,
        name: '',
        baseUrl: '',
        defaultModel: '',
        models: [],
        keyVisible: false,
        testing: false,
        tested: false,
        testOk: false,
        testError: null,
        lastStatus: 'unknown',
        lastError: null,
        lastCheckedAt: null,
        setDefault: false,
        saving: false
      };

      var destroyed = false;
      page.onDestroy(function () {
        destroyed = true;
      });

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
        return {
          code: error && error.code,
          title: '连接失败',
          hint: '请检查 Base URL、API Key 与网络后重试。'
        };
      }

      // Key 写入本机安全存储：优先 App.API.setKey，其次直接走原生 secure.set
      async function saveKey(providerId, key) {
        var value = String(key || '').trim();
        if (!value) return;
        if (App.API && typeof App.API.setKey === 'function') {
          await App.API.setKey(providerId, value);
          return;
        }
        await App.Bridge.call('secure.set', { key: 'key:' + providerId, value: value });
      }

      function openErrorHelp(error, pageName) {
        try {
          if (App.Help && typeof App.Help.open === 'function') {
            App.Help.open({
              source: 'error_hint',
              page: pageName || 'API 编辑',
              error: { code: (error && error.code) || 'unknown', message: (error && error.message) || '' }
            });
          } else {
            toast('引导助手尚未就绪');
          }
        } catch (e) {
          toast('无法打开帮助');
        }
      }

      // ---------- 读取数据 ----------
      root.textContent = '';
      try {
        page.setTitle(isNew ? '新增 API' : '编辑 API');
      } catch (e) {
        /* 忽略 */
      }

      if (!isNew) {
        try {
          state.existing = await DB.get('providers', state.id);
        } catch (e) {
          state.existing = null;
        }
        if (!state.existing) {
          renderFatal('这个 API 不存在或已被删除，请返回列表重试。');
          return;
        }
        state.name = state.existing.name || '';
        state.baseUrl = state.existing.baseUrl || '';
        state.defaultModel = state.existing.defaultModel || '';
        state.models = Array.isArray(state.existing.models) ? state.existing.models.slice() : [];
        state.lastStatus = state.existing.lastStatus || 'unknown';
        state.lastError = state.existing.lastError || null;
        state.lastCheckedAt = state.existing.lastCheckedAt || null;
      }

      try {
        var defaultId = await DB.settings.get('default_chat_provider_id', null);
        state.setDefault = !isNew && defaultId === state.id;
      } catch (e) {
        state.setDefault = false;
      }
      if (isNew) state.setDefault = false;

      // ---------- 骨架 ----------
      var wrap = el('div', { class: 'cfg-page cfg-edit-page' });
      root.appendChild(wrap);
      var form = el('div', { class: 'form cfg-form' });
      wrap.appendChild(form);

      function fieldWrap(label, control, hintText) {
        var hintEl = el('div', { class: 'hint', text: hintText || '' });
        var node = el(
          'label',
          { class: 'field cfg-field' },
          el('div', { class: 'cfg-field-label', text: label }),
          control,
          hintEl
        );
        return { el: node, hintEl: hintEl, hintText: hintText || '' };
      }

      function setFieldError(field, message) {
        if (!field) return;
        if (message) {
          field.el.classList.add('error');
          field.hintEl.textContent = message;
        } else {
          field.el.classList.remove('error');
          field.hintEl.textContent = field.hintText;
        }
      }

      function textInput(value, placeholder, type) {
        return el('input', {
          class: 'input',
          attrs: { type: type || 'text', placeholder: placeholder || '', autocomplete: 'off' },
          value: value || ''
        });
      }

      // 名称
      var nameInput = textInput(state.name, '例如 OpenAI / 我的中转 API');
      nameInput.setAttribute('data-guide-focus', 'name');
      var nameField = fieldWrap('名称', nameInput, '仅用于区分 API，可随意填写');
      nameInput.addEventListener('input', function () {
        state.name = nameInput.value;
        setFieldError(nameField, '');
        updateGuide();
      });
      form.appendChild(nameField.el);

      // Base URL
      var baseInput = textInput(state.baseUrl, 'https://api.openai.com/v1');
      baseInput.setAttribute('data-guide-focus', 'baseUrl');
      var baseField = fieldWrap('Base URL', baseInput, 'OpenAI 兼容端点，通常以 /v1 结尾（以服务商文档为准）');
      baseInput.addEventListener('input', function () {
        state.baseUrl = baseInput.value;
        setFieldError(baseField, '');
        updateGuide();
      });
      form.appendChild(baseField.el);

      // API Key
      var keyInput = textInput('', isNew ? '粘贴 API Key（sk-...）' : '已保存，留空不修改', 'password');
      keyInput.setAttribute('spellcheck', 'false');
      keyInput.setAttribute('data-guide-focus', 'apiKey');
      var keyToggle = el('button', { class: 'btn ghost small cfg-eye', attrs: { type: 'button' }, text: '显示' });
      keyToggle.addEventListener('click', function () {
        state.keyVisible = !state.keyVisible;
        keyInput.type = state.keyVisible ? 'text' : 'password';
        keyToggle.textContent = state.keyVisible ? '隐藏' : '显示';
      });
      var keyRow = el('div', { class: 'cfg-key-row' }, keyInput, keyToggle);
      var keyField = fieldWrap(
        'API Key',
        keyRow,
        isNew
          ? 'Key 只保存在本机系统加密存储，不写入数据库、不进入导出备份'
          : '已保存；留空则不修改，重新填写会覆盖旧 Key'
      );
      keyInput.addEventListener('input', function () {
        setFieldError(keyField, '');
        updateGuide();
      });
      form.appendChild(keyField.el);

      // 默认模型 + 拉取模型列表
      var modelInput = textInput(state.defaultModel, '例如 gpt-4o-mini');
      modelInput.setAttribute('data-guide-focus', 'model');
      var fetchBtn = el('button', { class: 'btn small cfg-fetch-btn', attrs: { type: 'button' }, text: '拉取模型列表' });
      var modelRow = el('div', { class: 'cfg-model-row' }, modelInput, fetchBtn);
      var modelSelectWrap = el('div', { class: 'cfg-model-select hidden' });
      var modelField = fieldWrap('默认模型', el('div', {}, modelRow, modelSelectWrap), '可以直接手填模型 id；拉取失败时也可以手填');
      modelInput.addEventListener('input', function () {
        state.defaultModel = modelInput.value;
        updateGuide();
      });
      form.appendChild(modelField.el);

      // 连接测试
      var testWrap = el('div', { class: 'cfg-test-wrap' });
      var testBtn = el('button', { class: 'btn block cfg-test-btn', attrs: { type: 'button' }, text: '测试连接' });
      testBtn.setAttribute('data-guide-tap', 'test');
      var resultBox = el('div', { class: 'cfg-result' });
      testWrap.appendChild(testBtn);
      testWrap.appendChild(resultBox);
      form.appendChild(testWrap);

      // 设为默认聊天 API 开关
      var switchNode = el('div', { class: 'cfg-switch' + (state.setDefault ? ' on' : '') });
      var defaultCell = el(
        'div',
        { class: 'cell cfg-switch-cell' },
        el(
          'div',
          { class: 'main' },
          el('div', { class: 'title', text: '设为默认聊天 API' }),
          el('div', { class: 'sub', text: '新会话默认使用这个 API；同一时间只有一个默认聊天 API' })
        ),
        switchNode
      );
      defaultCell.addEventListener('click', function () {
        state.setDefault = !state.setDefault;
        if (state.setDefault) switchNode.classList.add('on');
        else switchNode.classList.remove('on');
      });
      form.appendChild(el('div', { class: 'list cfg-switch-list' }, defaultCell));

      // 保存按钮
      var saveBtn = el('button', { class: 'btn primary block cfg-save-btn', attrs: { type: 'button' }, text: '保存' });
      saveBtn.setAttribute('data-guide-tap', 'save');
      saveBtn.addEventListener('click', function () {
        save();
      });
      form.appendChild(el('div', { class: 'cfg-actions' }, saveBtn));

      // 引导 API 提示（编辑引导 API 时）
      if (state.existing && state.existing.role === 'guide') {
        form.insertBefore(
          el('div', {
            class: 'cfg-notice',
            text: '这条是引导 API：帮助问答、世界观与角色补全默认使用它。'
          }),
          form.firstChild
        );
      }

      // 右上角保存
      try {
        page.setActions([{ icon: 'check', label: '保存', onClick: save }]);
      } catch (e) {
        /* 忽略 */
      }

      // ---------- 渲染辅助 ----------
      function renderModelOptions() {
        modelSelectWrap.textContent = '';
        if (!state.models || state.models.length === 0) {
          modelSelectWrap.classList.add('hidden');
          return;
        }
        modelSelectWrap.classList.remove('hidden');
        var select = el('select', { class: 'select cfg-model-native' });
        select.appendChild(el('option', { value: '', text: '从模型列表快速选择（共 ' + state.models.length + ' 个）' }));
        state.models.forEach(function (m) {
          select.appendChild(el('option', { value: m, text: m }));
        });
        // 下拉框只作为“快速选择”，选中后把值填进上面的默认模型输入框并复位，
        // 避免和输入框同时显示同一个模型造成误解。
        select.value = '';
        select.addEventListener('change', function () {
          if (!select.value) return;
          state.defaultModel = select.value;
          modelInput.value = select.value;
          select.value = '';
          setFieldError(modelField, '');
          updateGuide();
        });
        modelSelectWrap.appendChild(select);
      }

      function renderResult() {
        resultBox.textContent = '';
        if (!state.tested) return;
        if (state.testOk) {
          resultBox.appendChild(
            el(
              'div',
              { class: 'cfg-ok-box' },
              el(
                'div',
                { class: 'cfg-ok-title' },
                el('span', { class: 'cfg-ico', html: UI.icon('check') }),
                el('span', { text: '连接成功' })
              ),
              el('div', {
                class: 'cfg-ok-desc',
                text:
                  state.models && state.models.length > 0
                    ? '发现 ' + state.models.length + ' 个模型，可在上方下拉框选择。'
                    : '连接成功，但服务端未返回模型列表，请手动填写模型 id。'
              })
            )
          );
          return;
        }
        if (!state.testError) return;
        var info = getErrorInfo(state.testError);
        var box = el('div', { class: 'error-box cfg-error-box' });
        box.appendChild(
          el('div', {
            class: 'cfg-error-title',
            text: (info.title || '连接失败') + (info.code ? '（' + info.code + '）' : '')
          })
        );
        box.appendChild(el('div', { class: 'cfg-error-hint', text: info.hint || '请检查配置后重试。' }));
        if (state.testError.message) {
          box.appendChild(el('div', { class: 'cfg-error-raw', text: String(state.testError.message) }));
        }
        var helpBtn = el('button', {
          class: 'btn ghost small cfg-help-btn',
          attrs: { type: 'button' },
          text: '这是什么意思？'
        });
        helpBtn.addEventListener('click', function () {
          openErrorHelp(state.testError, 'API 编辑');
        });
        box.appendChild(helpBtn);
        resultBox.appendChild(box);
      }

      function updateBusy() {
        var busy = state.testing || state.saving;
        testBtn.disabled = busy;
        testBtn.textContent = state.testing ? '测试中…' : '测试连接';
        fetchBtn.disabled = busy;
        fetchBtn.textContent = state.testing ? '请求中…' : '拉取模型列表';
        saveBtn.disabled = busy;
        saveBtn.textContent = state.saving ? '保存中…' : '保存';
      }

      function missingFields() {
        var miss = [];
        if (!String(state.name || '').trim()) miss.push('name');
        if (!String(state.baseUrl || '').trim()) miss.push('baseUrl');
        if (state.isNew) miss.push('apiKey');
        if (!String(state.defaultModel || '').trim()) miss.push('defaultModel');
        return miss;
      }

      function updateGuide() {
        try {
          page.guide({
            pageId: 'apiEdit',
            title: (state.isNew ? '新增 API' : '编辑 API') + ' · ' + (String(state.name || '').trim() || '未命名'),
            stage: null,
            totalSteps: null,
            filledFields: {
              name: !!String(state.name || '').trim(),
              baseUrl: !!String(state.baseUrl || '').trim(),
              defaultModel: !!String(state.defaultModel || '').trim(),
              testPassed: !!state.testOk
            },
            missingFields: missingFields(),
            error: state.testError
              ? { code: state.testError.code || 'unknown', message: state.testError.message || '' }
              : null
          });
        } catch (e) {
          /* 忽略 */
        }
      }

      function renderFatal(message) {
        root.textContent = '';
        var box = el(
          'div',
          { class: 'error-box cfg-error-box cfg-fatal' },
          el('div', { class: 'cfg-error-title', text: '无法编辑这个 API' }),
          el('div', { class: 'cfg-error-hint', text: message }),
          el('button', {
            class: 'btn',
            attrs: { type: 'button' },
            text: '返回',
            on: {
              click: function () {
                App.Router.pop();
              }
            }
          })
        );
        root.appendChild(box);
      }

      // ---------- 测试连接 / 拉取模型 ----------
      async function runTest(purpose) {
        if (state.testing || state.saving) return;

        var url = String(state.baseUrl || '').trim();
        if (!url) {
          setFieldError(baseField, '请填写 Base URL');
          toast('请填写 Base URL');
          return;
        }
        if (!/^https?:\/\//i.test(url)) {
          setFieldError(baseField, 'Base URL 需以 http:// 或 https:// 开头');
          toast('Base URL 格式不正确');
          return;
        }
        var keyNow = String(keyInput.value || '').trim();
        if (!keyNow && state.isNew) {
          setFieldError(keyField, '新增 API 需要填写 API Key');
          toast('请先填写 API Key');
          if (keyInput.focus) keyInput.focus();
          return;
        }

        state.testing = true;
        state.tested = false;
        state.testOk = false;
        state.testError = null;
        updateBusy();
        renderResult();

        try {
          if (keyNow) await saveKey(state.id, keyNow);
          var provider = {
            id: state.id,
            name: String(state.name || '').trim() || '未命名 API',
            baseUrl: url,
            defaultModel: String(state.defaultModel || '').trim(),
            models: state.models.slice()
          };
          var res;
          if (App.API && typeof App.API.testProvider === 'function') {
            res = await App.API.testProvider(provider);
          } else {
            res = await App.Bridge.call('net.test', {
              baseUrl: url,
              apiKey: keyNow,
              timeoutMs: 20000
            });
          }
          state.tested = true;
          state.testOk = !!(res && res.ok);
          if (res && res.ok) {
            state.models = Array.isArray(res.models) ? res.models.filter(Boolean) : [];
            state.lastStatus = 'ok';
            state.lastError = null;
            state.lastCheckedAt = Util.now();
            if (!String(state.defaultModel || '').trim() && state.models.length > 0) {
              state.defaultModel = state.models[0];
              modelInput.value = state.defaultModel;
            }
            toast(purpose === 'models' ? '已获取模型列表' : '连接成功');
          } else {
            state.lastStatus = 'error';
            state.lastError = (res && res.error) || { code: 'unknown', message: '测试接口未返回结果' };
            state.lastCheckedAt = Util.now();
            toast('连接失败，请查看失败原因');
          }
          renderModelOptions();
          renderResult();
          updateGuide();

          // 已有记录：把最近连通状态写回 DB（列表页可直接看到）
          if (!state.isNew && state.existing) {
            state.existing.lastStatus = state.lastStatus;
            state.existing.lastError = state.lastError;
            state.existing.lastCheckedAt = state.lastCheckedAt;
            state.existing.updatedAt = Util.now();
            try {
              await DB.put('providers', state.existing);
            } catch (e) {
              /* 状态写回失败不影响编辑 */
            }
          }
        } catch (e) {
          state.tested = true;
          state.testOk = false;
          state.models = [];
          state.testError = { code: (e && e.code) || 'unknown', message: (e && e.message) || String(e) };
          renderResult();
          toast('测试失败：' + errText(e));
        } finally {
          state.testing = false;
          if (!destroyed) updateBusy();
        }
      }

      testBtn.addEventListener('click', function () {
        runTest('test');
      });
      fetchBtn.addEventListener('click', function () {
        runTest('models');
      });

      // ---------- 保存 ----------
      async function save() {
        if (state.saving || state.testing) return;

        var ok = true;
        var name = String(state.name || '').trim();
        if (!name) {
          setFieldError(nameField, '请填写名称');
          ok = false;
        } else {
          setFieldError(nameField, '');
        }
        var url = String(state.baseUrl || '').trim();
        if (!url) {
          setFieldError(baseField, '请填写 Base URL');
          ok = false;
        } else if (!/^https?:\/\//i.test(url)) {
          setFieldError(baseField, 'Base URL 需以 http:// 或 https:// 开头');
          ok = false;
        } else {
          setFieldError(baseField, '');
        }
        if (!ok) {
          toast('请检查必填项');
          return;
        }

        state.saving = true;
        updateBusy();
        try {
          var keyNow = String(keyInput.value || '').trim();
          if (keyNow) await saveKey(state.id, keyNow);

          var now = Util.now();
          var role = state.existing && state.existing.role === 'guide' ? 'guide' : 'chat';
          var record = {
            id: state.id,
            role: role,
            name: name,
            baseUrl: url,
            defaultModel: String(state.defaultModel || '').trim(),
            models: Array.isArray(state.models) ? state.models.slice() : [],
            lastStatus: state.lastStatus || 'unknown',
            lastError: state.lastError || null,
            lastCheckedAt: state.lastCheckedAt || null,
            createdAt: state.existing && state.existing.createdAt ? state.existing.createdAt : now,
            updatedAt: now
          };
          await DB.put('providers', record);

          // 默认聊天 API 开关
          var currentDefault = await DB.settings.get('default_chat_provider_id', null);
          if (state.setDefault) {
            if (currentDefault !== record.id) await DB.settings.set('default_chat_provider_id', record.id);
          } else if (currentDefault === record.id) {
            await DB.settings.set('default_chat_provider_id', null);
          }

          // 引导 API 的记录与 settings 保持一致
          if (record.role === 'guide') {
            var guideId = await DB.settings.get('guide_provider_id', null);
            if (guideId !== record.id) await DB.settings.set('guide_provider_id', record.id);
          }

          toast(state.isNew && !keyNow ? '已保存（未填写 Key，使用前需补充）' : '已保存');
          App.Router.pop();
        } catch (e) {
          state.saving = false;
          updateBusy();
          toast('保存失败：' + errText(e));
        }
      }

      // ---------- 启动 ----------
      renderModelOptions();
      updateGuide();
      updateBusy();
    }
  });
})();
