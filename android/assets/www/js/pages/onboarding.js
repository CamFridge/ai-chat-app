/* ============================================================
 * onboarding.js —— 首次引导向导（强制，不可跳过）
 * 步骤：welcome → provider → key → test → model → done（共 6 步）
 * 关键约束：
 *   1. 只有「测试连接」成功后才允许完成；
 *   2. onboarding_completed 只在最后保存成功时置 true（main.js 据此判断是否进主界面）；
 *   3. API Key 只走 App.API.setKey（内部 Bridge.secure），绝不写 DB。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App;

  // 6 步定义（顺序即状态机顺序）
  var STEPS = [
    { key: 'welcome', name: '欢迎', title: '欢迎使用' },
    { key: 'provider', name: '选择供应商', title: '选择供应商' },
    { key: 'key', name: '填写 API Key', title: '填写 API Key' },
    { key: 'test', name: '测试连接', title: '测试连接' },
    { key: 'model', name: '选择模型', title: '选择模型' },
    { key: 'done', name: '完成', title: '完成配置' }
  ];

  // 供应商快捷预设：点选后自动填 Base URL 与推荐模型
  var PRESETS = [
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      desc: '官方 OpenAI 接口，模型最全，通常需要海外网络环境。'
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      desc: '国内可直连，价格便宜，适合日常聊天与内容补全。'
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-4o-mini',
      desc: '聚合多家供应商模型，一个 Key 可以使用多种模型。'
    },
    {
      id: 'siliconflow',
      name: '硅基流动',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      desc: '国内模型聚合平台，提供 Qwen、GLM 等开源模型。'
    },
    {
      id: 'custom',
      name: '自定义',
      baseUrl: '',
      model: '',
      desc: '任意 OpenAI 兼容端点，Base URL 与模型全部手动填写。'
    }
  ];

  App.Router.register('onboarding', {
    tab: false,
    title: '开始配置',

    async build(root, params, page) {
      var UI = App.UI;
      var Util = App.Util;
      var DB = App.DB;

      // ------- 向导状态（整个向导期间常驻内存，回退不丢） -------
      var state = {
        step: 0,
        id: Util.uid('prov'), // 提前生成 provider id：测试连接前先把 Key 写进安全存储
        preset: '',
        name: '',
        baseUrl: '',
        model: '',
        models: [],
        apiKey: '',
        keyVisible: false,
        testing: false,
        tested: false,
        testOk: false,
        testError: null,
        saving: false,
        alsoDefault: true
      };

      var destroyed = false;
      page.onDestroy(function () {
        destroyed = true;
      });

      // ------- 骨架 -------
      root.textContent = '';
      var wrap = App.UI.el('div', { class: 'ob-wrap' });
      var head = App.UI.el('div', { class: 'ob-head' });
      var progress = App.UI.el('div', { class: 'ob-progress' });
      var stepLabel = App.UI.el('div', { class: 'ob-step-label' });
      head.appendChild(progress);
      head.appendChild(stepLabel);
      var body = App.UI.el('div', { class: 'ob-body' });
      var footer = App.UI.el('div', { class: 'ob-footer' });
      wrap.appendChild(head);
      wrap.appendChild(body);
      wrap.appendChild(footer);
      root.appendChild(wrap);

      // 右上角「?」：每步都可问引导助手
      page.setActions([
        {
          icon: 'help',
          label: '帮助',
          onClick: function () {
            openHelp();
          }
        }
      ]);

      // ------- 小工具 -------
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

      // Key 写入安全存储：优先 App.API.setKey，其次直接走原生 secure.set
      async function saveKey(providerId, key) {
        var value = String(key || '').trim();
        if (!value) return;
        if (App.API && typeof App.API.setKey === 'function') {
          await App.API.setKey(providerId, value);
          return;
        }
        await App.Bridge.call('secure.set', { key: 'key:' + providerId, value: value });
      }

      function openHelp() {
        try {
          if (App.Help && typeof App.Help.open === 'function') {
            App.Help.open({ source: 'guide_wizard', page: STEPS[state.step].name });
          } else {
            toast('引导助手尚未就绪，请稍后再试');
          }
        } catch (e) {
          toast('无法打开帮助：' + errText(e));
        }
      }

      function openErrorHelp() {
        var err = state.testError || { code: 'unknown', message: '' };
        try {
          if (App.Help && typeof App.Help.open === 'function') {
            App.Help.open({
              source: 'guide_wizard',
              page: '测试连接',
              error: { code: err.code || 'unknown', message: err.message || '' }
            });
          } else {
            toast('引导助手尚未就绪，请稍后再试');
          }
        } catch (e) {
          toast('无法打开帮助：' + errText(e));
        }
      }

      // 悬浮气泡上下文：只放字段名与是否已填，不放 Key 明文
      function missingFields() {
        var miss = [];
        if (!String(state.baseUrl || '').trim()) miss.push('baseUrl');
        if (!String(state.apiKey || '').trim()) miss.push('apiKey');
        if (!state.testOk) miss.push('testPassed');
        if (!String(state.model || '').trim()) miss.push('model');
        return miss;
      }

      function updateGuide() {
        try {
          page.guide({
            pageId: 'onboarding',
            title: '首次配置 · 第' + (state.step + 1) + '步 ' + STEPS[state.step].name,
            stage: state.step + 1,
            totalSteps: STEPS.length,
            filledFields: {
              baseUrl: !!String(state.baseUrl || '').trim(),
              apiKey: !!String(state.apiKey || '').trim(),
              model: !!String(state.model || '').trim(),
              testPassed: !!state.testOk
            },
            missingFields: missingFields(),
            error: state.testError
              ? { code: state.testError.code || 'unknown', message: state.testError.message || '' }
              : null
          });
        } catch (e) {
          /* 气泡模块未就绪时忽略 */
        }
      }

      // ------- 渲染骨架 -------
      function renderProgress() {
        progress.textContent = '';
        for (var i = 0; i < STEPS.length; i++) {
          var seg = el('div', {
            class: 'ob-seg' + (i <= state.step ? ' on' : ''),
            attrs: { title: STEPS[i].name }
          });
          progress.appendChild(seg);
        }
        stepLabel.textContent =
          '第 ' + (state.step + 1) + ' 步 / 共 ' + STEPS.length + ' 步 · ' + STEPS[state.step].name;
      }

      function clearFooter() {
        footer.textContent = '';
      }

      function prevBtn() {
        return el('button', {
          class: 'btn ghost ob-btn',
          attrs: { type: 'button' },
          text: '上一步',
          on: {
            click: function () {
              if (state.step > 0) gotoStep(state.step - 1);
            }
          }
        });
      }

      function nextBtn(text, onClick) {
        return el('button', {
          class: 'btn primary ob-btn',
          attrs: { type: 'button' },
          text: text || '下一步',
          on: { click: onClick }
        });
      }

      function render() {
        if (destroyed) return;
        renderProgress();
        body.textContent = '';
        clearFooter();
        switch (state.step) {
          case 0:
            renderWelcome();
            break;
          case 1:
            renderProvider();
            break;
          case 2:
            renderKey();
            break;
          case 3:
            renderTest();
            break;
          case 4:
            renderModel();
            break;
          case 5:
            renderDone();
            break;
          default:
            renderWelcome();
        }
        updateGuide();
        root.scrollTop = 0;
      }

      function gotoStep(n) {
        if (n < 0 || n >= STEPS.length) return;
        // 未通过测试不允许进入 model/done
        if (n >= 4 && !state.testOk) {
          toast('请先通过连接测试');
          return;
        }
        state.step = n;
        render();
      }

      // ------- Step 0：欢迎 -------
      function infoLine(icon, title, desc) {
        return el(
          'div',
          { class: 'ob-info' },
          el('div', { class: 'ob-info-icon', html: UI.icon(icon) }),
          el(
            'div',
            { class: 'ob-info-main' },
            el('div', { class: 'ob-info-title', text: title }),
            el('div', { class: 'ob-info-desc', text: desc })
          )
        );
      }

      function renderWelcome() {
        body.appendChild(
          el('div', { class: 'ob-hero' }, el('div', { class: 'ob-hero-icon', html: UI.icon('spark') }))
        );
        body.appendChild(el('h1', { class: 'ob-h1', text: '欢迎使用 AI 聊天' }));
        body.appendChild(
          el('p', {
            class: 'ob-p',
            text:
              '这是一款只通过远程 API 调用大模型的聊天 App —— 没有本地模型、不需要下载模型文件，也不会在手机上做任何推理。'
          })
        );
        body.appendChild(
          el(
            'div',
            { class: 'ob-list' },
            infoLine('globe', '纯远程 API', '所有回复都来自你配置的 OpenAI 兼容服务'),
            infoLine('key', '需要一个 API Key', '在服务商控制台创建，只保存在本机系统加密存储'),
            infoLine('lock', '不会上传', 'Key 不写入数据库、不进入导出备份、不发送给任何第三方')
          )
        );
        body.appendChild(
          el('p', {
            class: 'ob-p muted small',
            text: '接下来大约 1 分钟，完成 6 步配置即可开始使用。中途返回上一步不会丢失已填内容。'
          })
        );
        footer.appendChild(
          nextBtn('开始配置', function () {
            gotoStep(1);
          })
        );
      }

      // ------- Step 1：选择供应商 -------
      function choosePreset(preset) {
        state.preset = preset.id;
        if (preset.id === 'custom') {
          // 自定义：不覆盖用户已有输入
          state.model = preset.model || state.model;
        } else {
          state.baseUrl = preset.baseUrl;
          state.name = preset.name;
          state.model = preset.model;
        }
        render();
      }

      function textField(label, value, placeholder, hint, onInput) {
        var input = el('input', {
          class: 'input',
          attrs: { type: 'text', placeholder: placeholder || '', autocomplete: 'off' },
          value: value || ''
        });
        input.addEventListener('input', function () {
          onInput(input.value);
        });
        return {
          el: el(
            'label',
            { class: 'ob-field' },
            el('div', { class: 'ob-field-label', text: label }),
            input,
            hint ? el('div', { class: 'ob-field-hint', text: hint }) : null
          ),
          input: input
        };
      }

      function renderProvider() {
        body.appendChild(el('h2', { class: 'ob-h2', text: '选择供应商' }));
        body.appendChild(
          el('p', {
            class: 'ob-p',
            text: '选择常见供应商会自动填好 Base URL 与推荐模型；也可以选择「自定义」全部手动填写。'
          })
        );

        var grid = el('div', { class: 'ob-presets' });
        PRESETS.forEach(function (preset) {
          grid.appendChild(
            el(
              'div',
              {
                class: 'ob-preset' + (state.preset === preset.id ? ' active' : ''),
                on: {
                  click: function () {
                    choosePreset(preset);
                  }
                }
              },
              el('div', { class: 'ob-preset-name', text: preset.name }),
              el('div', { class: 'ob-preset-desc', text: preset.desc }),
              preset.baseUrl
                ? el('div', { class: 'ob-preset-url ellipsis', text: preset.baseUrl })
                : el('div', { class: 'ob-preset-url muted', text: '手动填写' })
            )
          );
        });
        body.appendChild(grid);

        var nameField = textField(
          '名称',
          state.name,
          '例如 OpenAI / 我的 API',
          '仅用于在 API 管理里区分，可随意填写',
          function (v) {
            state.name = v;
          }
        );
        var baseField = textField(
          'Base URL',
          state.baseUrl,
          'https://api.openai.com/v1',
          '需要是 OpenAI 兼容端点，通常以 /v1 结尾（以服务商文档为准）',
          function (v) {
            state.baseUrl = v;
          }
        );
        body.appendChild(nameField.el);
        body.appendChild(baseField.el);
        nameField.input.setAttribute('data-guide-focus', 'name');
        baseField.input.setAttribute('data-guide-focus', 'baseUrl');

        if (state.model) {
          body.appendChild(
            el('div', { class: 'ob-tip', text: '推荐模型：' + state.model + '（下一步测试通过后可以在模型列表里改）' })
          );
        }
        body.appendChild(
          el('p', {
            class: 'ob-p muted small',
            text: '不确定填什么？点右上角「?」问引导助手，或到所用服务商的文档里找「Base URL / API 地址」。'
          })
        );

        footer.appendChild(prevBtn());
        footer.appendChild(
          nextBtn('下一步', function () {
            var url = String(state.baseUrl || '').trim();
            if (!url) {
              toast('请填写 Base URL');
              if (baseField.input.focus) baseField.input.focus();
              return;
            }
            if (!/^https?:\/\//i.test(url)) {
              toast('Base URL 需以 http:// 或 https:// 开头');
              return;
            }
            state.baseUrl = url;
            if (!String(state.name || '').trim()) {
              var matched = null;
              for (var i = 0; i < PRESETS.length; i++) {
                if (PRESETS[i].id === state.preset) matched = PRESETS[i];
              }
              state.name = matched && matched.id !== 'custom' ? matched.name : '我的 API';
            }
            gotoStep(2);
          })
        );
      }

      // ------- Step 2：API Key -------
      function renderKey() {
        body.appendChild(el('h2', { class: 'ob-h2', text: '填写 API Key' }));
        body.appendChild(
          el('p', {
            class: 'ob-p',
            text: '在供应商控制台创建 API Key 后粘贴到这里。Key 只保存在本机，不会上传到任何服务器。'
          })
        );

        var input = el('input', {
          class: 'input',
          attrs: { type: 'password', placeholder: 'sk-...', autocomplete: 'off', spellcheck: 'false' },
          value: state.apiKey
        });
        input.addEventListener('input', function () {
          state.apiKey = input.value;
        });
        input.setAttribute('data-guide-focus', 'apiKey');
        var toggle = el('button', {
          class: 'btn ghost small ob-eye',
          attrs: { type: 'button' },
          text: '显示'
        });
        toggle.addEventListener('click', function () {
          state.keyVisible = !state.keyVisible;
          input.type = state.keyVisible ? 'text' : 'password';
          toggle.textContent = state.keyVisible ? '隐藏' : '显示';
        });

        body.appendChild(el('div', { class: 'ob-key-row' }, input, toggle));
        body.appendChild(
          el(
            'div',
            { class: 'ob-hint-box' },
            el('div', { class: 'ob-hint-icon', html: UI.icon('lock') }),
            el('div', {
              class: 'ob-hint-text',
              text: 'Key 只保存在本机系统加密存储中：不写入数据库、不会上传、也不会出现在导出备份里。'
            })
          )
        );

        footer.appendChild(prevBtn());
        footer.appendChild(
          nextBtn('下一步', function () {
            var key = String(state.apiKey || '').trim();
            if (!key) {
              toast('请填写 API Key');
              if (input.focus) input.focus();
              return;
            }
            state.apiKey = key;
            gotoStep(3);
          })
        );
      }

      // ------- Step 3：测试连接 -------
      function summaryRow(label, value, cls) {
        return el(
          'div',
          { class: 'ob-sum-row' },
          el('div', { class: 'ob-sum-label', text: label }),
          el('div', { class: 'ob-sum-value ' + (cls || ''), text: value == null ? '—' : String(value) })
        );
      }

      function renderTest() {
        body.appendChild(el('h2', { class: 'ob-h2', text: '测试连接' }));
        body.appendChild(
          el('p', {
            class: 'ob-p',
            text: '先确认这个 API 能正常访问。测试通过后才能继续选择模型并完成配置。'
          })
        );
        var summary = el('div', { class: 'ob-summary' });
        summary.appendChild(summaryRow('Base URL', state.baseUrl));
        summary.appendChild(summaryRow('模型', state.model || '（测试后选择）'));
        body.appendChild(summary);

        var attrs = { type: 'button' };
        if (state.testing) attrs.disabled = 'disabled';
        var testBtn = el('button', {
          class: 'btn primary block ob-test-btn',
          attrs: attrs,
          text: state.testing ? '测试中…' : '测试连接',
          on: { click: runTest }
        });
        testBtn.setAttribute('data-guide-tap', 'test');
        body.appendChild(testBtn);

        var resultBox = el('div', { class: 'ob-result' });
        body.appendChild(resultBox);
        renderTestResult(resultBox);

        footer.appendChild(prevBtn());
        if (state.testOk) {
          footer.appendChild(
            nextBtn('下一步', function () {
              gotoStep(4);
            })
          );
        } else {
          footer.appendChild(
            el('div', {
              class: 'ob-footer-note',
              text: '连接测试未通过时无法继续，请修正后重试。'
            })
          );
        }
      }

      function renderTestResult(box) {
        box.textContent = '';
        if (!state.tested) return;

        if (state.testOk) {
          box.appendChild(
            el(
              'div',
              { class: 'ob-ok' },
              el(
                'div',
                { class: 'ob-ok-title' },
                el('span', { class: 'ob-ico', html: UI.icon('check') }),
                el('span', { text: '连接成功' })
              ),
              el('div', {
                class: 'ob-ok-desc',
                text:
                  state.models.length > 0
                    ? '发现 ' + state.models.length + ' 个可用模型，下一步可以从中选择。'
                    : '连接成功，但服务端没有返回模型列表，下一步请手动填写模型 id。'
              })
            )
          );
          if (state.models.length > 0) {
            var preview = el('div', { class: 'ob-model-preview' });
            state.models.slice(0, 6).forEach(function (m) {
              preview.appendChild(el('div', { class: 'ob-chip', text: m }));
            });
            if (state.models.length > 6) {
              preview.appendChild(el('div', { class: 'ob-chip muted', text: '… 共 ' + state.models.length + ' 个' }));
            }
            box.appendChild(preview);
          }
          return;
        }

        var error = state.testError;
        if (!error) return;
        var info = getErrorInfo(error);
        var errBox = el('div', { class: 'ob-error' });
        errBox.appendChild(
          el('div', {
            class: 'ob-error-title',
            text: (info.title || '连接失败') + (info.code ? '（' + info.code + '）' : '')
          })
        );
        errBox.appendChild(
          el('div', { class: 'ob-error-hint', text: info.hint || '请检查配置后重试。' })
        );
        if (error.message) {
          errBox.appendChild(el('div', { class: 'ob-error-raw', text: String(error.message) }));
        }
        errBox.appendChild(
          el('button', {
            class: 'btn ghost small ob-help-btn',
            attrs: { type: 'button' },
            text: '这是什么意思？',
            on: { click: openErrorHelp }
          })
        );
        box.appendChild(errBox);
        box.appendChild(
          el('button', {
            class: 'btn block',
            attrs: { type: 'button' },
            text: '重新测试',
            on: { click: runTest }
          })
        );
      }

      async function runTest() {
        if (state.testing) return;
        if (!String(state.baseUrl || '').trim()) {
          toast('请先填写 Base URL');
          gotoStep(1);
          return;
        }
        if (!String(state.apiKey || '').trim()) {
          toast('请先填写 API Key');
          gotoStep(2);
          return;
        }

        state.testing = true;
        state.tested = false;
        state.testOk = false;
        state.testError = null;
        state.models = [];
        render();

        try {
          // 先把 Key 写入本机安全存储，测试接口内部按 provider.id 读取
          await saveKey(state.id, state.apiKey);
          var provider = {
            id: state.id,
            name: String(state.name || '').trim() || '引导 API',
            baseUrl: String(state.baseUrl || '').trim(),
            defaultModel: String(state.model || '').trim(),
            models: []
          };
          var res;
          if (App.API && typeof App.API.testProvider === 'function') {
            res = await App.API.testProvider(provider);
          } else {
            res = await App.Bridge.call('net.test', {
              baseUrl: provider.baseUrl,
              apiKey: String(state.apiKey || ''),
              timeoutMs: 20000
            });
          }
          state.testing = false;
          state.tested = true;
          if (res && res.ok) {
            state.testOk = true;
            state.testError = null;
            state.models = Array.isArray(res.models) ? res.models.filter(Boolean) : [];
            if (state.models.length > 0) {
              // 默认选第一个；若推荐模型在列表中则保留推荐
              if (!state.model || state.models.indexOf(state.model) === -1) {
                state.model = state.models[0];
              }
            }
            toast('连接成功');
          } else {
            state.testOk = false;
            state.models = [];
            state.testError = (res && res.error) || { code: 'unknown', message: '测试接口未返回结果' };
            toast('连接失败，请查看失败原因');
          }
        } catch (e) {
          state.testing = false;
          state.tested = true;
          state.testOk = false;
          state.models = [];
          state.testError = {
            code: (e && e.code) || 'unknown',
            message: (e && e.message) || String(e)
          };
          toast('测试失败');
        }
        if (!destroyed) render();
      }

      // ------- Step 4：选择模型 -------
      function renderModel() {
        body.appendChild(el('h2', { class: 'ob-h2', text: '选择模型' }));
        body.appendChild(
          el('p', {
            class: 'ob-p',
            text: '默认使用列表中的第一个模型，也可以手动填写模型 id。之后可以随时在「API 管理」里修改。'
          })
        );

        if (state.models.length > 0) {
          var list = el('div', { class: 'ob-model-list' });
          state.models.forEach(function (m) {
            var active = state.model === m;
            list.appendChild(
              el(
                'div',
                {
                  class: 'ob-model-item' + (active ? ' active' : ''),
                  on: {
                    click: function () {
                      state.model = m;
                      render();
                    }
                  }
                },
                el('div', { class: 'ob-model-name ellipsis', text: m }),
                el('div', { class: 'ob-radio' + (active ? ' on' : '') })
              )
            );
          });
          body.appendChild(list);
        } else {
          body.appendChild(
            el(
              'div',
              { class: 'ob-hint-box' },
              el('div', { class: 'ob-hint-icon', html: UI.icon('info') }),
              el('div', {
                class: 'ob-hint-text',
                text: '没有从服务端获取到模型列表，请手动填写模型 id（例如 gpt-4o-mini、deepseek-chat）。'
              })
            )
          );
        }

        var input = el('input', {
          class: 'input',
          attrs: { type: 'text', placeholder: '手动填写模型 id', autocomplete: 'off' },
          value: state.model
        });
        input.addEventListener('input', function () {
          state.model = input.value;
        });
        input.setAttribute('data-guide-focus', 'model');
        body.appendChild(
          el(
            'label',
            { class: 'ob-field' },
            el('div', { class: 'ob-field-label', text: '模型 id' }),
            input,
            el('div', { class: 'ob-field-hint', text: '列表里没有想要的模型时，直接填模型 id 即可。' })
          )
        );

        footer.appendChild(prevBtn());
        footer.appendChild(
          nextBtn('下一步', function () {
            var model = String(state.model || '').trim();
            if (!model) {
              toast('请选择或填写模型');
              return;
            }
            state.model = model;
            gotoStep(5);
          })
        );
      }

      // ------- Step 5：完成 -------
      function maskKey(key) {
        var k = String(key || '');
        if (!k) return '未填写';
        if (k.length <= 8) return '••••' + k.slice(-2);
        return k.slice(0, 3) + '••••' + k.slice(-4);
      }

      function renderDone() {
        body.appendChild(el('h2', { class: 'ob-h2', text: '完成配置' }));
        body.appendChild(el('p', { class: 'ob-p', text: '确认下面的配置无误后，就可以开始使用了。' }));

        var card = el('div', { class: 'ob-summary' });
        card.appendChild(summaryRow('名称', String(state.name || '').trim() || '引导 API'));
        card.appendChild(summaryRow('Base URL', state.baseUrl));
        card.appendChild(summaryRow('默认模型', state.model));
        card.appendChild(summaryRow('API Key', maskKey(state.apiKey)));
        card.appendChild(summaryRow('连接测试', state.testOk ? '已通过' : '未通过', state.testOk ? 'ok' : 'err'));
        body.appendChild(card);

        var check = el('input', { attrs: { type: 'checkbox' } });
        check.checked = !!state.alsoDefault;
        check.addEventListener('change', function () {
          state.alsoDefault = !!check.checked;
        });
        body.appendChild(
          el(
            'label',
            { class: 'ob-check' },
            check,
            el('span', { class: 'ob-check-text', text: '同时用作默认聊天 API' })
          )
        );
        body.appendChild(
          el('div', {
            class: 'ob-field-hint',
            text: '勾选后，新建会话默认使用这个 API；之后随时可以在「API 管理」里修改。'
          })
        );

        footer.appendChild(prevBtn());
        var attrs = { type: 'button' };
        if (state.saving) attrs.disabled = 'disabled';
        footer.appendChild(
          el('button', {
            class: 'btn primary ob-btn',
            attrs: attrs,
            text: state.saving ? '保存中…' : '开始使用',
            on: { click: finish }
          })
        );
      }

      async function finish() {
        if (state.saving) return;
        if (!state.testOk) {
          toast('连接测试未通过，无法完成配置');
          gotoStep(3);
          return;
        }
        state.saving = true;
        render();

        try {
          // 1. Key 写入本机安全存储（绝不写 DB）
          await saveKey(state.id, state.apiKey);

          // 2. 全 App 只允许一条引导 API：把旧的降级为 chat
          var providers = await DB.all('providers');
          for (var i = 0; i < providers.length; i++) {
            var p = providers[i];
            if (p && p.role === 'guide' && p.id !== state.id) {
              p.role = 'chat';
              p.updatedAt = Util.now();
              await DB.put('providers', p);
            }
          }

          // 3. 写入 provider 元数据（role = guide）
          var now = Util.now();
          var existing = null;
          try {
            existing = await DB.get('providers', state.id);
          } catch (e) {
            existing = null;
          }
          var record = {
            id: state.id,
            role: 'guide',
            name: String(state.name || '').trim() || '引导 API',
            baseUrl: String(state.baseUrl || '').trim(),
            defaultModel: String(state.model || '').trim(),
            models: Array.isArray(state.models) ? state.models.slice() : [],
            lastStatus: 'ok',
            lastError: null,
            lastCheckedAt: now,
            createdAt: existing && existing.createdAt ? existing.createdAt : now,
            updatedAt: now
          };
          await DB.put('providers', record);

          // 4. 写入设置
          await DB.settings.set('guide_provider_id', state.id);
          if (state.alsoDefault) {
            await DB.settings.set('default_chat_provider_id', state.id);
          }
          // 首次补全默认沿用引导 API（用户之后可在设置里改）
          var genProviderId = await DB.settings.get('character_gen_provider_id', null);
          if (!genProviderId) {
            await DB.settings.set('character_gen_provider_id', state.id);
            await DB.settings.set('character_gen_model', record.defaultModel);
          }
          await DB.settings.set('onboarding_version', 1);

          // 5. 最后才置「已完成」——保证只有测试成功且保存成功才能进主界面
          await DB.settings.set('onboarding_completed', true);

          UI.toast('配置完成，开始使用');
          try {
            App.Router.tab('chatList');
          } catch (e) {
            App.Router.push('chatList', {});
          }
        } catch (e) {
          state.saving = false;
          if (!destroyed) render();
          UI.toast('保存失败：' + errText(e));
        }
      }

      // ------- 启动 -------
      try {
        page.setTitle('开始配置');
      } catch (e) {
        /* 忽略 */
      }
      render();
    }
  });
})();
