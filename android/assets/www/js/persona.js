/* persona.js —— 多 persona（我的身份）数据层，挂到 window.App.Persona
 *
 * 契约（PLAN-v1.4.0 §2.3）：
 *   Persona.list()                 -> Promise<persona[]>  全部，按 updatedAt 倒序
 *   Persona.getDefaultId()         -> Promise<string>     settings.default_persona_id
 *   Persona.setDefault(id)         -> Promise<void>
 *   Persona.ensureDefault()        -> Promise<persona>    无默认且无任何 persona 时创建「我」
 *   Persona.resolve(personaId)     -> Promise<persona|null>
 *   Persona.promptLine(persona)    -> string '【用户设定】用户扮演：…'（空返回 ''）
 *   Persona.pickForSession(id)     -> Promise<persona|null>  sheet 选择身份并写 sessions.personaId
 *
 * 约定：
 *   - personas 表已有（keyPath id），字段 id/name/description/avatar；
 *     本模块额外读写 createdAt/updatedAt 用于排序（写入时补齐，不改 db.js 表结构）。
 *   - 默认身份 id 存 settings.default_persona_id。
 *   - 老数据兼容：有 persona 但默认值缺失/失效时，用 updatedAt 最新的一条回填为默认。
 *   - promptLine 的格式必须与 js/pages/chat-list.js 里 buildSystemPrompt 的 persona 段落一致：
 *       '【用户设定】用户扮演：' + (persona.name || '我') [+ '，' + persona.description]
 */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var P = App.Persona = {};

  var DEFAULT_KEY = 'default_persona_id';
  var DEFAULT_NAME = '我';
  // pickForSession 里「不设定身份」这一项的内部 id（不会落库）
  var NONE_ID = '__persona_none__';

  /* ---------------- 小工具 ---------------- */

  function dbOk() {
    return !!(App.DB && typeof App.DB.all === 'function' && typeof App.DB.get === 'function');
  }

  function settingsOk() {
    return !!(App.DB && App.DB.settings && typeof App.DB.settings.get === 'function');
  }

  function nowTs() {
    try {
      return App.Util && typeof App.Util.now === 'function' ? App.Util.now() : Date.now();
    } catch (e) {
      return Date.now();
    }
  }

  function toTs(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v) {
      var n = Date.parse(v);
      if (isFinite(n)) return n;
    }
    return 0;
  }

  function cmpText(a, b) {
    try {
      return String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN');
    } catch (e) {
      return String(a || '') < String(b || '') ? -1 : (String(a || '') > String(b || '') ? 1 : 0);
    }
  }

  // 按 updatedAt 倒序（缺失时看 createdAt，再按名字）
  function byUpdatedDesc(a, b) {
    var d = toTs(b.updatedAt) - toTs(a.updatedAt);
    if (d) return d;
    d = toTs(b.createdAt) - toTs(a.createdAt);
    if (d) return d;
    return cmpText(a.name, b.name);
  }

  function firstLine(text, max) {
    if (!text) return '';
    if (App.Util && typeof App.Util.firstLine === 'function') {
      try { return App.Util.firstLine(text, max || 24); } catch (e) { /* 继续走兜底 */ }
    }
    var s = String(text).replace(/\s+/g, ' ').trim();
    var n = max || 24;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function toast(text, type) {
    try {
      if (App.UI && typeof App.UI.toast === 'function') App.UI.toast(text, type);
    } catch (e) {
      /* 忽略 */
    }
  }

  function errText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    if (e.message) return e.message;
    return String(e);
  }

  /* ---------------- 读取 ---------------- */

  /**
   * 全部身份，按 updatedAt 倒序。
   * @returns {Promise<Array<{id:string,name:string,description?:string,avatar?:string}>>}
   */
  P.list = function () {
    if (!dbOk()) return Promise.reject(new Error('数据层未就绪'));
    return App.DB.all('personas').then(function (rows) {
      var out = [];
      (rows || []).forEach(function (r) {
        if (r && typeof r === 'object') out.push(r);
      });
      out.sort(byUpdatedDesc);
      return out;
    });
  };

  /**
   * 默认身份 id（没有则返回空串）。
   * @returns {Promise<string>}
   */
  P.getDefaultId = function () {
    if (!settingsOk()) return Promise.reject(new Error('数据层未就绪'));
    return App.DB.settings.get(DEFAULT_KEY, '').then(function (v) {
      return v === null || v === undefined ? '' : String(v);
    });
  };

  /**
   * 设置默认身份；传空串/空值表示清空默认。
   * @param {string} id
   * @returns {Promise<void>}
   */
  P.setDefault = function (id) {
    if (!settingsOk()) return Promise.reject(new Error('数据层未就绪'));
    return App.DB.settings.set(DEFAULT_KEY, id ? String(id) : '').then(function () {
      return undefined;
    });
  };

  /**
   * 保证至少有一个身份并且默认身份可用。
   * - 默认身份存在 → 直接返回；
   * - 有身份但没有默认（或默认已失效）→ 用 updatedAt 最新的一条回填默认；
   * - 一个身份都没有 → 创建「我」并设为默认。
   * @returns {Promise<Object>} persona
   */
  var ensureTask = null;

  P.ensureDefault = function () {
    // 并发去重：设置页和身份列表页可能同时调用
    if (ensureTask) return ensureTask;
    ensureTask = doEnsureDefault().then(
      function (persona) {
        ensureTask = null;
        return persona;
      },
      function (err) {
        ensureTask = null;
        throw err;
      }
    );
    return ensureTask;
  };

  function doEnsureDefault() {
    if (!dbOk() || !settingsOk()) return Promise.reject(new Error('数据层未就绪'));
    return Promise.all([P.getDefaultId(), P.list()]).then(function (arr) {
      var defaultId = arr[0];
      var rows = arr[1] || [];
      if (defaultId) {
        for (var i = 0; i < rows.length; i++) {
          if (rows[i] && String(rows[i].id) === defaultId) return rows[i];
        }
      }
      if (rows.length) {
        // 老数据：有 persona 但默认缺失/失效 → 用最新的一条
        var pick = rows[0];
        return P.setDefault(pick.id).then(function () {
          return pick;
        });
      }
      var ts = nowTs();
      var rec = { name: DEFAULT_NAME, description: '', avatar: '', createdAt: ts, updatedAt: ts };
      return App.DB.put('personas', rec).then(function (saved) {
        return P.setDefault(saved.id).then(function () {
          return saved;
        });
      });
    });
  }

  /**
   * 按 id 取身份；取不到返回 null（不抛错）。
   * @param {string} personaId
   * @returns {Promise<Object|null>}
   */
  P.resolve = function (personaId) {
    if (!personaId) return Promise.resolve(null);
    if (!dbOk()) return Promise.reject(new Error('数据层未就绪'));
    return App.DB.get('personas', String(personaId)).then(
      function (rec) {
        return rec || null;
      },
      function (err) {
        console.error('[persona] 读取身份失败', err);
        return null;
      }
    );
  };

  /* ---------------- 提示词 ---------------- */

  /**
   * persona 段落（与 chat-list.js 的 buildSystemPrompt 完全一致）。
   * @param {Object|null} persona
   * @returns {string} 空 persona 返回 ''
   */
  P.promptLine = function (persona) {
    if (!persona || typeof persona !== 'object') return '';
    var line = '【用户设定】用户扮演：' + (persona.name || DEFAULT_NAME);
    if (persona.description) line += '，' + persona.description;
    return line;
  };

  /* ---------------- 会话内切换 ---------------- */

  function loadPersonasForPick() {
    return P.list().then(function (rows) {
      if (rows && rows.length) return rows;
      // 一个都没有时先建「我」，保证 sheet 里至少有一个可选项
      return P.ensureDefault().then(function (persona) {
        return persona ? [persona] : [];
      });
    });
  }

  function writeSessionPersonaId(session, personaId) {
    var next = Object.assign({}, session, { personaId: personaId ? String(personaId) : '' });
    // 切换身份不算「会话活跃」，不动 updatedAt，避免聊天列表顺序被打乱
    return App.DB.put('sessions', next);
  }

  /**
   * 弹出身份选择 sheet：全部身份 + 「不设定身份」。
   * - 选中某个身份：写 sessions.personaId，返回该 persona
   * - 选「不设定身份」：sessions.personaId 置 ''，返回 null
   * - 取消/关闭：返回 undefined（不写库）
   * @param {string} sessionId
   * @returns {Promise<Object|null|undefined>}
   */
  P.pickForSession = function (sessionId) {
    if (!dbOk() || !App.DB.settings) {
      toast('数据层未就绪，暂时无法切换身份', 'error');
      return Promise.reject(new Error('数据层未就绪'));
    }
    if (!sessionId) {
      toast('会话不存在，无法切换身份', 'error');
      return Promise.resolve(undefined);
    }
    if (!App.UI || typeof App.UI.sheet !== 'function') {
      toast('当前环境不支持身份选择', 'error');
      return Promise.resolve(undefined);
    }

    return Promise.all([
      loadPersonasForPick(),
      App.DB.get('sessions', String(sessionId)).catch(function (err) {
        console.error('[persona] 读取会话失败', err);
        return null;
      })
    ])
      .then(function (arr) {
        var rows = arr[0] || [];
        var session = arr[1];
        if (!session) {
          toast('会话不存在，无法切换身份', 'error');
          return undefined;
        }
        var items = rows.map(function (p) {
          return {
            id: String(p.id),
            label: p.name || DEFAULT_NAME,
            desc: firstLine(p.description, 24) || '还没有设定',
            icon: 'user'
          };
        });
        items.push({
          id: NONE_ID,
          label: '不设定身份（用匿名「我」）',
          desc: '聊天时不把你的身份设定告诉角色',
          icon: 'close'
        });
        return App.UI.sheet({
          title: '我的身份',
          items: items,
          selected: session.personaId || '',
          cancelText: '取消'
        }).then(function (item) {
          // 取消按钮 / 点遮罩 / 关闭 → sheet 解析为 null
          if (item === null || item === undefined) return undefined;
          if (item.id === NONE_ID) {
            return writeSessionPersonaId(session, '').then(function () {
              return null;
            });
          }
          var picked = null;
          for (var i = 0; i < rows.length; i++) {
            if (String(rows[i].id) === String(item.id)) {
              picked = rows[i];
              break;
            }
          }
          if (!picked) {
            toast('这个身份已经不存在了', 'error');
            return undefined;
          }
          return writeSessionPersonaId(session, picked.id).then(function () {
            return picked;
          });
        });
      })
      .catch(function (err) {
        console.error('[persona] 切换身份失败', err);
        toast('切换身份失败：' + errText(err), 'error');
        return undefined;
      });
  };

  // 供其他模块复用（非契约，仅内部常量导出，避免重复硬编码）
  P.NONE_ID = NONE_ID;

  /* ---------------- 写库辅助（页面共用，避免重复实现） ---------------- */

  /**
   * 保存身份（新建时补 createdAt，总是刷新 updatedAt）。
   * @param {Object} data {id?, name, description, avatar}
   * @returns {Promise<Object>} 落库后的 record
   */
  P.save = function (data) {
    if (!dbOk()) return Promise.reject(new Error('数据层未就绪'));
    if (!data || !data.name || !String(data.name).trim()) {
      return Promise.reject(new Error('名字不能为空'));
    }
    var rec = {
      id: data.id || undefined,
      name: String(data.name).trim(),
      description: data.description ? String(data.description) : '',
      avatar: data.avatar ? String(data.avatar) : '',
      createdAt: data.createdAt ? toTs(data.createdAt) : nowTs(),
      updatedAt: nowTs()
    };
    if (!rec.id) delete rec.id;
    return App.DB.put('personas', rec);
  };

  /**
   * 删除身份：清空引用该身份的会话 personaId；若删的是默认身份则重新选一条并保证默认可用。
   * @param {string} personaId
   * @returns {Promise<number>} 被清空 personaId 的会话数
   */
  P.remove = function (personaId) {
    if (!dbOk()) return Promise.reject(new Error('数据层未就绪'));
    if (!personaId) return Promise.resolve(0);
    var id = String(personaId);
    var affectedCount = 0;
    return P.getDefaultId()
      .then(function (defaultId) {
        return App.DB.all('sessions').then(function (rows) {
          var affected = (rows || []).filter(function (s) {
            return s && s.personaId === id;
          });
          affectedCount = affected.length;
          return affected.reduce(function (p, s) {
            return p.then(function () {
              return App.DB.put('sessions', Object.assign({}, s, { personaId: '' })).catch(function (err) {
                console.error('[persona] 清理会话身份失败', err);
                return null;
              });
            });
          }, Promise.resolve(null));
        }).then(function () {
          return defaultId;
        });
      })
      .then(function (defaultId) {
        return App.DB.del('personas', id).then(function () {
          return defaultId;
        });
      })
      .then(function (defaultId) {
        if (defaultId !== id) return null;
        // 删掉的是默认身份：交给 ensureDefault 重新选一条（或重建「我」）
        return P.setDefault('').then(function () {
          return P.ensureDefault();
        });
      })
      .then(function () {
        return affectedCount;
      });
  };
})();
