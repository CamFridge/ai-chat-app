/* db.js —— IndexedDB 封装，挂到 window.App.DB
   表：providers/worldviews/characters/personas/presets/sessions/messages/helpSessions/helpMessages/characterImages/settings
   索引：messages.sessionId、helpMessages.sessionId、sessions.characterId、providers.role、characterImages.characterId */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var DB = App.DB = {};

  var DB_NAME = 'aichat';
  var DB_VERSION = 2;
  var STORES = ['providers', 'worldviews', 'characters', 'personas', 'presets', 'sessions', 'messages', 'helpSessions', 'helpMessages', 'characterImages', 'settings'];
  var INDEXES = [
    { store: 'messages', name: 'sessionId', keyPath: 'sessionId' },
    { store: 'helpMessages', name: 'sessionId', keyPath: 'sessionId' },
    { store: 'sessions', name: 'characterId', keyPath: 'characterId' },
    { store: 'providers', name: 'role', keyPath: 'role' },
    { store: 'characterImages', name: 'characterId', keyPath: 'characterId' }
  ];

  var _db = null;
  var _opening = null;

  function reqProm(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 操作失败')); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB 事务失败')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB 事务已中止')); };
    });
  }

  function openDB() {
    if (_db) return Promise.resolve(_db);
    if (_opening) return _opening;
    _opening = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }
      var req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = req.result;
        var oldV = e.oldVersion || 0;
        STORES.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) {
            var os;
            if (name === 'settings') os = db.createObjectStore(name, { keyPath: 'key' });
            else os = db.createObjectStore(name, { keyPath: 'id' });
            if (name === 'messages' || name === 'helpMessages') {
              os.createIndex('sessionId', 'sessionId', { unique: false });
              os.createIndex('createdAt', 'createdAt', { unique: false });
            }
            if (name === 'sessions') os.createIndex('characterId', 'characterId', { unique: false });
            if (name === 'providers') os.createIndex('role', 'role', { unique: false });
            if (name === 'characterImages') os.createIndex('characterId', 'characterId', { unique: false });
          } else if (oldV < DB_VERSION) {
            var existing = req.transaction.objectStore(name);
            INDEXES.filter(function (ix) { return ix.store === name; }).forEach(function (ix) {
              if (!existing.indexNames.contains(ix.name)) existing.createIndex(ix.name, ix.keyPath, { unique: false });
            });
          }
        });
      };
      req.onsuccess = function () {
        _db = req.result;
        _db.onversionchange = function () { try { _db.close(); } catch (e) {} _db = null; _opening = null; };
        _db.onclose = function () { _db = null; _opening = null; };
        resolve(_db);
      };
      req.onerror = function () {
        _opening = null;
        reject(req.error || new Error('IndexedDB 打开失败'));
      };
      req.onblocked = function () { /* 其他页面占用旧版本，等待其关闭 */ };
    });
    return _opening;
  }

  function store(name, mode) {
    if (STORES.indexOf(name) < 0) return Promise.reject(new Error('未知数据表：' + name));
    return openDB().then(function (db) {
      var tx = db.transaction(name, mode || 'readonly');
      return { tx: tx, os: tx.objectStore(name) };
    });
  }

  DB.ready = function () { return openDB().then(function () { return true; }); };
  DB.TABLES = STORES.slice();

  DB.get = function (table, id) {
    return store(table, 'readonly').then(function (s) {
      return reqProm(s.os.get(id)).then(function (r) { return r || null; });
    });
  };

  DB.put = function (table, record) {
    if (!record || typeof record !== 'object') return Promise.reject(new Error('记录必须为对象'));
    var rec = record;
    var keyPath = table === 'settings' ? 'key' : 'id';
    if (keyPath === 'id' && !rec.id) {
      rec = Object.assign({}, rec);
      rec.id = App.Util.uid(table.slice(0, 4));
    }
    if (keyPath === 'key' && !rec.key) return Promise.reject(new Error('settings 记录缺 key'));
    return store(table, 'readwrite').then(function (s) {
      var p = reqProm(s.os.put(rec));
      return Promise.all([p, txDone(s.tx)]).then(function () { return rec; });
    });
  };

  DB.bulkPut = function (table, records) {
    if (!records || !records.length) return Promise.resolve([]);
    var keyPath = table === 'settings' ? 'key' : 'id';
    var recs = records.map(function (r) {
      var rec = Object.assign({}, r);
      if (keyPath === 'id' && !rec.id) rec.id = App.Util.uid(table.slice(0, 4));
      return rec;
    });
    return store(table, 'readwrite').then(function (s) {
      var ps = recs.map(function (r) { return reqProm(s.os.put(r)); });
      return Promise.all(ps.concat([txDone(s.tx)])).then(function () { return recs; });
    });
  };

  DB.putMany = DB.bulkPut;

  DB.del = function (table, id) {
    return store(table, 'readwrite').then(function (s) {
      var p = reqProm(s.os['delete'](id));
      return Promise.all([p, txDone(s.tx)]).then(function () { return true; });
    });
  };

  DB.delMany = function (table, ids) {
    if (!ids || !ids.length) return Promise.resolve(true);
    return store(table, 'readwrite').then(function (s) {
      var ps = ids.map(function (id) { return reqProm(s.os['delete'](id)); });
      return Promise.all(ps.concat([txDone(s.tx)])).then(function () { return true; });
    });
  };

  DB.all = function (table) {
    return store(table, 'readonly').then(function (s) {
      return reqProm(s.os.getAll()).then(function (r) { return r || []; });
    });
  };

  DB.count = function (table) {
    return store(table, 'readonly').then(function (s) {
      return reqProm(s.os.count()).then(function (r) { return r || 0; });
    });
  };

  DB.byIndex = function (table, index, value) {
    return store(table, 'readonly').then(function (s) {
      if (!s.os.indexNames.contains(index)) return [];
      return reqProm(s.os.index(index).getAll(value)).then(function (r) { return r || []; });
    });
  };

  DB.clear = function (table) {
    return store(table, 'readwrite').then(function (s) {
      var p = reqProm(s.os.clear());
      return Promise.all([p, txDone(s.tx)]).then(function () { return true; });
    });
  };

  DB.clearAll = function () {
    return openDB().then(function (db) {
      var names = Array.prototype.slice.call(db.objectStoreNames);
      if (!names.length) return true;
      var tx = db.transaction(names, 'readwrite');
      names.forEach(function (n) { tx.objectStore(n).clear(); });
      return txDone(tx).then(function () { return true; });
    });
  };

  /* ---------------- 便捷查询 ---------------- */
  // 按字段过滤 + 排序：DB.query('sessions', {where:{...}, sortBy:'updatedAt', desc:true})
  DB.query = function (table, opts) {
    opts = opts || {};
    return DB.all(table).then(function (rows) {
      if (opts.where) {
        var keys = Object.keys(opts.where);
        rows = rows.filter(function (r) {
          return keys.every(function (k) {
            var v = opts.where[k];
            if (typeof v === 'function') return v(r[k], r);
            return r[k] === v;
          });
        });
      }
      if (opts.sortBy) {
        var desc = opts.desc !== false;
        rows.sort(function (a, b) {
          var x = a[opts.sortBy], y = b[opts.sortBy];
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (x < y ? -1 : 1) * (desc ? -1 : 1);
        });
      }
      if (opts.limit) rows = rows.slice(0, opts.limit);
      return rows;
    });
  };

  // 便捷取单个（不存在返回 null）
  DB.findBy = function (table, field, value) {
    return DB.all(table).then(function (rows) {
      for (var i = 0; i < rows.length; i++) if (rows[i][field] === value) return rows[i];
      return null;
    });
  };

  /* ---------------- settings 键值封装 ---------------- */
  DB.settings = {
    get: function (key, def) {
      return store('settings', 'readonly').then(function (s) {
        return reqProm(s.os.get(key)).then(function (r) {
          if (!r) return def === undefined ? null : def;
          return typeof def !== 'undefined' && r.value === undefined ? def : r.value;
        });
      }).catch(function () { return def === undefined ? null : def; });
    },
    set: function (key, value) {
      return store('settings', 'readwrite').then(function (s) {
        var p = reqProm(s.os.put({ key: key, value: value }));
        return Promise.all([p, txDone(s.tx)]).then(function () { return true; });
      });
    },
    del: function (key) {
      return store('settings', 'readwrite').then(function (s) {
        var p = reqProm(s.os['delete'](key));
        return Promise.all([p, txDone(s.tx)]).then(function () { return true; });
      });
    },
    all: function () {
      return DB.all('settings').then(function (rows) {
        var out = {};
        (rows || []).forEach(function (r) { out[r.key] = r.value; });
        return out;
      });
    },
    getMany: function (keys, defs) {
      return DB.settings.all().then(function (all) {
        var out = {};
        keys.forEach(function (k) { out[k] = Object.prototype.hasOwnProperty.call(all, k) ? all[k] : (defs && defs[k]); });
        return out;
      });
    }
  };

  /* ---------------- 数据导入/导出辅助（不含 Key） ---------------- */
  DB.exportAll = function () {
    var tables = STORES.filter(function (t) { return t !== 'settings'; });
    var out = { app: 'aichat', version: 2, exportedAt: Date.now(), tables: {} };
    return tables.reduce(function (p, t) {
      return p.then(function () { return DB.all(t).then(function (rows) { out.tables[t] = rows; }); });
    }, Promise.resolve()).then(function () {
      return DB.settings.all().then(function (s) {
        var safe = {};
        Object.keys(s).forEach(function (k) { safe[k] = s[k]; });
        out.settings = safe;
        return out;
      });
    });
  };

  DB.importAll = function (data, opts) {
    opts = opts || {};
    if (!data || !data.tables) return Promise.reject(new Error('备份数据格式不正确'));
    var tables = STORES.filter(function (t) { return t !== 'settings'; });
    if (opts.replace) {
      return tables.reduce(function (p, t) {
        return p.then(function () { return DB.clear(t); });
      }, Promise.resolve()).then(function () { return doImport(data); });
    }
    return doImport(data);

    function doImport(d) {
      return tables.reduce(function (p, t) {
        var rows = (d.tables && d.tables[t]) || [];
        return p.then(function () { return DB.bulkPut(t, rows); });
      }, Promise.resolve()).then(function () {
        var s = d.settings || {};
        return Object.keys(s).reduce(function (p, k) { return p.then(function () { return DB.settings.set(k, s[k]); }); }, Promise.resolve());
      }).then(function () {
        return { ok: true, tables: tables.length };
      });
    }
  };
})();
