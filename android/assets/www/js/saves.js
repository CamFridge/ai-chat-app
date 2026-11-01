/* ============================================================================
 * App.Saves —— 会话存档 / 读档 / 以存档开新对话
 * ----------------------------------------------------------------------------
 * 数据表：saves（IndexedDB v3，由 db.js 建表）
 *   { id, name, note, sessionId, characterId, title,
 *     providerId, model, presetId, personaId, greetingIndex,
 *     messages: [...], createdAt }
 *
 * 设计要点：
 * - 存档是「消息快照」，不引用原消息 id；读档 / 开新对话时消息会分配新 id。
 * - 存档不保存 API Key（Key 本来就不在 DB 里）。
 * - 读档只覆盖当前会话的消息与关键配置，不动 characterId。
 * ========================================================================== */
(function (global) {
  'use strict';

  var App = global.App = global.App || {};
  var U = App.Util;
  var D = App.DB;

  var MAX_SAVES_PER_SESSION = 60;
  var MAX_SAVES_TOTAL = 300;

  function now() { return (U && U.now) ? U.now() : Date.now(); }

  function cloneMessage(m) {
    var out = {
      sessionId: m.sessionId,
      role: m.role || 'assistant',
      content: m.content || '',
      variantIndex: m.variantIndex || 0,
      isActive: m.isActive !== false,
      status: m.status || 'ok',
      errorText: m.errorText || '',
      tokensIn: m.tokensIn || 0,
      tokensOut: m.tokensOut || 0,
      createdAt: m.createdAt || now()
    };
    if (m.attachments && m.attachments.length) out.attachments = JSON.parse(JSON.stringify(m.attachments));
    if (m.variants && m.variants.length) out.variants = JSON.parse(JSON.stringify(m.variants));
    if (m.model) out.model = m.model;
    if (m.usage) out.usage = JSON.parse(JSON.stringify(m.usage));
    return out;
  }

  function freshMessages(sessionId, list) {
    return (list || []).map(function (m) {
      var copy = cloneMessage(m);
      copy.id = U.uid('msg');
      copy.sessionId = sessionId;
      return copy;
    });
  }

  function lastActive(list) {
    var arr = (list || []).filter(function (m) { return m.isActive !== false && m.status !== 'error'; });
    return arr.length ? arr[arr.length - 1] : null;
  }

  function previewOf(msg) {
    if (!msg) return '';
    if (App.ChatKit && typeof App.ChatKit.previewMessage === 'function') {
      try { return App.ChatKit.previewMessage(msg, 60) || ''; } catch (e) { /* ignore */ }
    }
    var text = String(msg.content || '').replace(/\s+/g, ' ').trim();
    if (msg.attachments && msg.attachments.length) {
      var names = msg.attachments.map(function (a) { return a && a.kind === 'file' ? '［文件］' + (a.name || '') : '［图片］'; });
      text = (text ? text + ' ' : '') + names.join(' ');
    }
    return text.slice(0, 60);
  }

  var S = {};

  /* 给会话打一个存档 */
  S.snapshot = function (sessionId, opts) {
    opts = opts || {};
    if (!sessionId) return Promise.reject(new Error('缺少会话'));
    return Promise.all([D.get('sessions', sessionId), D.byIndex('messages', 'sessionId', sessionId)])
      .then(function (arr) {
        var session = arr[0];
        var messages = (arr[1] || []).slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        if (!session) throw new Error('会话不存在');
        if (!messages.length && !opts.allowEmpty) throw new Error('这个会话还没有消息，暂时不能存档');
        if (messages.length > 800) messages = messages.slice(-800);
        var name = String(opts.name || '').trim() || defaultName(session);
        var last = lastActive(messages);
        return D.put('saves', {
          id: U.uid('save'),
          name: name.slice(0, 40),
          note: String(opts.note || '').slice(0, 200),
          sessionId: session.id,
          characterId: session.characterId || '',
          title: session.title || '',
          providerId: session.providerId || '',
          model: session.model || '',
          presetId: session.presetId || '',
          personaId: session.personaId || '',
          greetingIndex: typeof session.greetingIndex === 'number' ? session.greetingIndex : 0,
          messages: messages.map(cloneMessage),
          createdAt: now()
        }).then(function (rec) {
          return rec;
        });
      });
  };

  function defaultName(session) {
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return (session.title || '会话') + ' · ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  S.list = function (opts) {
    opts = opts || {};
    var p;
    if (opts.sessionId) p = D.byIndex('saves', 'sessionId', opts.sessionId);
    else if (opts.characterId) p = D.byIndex('saves', 'characterId', opts.characterId);
    else p = D.all('saves');
    return Promise.resolve(p).then(function (list) {
      return (list || []).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    });
  };

  S.get = function (id) { return D.get('saves', id); };

  S.remove = function (id) { return D.del('saves', id); };

  S.rename = function (id, name) {
    return D.get('saves', id).then(function (rec) {
      if (!rec) throw new Error('存档不存在');
      rec.name = String(name || '').trim().slice(0, 40) || rec.name;
      return D.put('saves', rec);
    });
  };

  /* 读档：覆盖当前会话的消息与配置 */
  S.restore = function (saveId) {
    return S.get(saveId).then(function (save) {
      if (!save) throw new Error('存档不存在');
      return D.get('sessions', save.sessionId).then(function (session) {
        if (!session) throw new Error('原会话已被删除，无法读档');
        return D.byIndex('messages', 'sessionId', save.sessionId).then(function (rows) {
          var oldIds = (rows || []).map(function (m) { return m.id; });
          return D.delMany('messages', oldIds).then(function () {
            var restored = freshMessages(save.sessionId, save.messages);
            return D.bulkPut('messages', restored).then(function () {
              var last = lastActive(restored);
              session.providerId = save.providerId || session.providerId;
              session.model = save.model || session.model;
              session.presetId = save.presetId || session.presetId;
              session.personaId = save.personaId || session.personaId;
              session.greetingIndex = save.greetingIndex;
              session.unread = 0;
              session.isGenerating = false;
              session.lastText = previewOf(last);
              session.lastRole = last ? last.role : '';
              session.lastAt = last ? last.createdAt : now();
              session.updatedAt = now();
              return D.put('sessions', session).then(function () {
                return { session: session, count: restored.length, save: save };
              });
            });
          });
        });
      });
    });
  };

  /* 以某个存档为起点，开一个新对话 */
  S.newFromSave = function (saveId) {
    return S.get(saveId).then(function (save) {
      if (!save) throw new Error('存档不存在');
      return D.get('characters', save.characterId).then(function (character) {
        if (!character) throw new Error('角色已被删除，无法开新对话');
        var ts = now();
        var session = {
          id: U.uid('sess'),
          title: character.name || save.title || '新会话',
          characterId: save.characterId,
          personaId: save.personaId || '',
          presetId: save.presetId || '',
          model: save.model || '',
          providerId: save.providerId || '',
          pinned: false,
          unread: 0,
          isGenerating: false,
          greetingIndex: save.greetingIndex,
          lastText: '',
          lastRole: '',
          lastAt: ts,
          createdAt: ts,
          updatedAt: ts
        };
        var msgs = freshMessages(session.id, save.messages);
        return D.put('sessions', session).then(function (saved) {
          if (!msgs.length) return saved;
          return D.bulkPut('messages', msgs).then(function () {
            var last = lastActive(msgs);
            saved.lastText = previewOf(last);
            saved.lastRole = last ? last.role : '';
            saved.lastAt = last ? last.createdAt : ts;
            saved.updatedAt = ts;
            return D.put('sessions', saved);
          });
        });
      });
    });
  };

  /* 存档占用统计（用于限制与 UI 提示） */
  S.count = function (opts) {
    return S.list(opts || {}).then(function (list) { return list.length; });
  };

  S.MAX_SAVES_PER_SESSION = MAX_SAVES_PER_SESSION;
  S.MAX_SAVES_TOTAL = MAX_SAVES_TOTAL;

  App.Saves = S;
})(window);
