/* ============================================================
 * data/presets.js
 * 内置对话预设（陪聊 / 助手），以及「确保内置预设存在」的落库函数。
 * 加载时机：data/worldviews.js 之后、prompts.js 之前。
 * 约定：本文件只定义常量与函数；ensureBuiltinPresets() 由 main.js 或页面调用。
 * ============================================================ */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  App.Data = App.Data || {};

  /* ============================================================
   * 一、内置预设（isBuiltin:true，只可编辑参数、不建议删除）
   * 字段：id / name / params{temperature,top_p,top_k,max_tokens,presence_penalty,frequency_penalty,stop[]}
   *       instructTemplate / mode / appliesTo / isBuiltin
   * ============================================================ */
  App.Data.BUILTIN_PRESETS = [
    {
      id: 'preset-companion',
      name: '陪聊 · 默认',
      desc: '更活泼、更自由的采样参数，适合角色扮演与日常闲聊。',
      params: {
        temperature: 0.9,
        top_p: 0.95,
        top_k: 0,
        max_tokens: 800,
        presence_penalty: 0.2,
        frequency_penalty: 0.3,
        stop: []
      },
      instructTemplate: [
        '你正在以角色身份与用户聊天。请始终用角色本身的口吻说话，不要跳出角色，不要解释自己是 AI 或语言模型。',
        '保持角色的性格、经历与说话方式前后一致，回复自然、生活化、有情绪，多用短句和口语。',
        '不要写小说旁白，不要过度煽情，不要长篇大论；像真人聊天一样回应，可以自然地追问或岔开话题。',
        '只有用户明确要求「退出扮演」时，才以角色口吻温和收尾并说明可以结束对话。'
      ].join('\n'),
      mode: 'chat',
      appliesTo: 'companion',
      isBuiltin: true
    },
    {
      id: 'preset-assistant',
      name: '助手 · 默认',
      desc: '低温、更克制的采样参数，适合专业问答与结构化输出。',
      params: {
        temperature: 0.3,
        top_p: 0.9,
        top_k: 0,
        max_tokens: 1200,
        presence_penalty: 0,
        frequency_penalty: 0,
        stop: []
      },
      instructTemplate: [
        '你是一位严谨、务实的领域助手。先给结论，再给必要的解释与可执行步骤，必要时分点列出。',
        '只回答与专业相关的内容；条件不足时先问清关键信息，不要臆测用户没有提供的事实。',
        '不确定的内容要明确说明不确定，并指出需要查阅资料或咨询专业人士。',
        '不要扮演、不要卖萌、不要使用网络流行语。涉及医疗、法律、金融等高风险内容时，必须提醒这只是信息参考，不能替代执业专业人士的意见。'
      ].join('\n'),
      mode: 'chat',
      appliesTo: 'assistant',
      isBuiltin: true
    }
  ];

  // 常用预设 id 常量，供创建角色 / 新建会话时按类型取默认预设
  App.Data.PRESET_IDS = {
    companion: 'preset-companion',
    assistant: 'preset-assistant'
  };

  // 按类型取内置预设 id
  App.Data.defaultPresetId = function (type) {
    return type === 'assistant' ? App.Data.PRESET_IDS.assistant : App.Data.PRESET_IDS.companion;
  };

  // 由 DB 行反查内置预设（缺失时返回 null）
  App.Data.presetById = function (id) {
    var list = App.Data.BUILTIN_PRESETS || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  };

  /* ============================================================
   * 二、ensureBuiltinPresets —— 把缺失的内置预设补进 DB
   * - 幂等：已存在的 id 不覆盖（保留用户改过的参数）
   * - 单飞：并发调用只执行一次
   * - 不阻断：失败只 console.warn，返回已补入的列表
   * ============================================================ */
  var ensurePromise = null;

  App.Data.ensureBuiltinPresets = function () {
    if (!App.DB || typeof App.DB.put !== 'function') return Promise.resolve([]);
    if (ensurePromise) return ensurePromise;

    var list = App.Data.BUILTIN_PRESETS || [];
    var added = [];

    ensurePromise = list.reduce(function (chain, preset) {
      return chain.then(function () {
        return App.DB.get('presets', preset.id).then(function (exist) {
          if (exist) return null;
          var row = {
            id: preset.id,
            name: preset.name,
            params: preset.params || {},
            instructTemplate: preset.instructTemplate || '',
            mode: preset.mode || 'chat',
            appliesTo: preset.appliesTo || 'both',
            isBuiltin: true
          };
          return App.DB.put('presets', row).then(function (saved) {
            added.push(saved || row);
          });
        });
      });
    }, Promise.resolve()).then(function () {
      return added;
    }).catch(function (e) {
      console.warn('[presets] 内置预设写入失败', e);
      ensurePromise = null; // 失败后允许下次重试
      return added;
    });

    return ensurePromise;
  };
})();
