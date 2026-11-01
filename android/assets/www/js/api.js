/* api.js —— App.API：OpenAI 兼容接口封装（Key 始终留在原生侧，JS 只按 providerId 取用） */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var API = App.API = {};

  /* ---------------- 工具 ---------------- */
  function isFn(f) { return typeof f === 'function'; }
  function safeCall(fn, arg) { if (isFn(fn)) { try { fn(arg); } catch (e) { console.error('[api] 回调出错', e); } } }

  API.normalizeBaseUrl = function (baseUrl) {
    var t = String(baseUrl || '').trim().replace(/\s+/g, '');
    if (!t) return '';
    t = t.replace(/\/+$/, '');
    if (/\/chat\/completions\/?$/i.test(t)) t = t.replace(/\/chat\/completions\/?$/i, '');
    return t;
  };

  API.chatUrl = function (baseUrl) {
    var b = API.normalizeBaseUrl(baseUrl);
    if (!b) return '';
    return b + '/chat/completions';
  };

  API.modelsUrl = function (baseUrl) {
    var b = API.normalizeBaseUrl(baseUrl);
    if (!b) return '';
    return b + '/models';
  };

  function normUsage(u) {
    u = u || {};
    return {
      prompt_tokens: Number(u.prompt_tokens || u.input_tokens || 0) || 0,
      completion_tokens: Number(u.completion_tokens || u.output_tokens || 0) || 0,
      total_tokens: Number(u.total_tokens || 0) || 0
    };
  }

  function normError(err) {
    if (!err) return { code: 'unknown', message: '未知错误' };
    if (typeof err === 'string') return { code: 'unknown', message: err };
    var code = String(err.code || err.status || err.errorCode || 'unknown');
    var message = err.message || err.error || err.msg || err.text || '';
    return { code: code, message: String(message || '') };
  }

  API.normError = normError;

  /* ---------------- 错误码 → 中文 ---------------- */
  var ERROR_TABLE = {
    '400': { title: '请求格式不正确', hint: '服务端不接受本次请求参数。请检查模型名、参数（如 max_tokens）是否被该 API 支持。' },
    '401': { title: 'API Key 无效或未授权', hint: '请到「API 管理」检查 Key 是否粘贴完整、是否过期，或该 Key 是否有此模型的权限。' },
    '403': { title: '没有访问权限', hint: '这个 Key 存在，但没有调用该模型/接口的权限。可尝试更换模型或联系服务商开通。' },
    '404': { title: '接口地址不对', hint: '常见原因是 Base URL 少了或多了 /v1。标准写法示例：https://api.deepseek.com/v1' },
    '408': { title: '请求超时', hint: '网络较慢或服务端繁忙，请稍后重试；也可在设置中调大超时时间。' },
    '413': { title: '内容太长', hint: '本轮上下文超出模型上限。请开启新会话，或减少历史消息/缩短输入。' },
    '422': { title: '参数不被接受', hint: '服务端认为参数不合法，常见于 temperature/top_k 超出范围。请在预设里恢复默认值。' },
    '429': { title: '请求太频繁（限流）', hint: '稍等几秒再试；免费额度或并发限制用尽时也会返回这个错误。' },
    '500': { title: '服务端错误', hint: '对方服务器出问题了，通常稍后重试即可。' },
    '502': { title: '网关错误', hint: '上游服务暂时不可用，稍后重试。' },
    '503': { title: '服务暂不可用', hint: '服务端正在维护或过载，稍后重试。' },
    '504': { title: '网关超时', hint: '上游响应太慢，稍后重试或更换模型。' },
    timeout: { title: '请求超时', hint: '网络连接太慢或对方无响应。可检查网络、代理设置，或调大超时时间。' },
    offline: { title: '网络不可用', hint: '设备当前没有网络连接。请先连接 Wi-Fi 或移动网络；历史消息仍可离线查看。' },
    dns: { title: '域名解析失败', hint: '找不到服务器地址。请检查 Base URL 是否拼写正确、网络是否正常。' },
    tls: { title: '证书校验失败', hint: 'HTTPS 证书不受信任，可能是网络被劫持或代理证书问题。' },
    ssl: { title: '证书校验失败', hint: 'HTTPS 证书不受信任，可能是网络被劫持或代理证书问题。' },
    cancel: { title: '已取消', hint: '本次生成已被你手动停止。' },
    stream: { title: '流式传输中断', hint: '连接在生成过程中断开，可重试或关闭流式输出。' },
    parse: { title: '响应解析失败', hint: '服务端返回的不是预期的 JSON 格式，可能不是 OpenAI 兼容接口。' },
    nokey: { title: '缺少 API Key', hint: '请先在「API 管理」中为这个接口填写 Key。' },
    nobase: { title: '缺少接口地址', hint: '请先填写 Base URL，例如 https://api.openai.com/v1' },
    unknown: { title: '未知错误', hint: '可点「这是什么意思？」让引导助手帮你排查，或检查 API 配置。' }
  };

  API.errorInfo = function (err) {
    var e = normError(err);
    var code = e.code;
    var entry = ERROR_TABLE[code];
    if (!entry && /^\d+$/.test(code)) {
      var n = Number(code);
      if (n >= 500) entry = ERROR_TABLE['500'];
      else entry = ERROR_TABLE['unknown'];
    }
    if (!entry) entry = ERROR_TABLE[code] || ERROR_TABLE.unknown;
    return { code: code, title: entry.title, hint: entry.hint, message: e.message };
  };

  /* ---------------- Key 存取（经原生加密层） ---------------- */
  API.keyFor = function (providerOrId) {
    var id = typeof providerOrId === 'string' ? providerOrId : (providerOrId && providerOrId.id);
    if (!id) return Promise.resolve('');
    return App.Bridge.call('secure.get', { key: 'key:' + id }).then(function (r) {
      return (r && r.value) || '';
    }).catch(function () { return ''; });
  };

  API.setKey = function (providerId, key) {
    if (!providerId) return Promise.reject(new Error('缺少 providerId'));
    if (!key) return App.Bridge.call('secure.del', { key: 'key:' + providerId });
    return App.Bridge.call('secure.set', { key: 'key:' + providerId, value: String(key) });
  };

  API.delKey = function (providerId) {
    return App.Bridge.call('secure.del', { key: 'key:' + providerId });
  };

  /* ---------------- 就绪检查 ---------------- */
  API.checkProviderReady = function (provider) {
    if (!provider) return Promise.resolve({ ok: false, reason: '还没有可用的 API，请先添加。' });
    var base = API.normalizeBaseUrl(provider.baseUrl);
    if (!base) return Promise.resolve({ ok: false, reason: '缺少接口地址（Base URL）' });
    return API.keyFor(provider.id).then(function (key) {
      if (!key) return { ok: false, reason: '缺少 API Key' };
      return { ok: true, reason: '' };
    });
  };

  function prepare(provider) {
    return API.keyFor(provider && provider.id).then(function (key) {
      var base = API.normalizeBaseUrl(provider && provider.baseUrl);
      var model = (provider && provider.defaultModel) || '';
      return { baseUrl: base, apiKey: key, model: model };
    });
  }

  /* ---------------- 测试连通性 ---------------- */
  API.testProvider = function (provider, opts) {
    opts = opts || {};
    if (!provider) return Promise.resolve({ ok: false, models: [], error: { code: 'unknown', message: '未提供 API 配置' } });
    var base = API.normalizeBaseUrl(provider.baseUrl);
    if (!base) return Promise.resolve({ ok: false, models: [], error: { code: 'nobase', message: '缺少 Base URL' } });
    return API.keyFor(provider.id).then(function (key) {
      if (!key && !opts.allowNoKey) return { ok: false, models: [], error: { code: 'nokey', message: '缺少 API Key' } };
      return App.Bridge.call('net.test', {
        baseUrl: base, apiKey: key, timeoutMs: opts.timeoutMs || 20000
      }).then(function (r) {
        r = r || {};
        var models = Array.isArray(r.models) ? r.models : [];
        if (r.ok) return { ok: true, models: models, error: null };
        return { ok: false, models: models, error: normError(r.error) };
      }).catch(function (e) {
        return { ok: false, models: [], error: normError(e) };
      });
    });
  };

  API.listModels = function (provider) {
    return prepare(provider).then(function (p) {
      return App.Bridge.call('net.models', { baseUrl: p.baseUrl, apiKey: p.apiKey }).then(function (r) {
        r = r || {};
        return { ok: !!r.ok, models: Array.isArray(r.models) ? r.models : [], error: r.error ? normError(r.error) : null };
      });
    }).catch(function (e) { return { ok: false, models: [], error: normError(e) }; });
  };

  /* ---------------- 非流式一次性对话 ---------------- */
  API.chatOnce = function (opts) {
    opts = opts || {};
    return prepare(opts.provider).then(function (p) {
      if (!p.apiKey) return { ok: false, text: '', error: { code: 'nokey', message: '缺少 API Key' } };
      if (!p.baseUrl) return { ok: false, text: '', error: { code: 'nobase', message: '缺少 Base URL' } };
      var model = opts.model || p.model;
      if (!model) return { ok: false, text: '', error: { code: 'nomodel', message: '未指定模型' } };
      return App.Bridge.call('net.chat', {
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: model,
        messages: opts.messages || [],
        params: opts.params || {},
        timeoutMs: opts.timeoutMs || 120000
      }).then(function (r) {
        r = r || {};
        if (r.ok) return { ok: true, text: String(r.text || ''), usage: normUsage(r.usage), error: null };
        return { ok: false, text: '', usage: null, error: normError(r.error) };
      });
    }).catch(function (e) {
      return { ok: false, text: '', usage: null, error: normError(e) };
    });
  };

  // 便捷：system + user 单轮（角色补全、气泡「怎么走」等）
  API.completion = function (opts) {
    opts = opts || {};
    var messages = [];
    if (opts.system) messages.push({ role: 'system', content: String(opts.system) });
    messages.push({ role: 'user', content: String(opts.user || '') });
    return API.chatOnce({
      provider: opts.provider,
      model: opts.model,
      messages: messages,
      params: opts.params || { temperature: 0.8, max_tokens: opts.maxTokens || 1200 },
      timeoutMs: opts.timeoutMs || 120000
    });
  };

  /* ---------------- 流式对话 ---------------- */
  // 返回 { abort(), done }；回调：onDelta(text) / onDone({text,usage}) / onError({code,message})
  API.chatStream = function (opts) {
    opts = opts || {};
    var aborted = false;
    var inner = null;      // Bridge.stream 句柄
    var finished = false;
    var fullText = '';
    var resolveDone;
    var done = new Promise(function (res) { resolveDone = res; });

    function finish(result) {
      if (finished) return;
      finished = true;
      resolveDone(result);
    }

    function fail(err) {
      if (aborted) {
        safeCall(opts.onError, { code: 'cancel', message: '已取消' });
        finish({ ok: false, text: fullText, usage: null, error: { code: 'cancel', message: '已取消' } });
        return;
      }
      var e = normError(err);
      safeCall(opts.onError, e);
      finish({ ok: false, text: fullText, usage: null, error: e });
    }

    var handle = {
      done: done,
      abort: function () {
        if (finished || aborted) return;
        aborted = true;
        if (inner && inner.abort) { try { inner.abort(); } catch (e) {} }
        else { fail({ code: 'cancel', message: '已取消' }); }
      }
    };

    prepare(opts.provider).then(function (p) {
      if (aborted) { fail({ code: 'cancel', message: '已取消' }); return; }
      if (!p.apiKey) { fail({ code: 'nokey', message: '缺少 API Key' }); return; }
      if (!p.baseUrl) { fail({ code: 'nobase', message: '缺少 Base URL' }); return; }
      var model = opts.model || p.model;
      if (!model) { fail({ code: 'nomodel', message: '未指定模型' }); return; }
      var usage = null;

      inner = App.Bridge.stream({
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        model: model,
        messages: opts.messages || [],
        params: opts.params || {},
        timeoutMs: opts.timeoutMs || 180000
      }, function (ev) {
        if (!ev || aborted) return;
        if (ev.type === 'delta') {
          var piece = String(ev.text || '');
          if (!piece) return;
          fullText += piece;
          safeCall(opts.onDelta, piece);
        } else if (ev.type === 'usage') {
          usage = normUsage(ev.usage);
        } else if (ev.type === 'done') {
          usage = normUsage(ev.usage || usage);
          safeCall(opts.onDone, { text: fullText, usage: usage });
          finish({ ok: true, text: fullText, usage: usage, error: null });
        } else if (ev.type === 'error') {
          fail(ev.error || { code: 'stream', message: '流式传输中断' });
        }
      });

      if (inner && inner.done) {
        inner.done.then(function (r) {
          if (finished) return;
          if (r && r.ok) {
            var u = normUsage(r.usage);
            safeCall(opts.onDone, { text: fullText, usage: u });
            finish({ ok: true, text: fullText, usage: u, error: null });
          } else {
            fail((r && r.error) || { code: 'stream', message: '流式传输中断' });
          }
        }).catch(function (e) { fail(e); });
      }
    }).catch(function (e) { fail(e); });

    return handle;
  };

  /* ---------------- 会话消息构造 ---------------- */
  // 把 DB 消息整理成 API messages（仅取 isActive 的消息，按时间升序）
  API.toApiMessages = function (rows, opts) {
    opts = opts || {};
    var list = (rows || []).filter(function (m) { return m && (m.isActive !== false) && m.status !== 'error'; });
    list.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    var msgs = list.map(function (m) {
      var c = '';
      if (m.variants && m.variants.length && typeof m.variantIndex === 'number' && m.variants[m.variantIndex]) {
        c = m.variants[m.variantIndex].content;
      } else {
        c = m.content || '';
      }
      var role = m.role === 'ai' ? 'assistant' : m.role;
      var atts = Array.isArray(m.attachments) ? m.attachments : [];
      if (!atts.length) return { role: role, content: String(c || '') };

      // 文件：内容拼进文本；图片：走 OpenAI 兼容的多模态 content 数组
      var text = String(c || '');
      var images = [];
      atts.forEach(function (att) {
        if (!att || !att.kind) return;
        if (att.kind === 'image' && att.dataUri) {
          images.push(att);
        } else if (att.kind === 'file' && att.text) {
          text += (text ? '\n\n' : '') + '【用户发送的文件：' + String(att.name || '文件') + '】\n' + String(att.text);
          if (att.truncated) text += '\n（文件较长，以上为前 ' + String(att.text).length + ' 字）';
        }
      });
      if (!images.length) return { role: role, content: text };

      var parts = [];
      parts.push({ type: 'text', text: text || '（用户发来一张图片，请结合图片内容回应）' });
      images.forEach(function (att) {
        parts.push({ type: 'image_url', image_url: { url: String(att.dataUri) } });
      });
      return { role: role, content: parts };
    }).filter(function (m) { return m.role === 'system' || m.role === 'user' || m.role === 'assistant'; });
    if (opts.maxMessages && msgs.length > opts.maxMessages) {
      var system = msgs.filter(function (m) { return m.role === 'system'; });
      var rest = msgs.filter(function (m) { return m.role !== 'system'; });
      rest = rest.slice(Math.max(0, rest.length - (opts.maxMessages - system.length)));
      msgs = system.concat(rest);
    }
    return msgs;
  };

  /* ---------------- 通用请求参数整理 ---------------- */
  API.cleanParams = function (params) {
    var out = {};
    params = params || {};
    ['temperature', 'top_p', 'top_k', 'max_tokens', 'presence_penalty', 'frequency_penalty'].forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        var n = Number(params[k]);
        if (!isNaN(n)) out[k] = n;
      }
    });
    if (Array.isArray(params.stop) && params.stop.length) out.stop = params.stop.filter(Boolean).slice(0, 4);
    else if (typeof params.stop === 'string' && params.stop.trim()) out.stop = [params.stop.trim()];
    return out;
  };
})();
