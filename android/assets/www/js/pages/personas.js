/* personas.js —— 「我的身份」列表页（二级页）
 * 入口：设置页「我的身份」→ Router.push('personas')
 * 功能：默认身份标记「默认」、新建/编辑身份、设为默认、删除（有会话引用时提示并清空引用）
 * 依赖：App.Persona（js/persona.js）、App.DB、App.UI、App.Router
 */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var UI = App.UI;
  var U = App.Util;
  var DB = App.DB;

  var PAGE = 'personas';

  var state = {
    root: null,
    page: null,
    destroyed: false,
    active: true,
    buildId: 0,
    rows: [],
    defaultId: '',
    loading: true,
    error: null,
    busy: false,
    refreshSeq: 0,
    listBox: null,
    statusBox: null
  };

  /* ---------------- 小工具 ---------------- */

  function el(tag, attrs) {
    return UI.el.apply(UI, [tag, attrs].concat(Array.prototype.slice.call(arguments, 2)));
  }

  function toast(text, type) {
    try {
      UI.toast(text, type);
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

  function firstLine(text, max) {
    if (!text) return '';
    if (U && typeof U.firstLine === 'function') {
      try {
        return U.firstLine(text, max || 30);
      } catch (e) {
        /* 继续走兜底 */
      }
    }
    var s = String(text).replace(/\s+/g, ' ').trim();
    var n = max || 30;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function personaModule() {
    return App.Persona && typeof App.Persona.list === 'function' ? App.Persona : null;
  }

  function isDefault(id) {
    return !!state.defaultId && String(state.defaultId) === String(id);
  }

  /* ---------------- 数据 ---------------- */

  async function loadData() {
    var P = personaModule();
    if (!P) throw new Error('身份模块未加载，请升级应用后重试');

    // 保证默认身份可用（老数据回填 / 第一次使用时创建「我」）
    if (typeof P.ensureDefault === 'function') {
      try {
        await P.ensureDefault();
      } catch (e) {
        console.error('[personas] 初始化默认身份失败', e);
      }
    }

    var rows = await P.list();
    var defaultId = '';
    if (typeof P.getDefaultId === 'function') {
      try {
        defaultId = await P.getDefaultId();
      } catch (e) {
        console.error('[personas] 读取默认身份失败', e);
        defaultId = '';
      }
    }
    return { rows: (rows || []).filter(Boolean), defaultId: defaultId || '' };
  }

  function refresh() {
    if (!state.root || state.destroyed) return Promise.resolve(null);
    var seq = (state.refreshSeq = (state.refreshSeq || 0) + 1);
    state.loading = state.rows.length === 0;
    state.error = null;
    renderStatus();

    return loadData()
      .then(function (data) {
        if (state.destroyed || seq !== state.refreshSeq) return null;
        state.rows = data.rows;
        state.defaultId = data.defaultId;
        state.loading = false;
        state.error = null;
        renderStatus();
        renderList();
        return null;
      })
      .catch(function (err) {
        if (state.destroyed || seq !== state.refreshSeq) return null;
        console.error('[personas] 读取身份列表失败', err);
        state.loading = false;
        state.error = err;
        renderStatus();
        renderList();
        return null;
      });
  }

  /* ---------------- 渲染 ---------------- */

  function renderStatus() {
    if (!state.statusBox) return;
    UI.clear(state.statusBox);
    if (state.loading) {
      try {
        UI.loading(state.statusBox, '正在读取我的身份…');
      } catch (e) {
        state.statusBox.appendChild(el('div', { class: 'loading', text: '正在读取我的身份…' }));
      }
    }
  }

  function renderList() {
    if (!state.listBox) return;
    UI.clear(state.listBox);

    if (state.error) {
      state.listBox.appendChild(
        UI.errorState({
          title: '读取我的身份失败',
          desc: errText(state.error),
          actionText: '重试',
          onAction: function () {
            refresh();
          }
        })
      );
      return;
    }
    if (state.loading) return;

    if (!state.rows.length) {
      state.listBox.appendChild(
        UI.empty({
          icon: 'user',
          title: '还没有身份',
          desc: '新建一个你在故事里扮演的身份吧',
          actionText: '新建身份',
          onAction: function () {
            openEdit('');
          }
        })
      );
      return;
    }

    state.rows.forEach(function (p) {
      state.listBox.appendChild(rowNode(p));
    });
  }

  function rowNode(p) {
    var titleRow = el(
      'div',
      { class: 'title persona-title-row' },
      el('span', { class: 'persona-name ellipsis', text: p.name || '我' }),
      isDefault(p.id) ? el('span', { class: 'badge green persona-badge', text: '默认' }) : null
    );

    var moreBtn = el('button', {
      class: 'icon-btn persona-more',
      attrs: { type: 'button', 'aria-label': '身份操作' },
      html: UI.icon('more', 18)
    });
    // 防止点「⋯」时同时触发行点击
    moreBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openMenu(p);
    });

    var cell = el(
      'div',
      { class: 'cell persona-row', attrs: { role: 'button', tabindex: '0' } },
      UI.avatar(p.name || '我', p.avatar, 'md'),
      el(
        'div',
        { class: 'main' },
        titleRow,
        el('div', { class: 'sub ellipsis persona-sub', text: firstLine(p.description, 30) || '还没有设定' })
      ),
      el('div', { class: 'side persona-side' }, moreBtn)
    );

    cell.addEventListener('click', function () {
      openEdit(p.id);
    });
    cell.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openEdit(p.id);
      }
    });
    cell.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      openMenu(p);
    });
    return cell;
  }

  /* ---------------- 操作 ---------------- */

  function openEdit(id) {
    try {
      Promise.resolve(App.Router.push('personaEdit', id ? { id: id } : {})).catch(function (err) {
        console.error('[personas] 打开编辑页失败', err);
        toast('打开编辑页失败：' + errText(err), 'error');
      });
    } catch (e) {
      console.error('[personas] 打开编辑页出错', e);
      toast('打开编辑页失败：' + errText(e), 'error');
    }
  }

  function openMenu(p) {
    var items = [{ id: 'edit', label: '编辑身份', icon: 'edit', desc: '修改名字、设定与头像' }];
    if (!isDefault(p.id)) {
      items.push({ id: 'default', label: '设为默认', icon: 'check', desc: '新建会话时默认使用这个身份' });
    }
    items.push({ id: 'delete', label: '删除身份', icon: 'delete', danger: true, desc: '删除后不可恢复' });

    return Promise.resolve(
      UI.sheet({ title: p.name || '我的身份', items: items })
    )
      .then(function (item) {
        if (!item) return null;
        if (item.id === 'edit') {
          openEdit(p.id);
          return null;
        }
        if (item.id === 'default') return setDefaultPersona(p);
        if (item.id === 'delete') return removePersona(p);
        return null;
      })
      .catch(function (err) {
        console.error('[personas] 身份操作失败', err);
        toast('操作失败：' + errText(err), 'error');
        return null;
      });
  }

  function setDefaultPersona(p) {
    var P = personaModule();
    if (!P || typeof P.setDefault !== 'function') {
      toast('身份模块未加载，无法设为默认', 'error');
      return Promise.resolve(null);
    }
    if (isDefault(p.id)) {
      toast('已经是默认身份了');
      return Promise.resolve(null);
    }
    return Promise.resolve(P.setDefault(p.id))
      .then(function () {
        toast('已设为默认身份', 'ok');
        return refresh();
      })
      .catch(function (err) {
        console.error('[personas] 设为默认失败', err);
        toast('设置失败：' + errText(err), 'error');
        return null;
      });
  }

  function countSessionsUsing(id) {
    if (!DB || typeof DB.all !== 'function') return Promise.resolve(0);
    return DB.all('sessions')
      .then(function (rows) {
        return (rows || []).filter(function (s) {
          return s && s.personaId === id;
        }).length;
      })
      .catch(function (err) {
        console.error('[personas] 统计会话引用失败', err);
        return 0;
      });
  }

  function removePersona(p) {
    if (state.busy) return Promise.resolve(null);
    state.busy = true;
    var name = p.name || '我';
    return countSessionsUsing(p.id)
      .then(function (count) {
        var message =
          count > 0
            ? '有 ' + count + ' 个会话正在使用「' + name + '」，删除后这些会话会改用匿名「我」。删除后不可恢复。'
            : '删除后不可恢复。';
        return UI.confirm({ title: '删除身份', message: message, okText: '删除', danger: true });
      })
      .then(function (ok) {
        if (!ok) return null;
        return doRemove(p);
      })
      .catch(function (err) {
        console.error('[personas] 删除身份失败', err);
        toast('删除失败：' + errText(err), 'error');
        return null;
      })
      .then(function (r) {
        state.busy = false;
        return r;
      });
  }

  async function doRemove(p) {
    var P = personaModule();
    var removed = 0;
    if (P && typeof P.remove === 'function') {
      // P.remove 内部会清理 sessions.personaId，并在删掉默认身份后重新挑一条
      removed = await P.remove(p.id);
    } else {
      await DB.del('personas', p.id);
      if (isDefault(p.id) && P && typeof P.setDefault === 'function') {
        await P.setDefault('');
        if (typeof P.ensureDefault === 'function') await P.ensureDefault();
      }
    }
    toast(
      removed > 0 ? '已删除身份「' + (p.name || '我') + '」，' + removed + ' 个会话改用匿名' : '已删除身份「' + (p.name || '我') + '」',
      'ok'
    );
    return refresh();
  }

  /* ---------------- 页面注册 ---------------- */

  App.Router.register(PAGE, {
    tab: false,
    title: '我的身份',

    build: function (root, params, page) {
      state.root = root;
      state.page = page;
      state.destroyed = false;
      state.active = true;
      state.buildId = (state.buildId || 0) + 1;
      state.rows = [];
      state.defaultId = '';
      state.loading = true;
      state.error = null;
      state.busy = false;
      var myBuild = state.buildId;

      root.classList.add('persona-page');
      UI.clear(root);

      var scroll = el(
        'div',
        { class: 'page-scroll persona-scroll' },
        el('div', {
          class: 'persona-tip',
          text: '设定你在故事里扮演的身份。聊天时角色会知道「你是谁」，并按照这个设定称呼你。'
        })
      );
      state.statusBox = el('div', { class: 'persona-status' });
      state.listBox = el('div', { class: 'list persona-list' });
      scroll.appendChild(state.statusBox);
      scroll.appendChild(state.listBox);

      var addBtn = el('button', {
        class: 'btn primary block persona-add-btn',
        attrs: { type: 'button' },
        text: '新建身份'
      });
      addBtn.addEventListener('click', function () {
        openEdit('');
      });
      var actions = el('div', { class: 'page-actions persona-actions' }, addBtn);

      root.appendChild(scroll);
      root.appendChild(actions);

      try {
        page.setTitle('我的身份');
      } catch (e) {
        /* 忽略 */
      }

      // 从编辑页返回 / 其它入口切回时刷新
      var offRouter = null;
      if (App.Router && typeof App.Router.onChange === 'function') {
        offRouter = App.Router.onChange(function (cur) {
          if (state.destroyed || state.buildId !== myBuild || !cur) return;
          var isThis = cur.name === PAGE;
          var wasActive = state.active;
          state.active = isThis;
          if (isThis && !wasActive) refresh();
        });
      }

      page.onDestroy(function () {
        state.destroyed = true;
        state.active = false;
        if (typeof offRouter === 'function') offRouter();
      });

      return refresh();
    }
  });
})();
