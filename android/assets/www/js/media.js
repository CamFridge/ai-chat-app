/* media.js —— 角色图片库 / 聊天附件（图片、文本文件）统一入口，挂到 window.App.Media

   数据表：characterImages（DB v2，keyPath id，index characterId）
   图片以 data URI 形式存 IndexedDB（原生 pickImage 会压缩到 ≤320px JPEG，体积可控）。
   消息附件不入库到 characterImages，只存在 messages/helpMessages 的 attachments 字段里。

   对外接口见 docs/FEATURE-media-god.md §2。
*/
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var Media = App.Media = {};
  var D = App.DB;
  var U = App.Util;

  var MAX_IMAGE_DATA = 3.2 * 1024 * 1024; // data URI 长度上限（约 2.4MB 原图）
  var MAX_FILE_CHARS = 8000;              // 文本文件入上下文的最大字符数
  var MAX_FILE_BYTES = 2 * 1024 * 1024;   // 文本文件读取上限
  var MAX_LIBRARY_IMAGES = 60;            // 单角色图片库上限

  function newId(prefix) {
    var id = (U && U.uid) ? U.uid() : (prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    return prefix + id;
  }

  function bytesOfDataUri(dataUri) {
    var s = String(dataUri || '');
    var comma = s.indexOf(',');
    if (comma < 0) return 0;
    var b64 = s.slice(comma + 1);
    return Math.round(b64.length * 3 / 4);
  }

  function mimeOfDataUri(dataUri) {
    var m = /^data:([^;,]+)/.exec(String(dataUri || ''));
    return m ? m[1] : 'image/jpeg';
  }

  function safeText(v, max) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\|/g, '／')
      .trim()
      .slice(0, max || 120);
  }

  /* ---------------- 选择/读取 ---------------- */

  // 从相册选择图片（原生或浏览器 mock 均可用）
  Media.pickImage = function () {
    return Promise.resolve()
      .then(function () {
        return App.Bridge.call('ui.pickImage', {}, { timeoutMs: 120000 });
      })
      .then(function (res) {
        res = res || {};
        var dataUri = String(res.dataUri || '');
        if (!dataUri) return null; // 用户取消
        if (!/^data:image\//i.test(dataUri)) {
          return Promise.reject(new Error('选择的文件不是图片'));
        }
        if (dataUri.length > MAX_IMAGE_DATA) {
          return Promise.reject(new Error('图片太大了，请选择小于约 2MB 的图片'));
        }
        if (bytesOfDataUri(dataUri) < 64) {
          return Promise.reject(new Error('图片读取失败，请重试'));
        }
        return {
          kind: 'image',
          name: safeText(res.name, 80) || Media.guessName('图片'),
          mime: mimeOfDataUri(dataUri),
          size: bytesOfDataUri(dataUri),
          dataUri: dataUri
        };
      });
  };

  // 选择文本文件（内容作为文本附件随消息发送）
  Media.pickFile = function () {
    return Promise.resolve()
      .then(function () {
        return App.Bridge.call('file.import', { accept: 'text/*,.md,.txt,.json,.csv,.log,.js,.html' }, { timeoutMs: 120000 });
      })
      .then(function (res) {
        res = res || {};
        var name = safeText(res.name, 80);
        var text = String(res.data || '');
        if (!name && !text) return null; // 用户取消
        if (text.length > MAX_FILE_BYTES) {
          return Promise.reject(new Error('文件太大了，请选择小于 2MB 的文本文件'));
        }
        var truncated = text.length > MAX_FILE_CHARS;
        return {
          kind: 'file',
          name: name || '文件.txt',
          mime: 'text/plain',
          size: text.length,
          text: truncated ? text.slice(0, MAX_FILE_CHARS) : text,
          truncated: truncated
        };
      });
  };

  Media.guessName = function (fileName) {
    var s = safeText(fileName, 80);
    if (!s) return '图片';
    return s;
  };

  /* ---------------- 角色图片库 CRUD ---------------- */

  Media.supported = function () { return true; };

  Media.addImage = function (characterId, att, meta) {
    if (!characterId) return Promise.reject(new Error('缺少角色 id'));
    if (!att || !att.dataUri) return Promise.reject(new Error('图片数据为空'));
    meta = meta || {};
    var rec = {
      id: newId('img_'),
      characterId: String(characterId),
      kind: 'image',
      name: safeText(att.name, 80) || '图片',
      caption: safeText(meta.caption, 120),
      mime: att.mime || mimeOfDataUri(att.dataUri),
      dataUri: att.dataUri,
      size: Number(att.size) || bytesOfDataUri(att.dataUri),
      source: meta.source === 'guide' ? 'guide' : 'user',
      createdAt: (U && U.now ? U.now() : Date.now())
    };
    return Media.count(characterId).then(function (n) {
      if (n >= MAX_LIBRARY_IMAGES) {
        throw new Error('这个角色的图片库最多 ' + MAX_LIBRARY_IMAGES + ' 张，请先删掉一些');
      }
      return D.put('characterImages', rec);
    });
  };

  Media.list = function (characterId) {
    if (!characterId) return Promise.resolve([]);
    return D.byIndex('characterImages', 'characterId', String(characterId)).then(function (rows) {
      return (rows || []).slice().sort(function (a, b) {
        return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
      });
    }).catch(function () { return []; });
  };

  Media.get = function (id) {
    if (!id) return Promise.resolve(null);
    return D.get('characterImages', id).catch(function () { return null; });
  };

  Media.update = function (id, patch) {
    return Media.get(id).then(function (rec) {
      if (!rec) throw new Error('图片不存在或已删除');
      patch = patch || {};
      if (patch.name !== undefined) rec.name = safeText(patch.name, 80) || rec.name;
      if (patch.caption !== undefined) rec.caption = safeText(patch.caption, 120);
      return D.put('characterImages', rec);
    });
  };

  Media.remove = function (id) {
    if (!id) return Promise.resolve(false);
    return D.del('characterImages', id).then(function () { return true; });
  };

  Media.removeByCharacter = function (characterId) {
    if (!characterId) return Promise.resolve(0);
    return Media.list(characterId).then(function (rows) {
      if (!rows.length) return 0;
      return D.delMany('characterImages', rows.map(function (r) { return r.id; })).then(function () { return rows.length; });
    });
  };

  Media.count = function (characterId) {
    if (!characterId) return Promise.resolve(0);
    return Media.list(characterId).then(function (rows) { return rows.length; });
  };

  /* ---------------- 系统提示词清单 ---------------- */

  Media.promptBlock = function (list, opts) {
    opts = opts || {};
    var rows = (list || []).slice(-Number(opts.max || 30));
    if (!rows.length) return '';
    var lines = rows.map(function (r) {
      var line = '- ID=' + r.id + '｜名称=' + safeText(r.name, 60);
      if (r.caption) line += '｜说明=' + safeText(r.caption, 100);
      return line;
    });
    return [
      '【你可以发送的图片库】',
      '下面是用户为你准备的图片，你可以在聊天里主动发给用户：',
      lines.join('\n'),
      '规则：想发某张图片时，在回复里单独一行写 [[img:图片ID]]（可以前后配一句话）。只能使用上面列出的 ID，不要编造；一次回复最多发 2 张。'
    ].join('\n');
  };

  /* ---------------- 预览浮层 ---------------- */

  Media.preview = function (input, opts) {
    var dataUri = typeof input === 'string' ? input : (input && input.dataUri);
    var name = (input && input.name) || (opts && opts.name) || '';
    if (!dataUri) return Promise.resolve(false);
    var UI = App.UI;
    if (!UI || !UI.modal) return Promise.resolve(false);
    var body = UI.el('div', { class: 'media-preview' });
    var img = UI.el('img', { class: 'media-preview-img', attrs: { src: dataUri, alt: name || '图片' } });
    body.appendChild(img);
    if (name) body.appendChild(UI.el('div', { class: 'media-preview-name', text: name }));
    return UI.modal({
      title: name || '图片预览',
      content: body,
      actions: [{ text: '关闭' }]
    });
  };

  /* ---------------- 附件辅助 ---------------- */

  Media.fileSizeText = function (bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\.0$/, '') + ' KB';
    return (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MB';
  };
})();
