/* pages/group-create.js —— 新建群聊页（v1.4.0 §3，路由名 groupCreate）
 * 群名输入 + 角色多选（至少 2 人）+ 搜索 → App.Group.create → 回到聊天列表并直接进入群聊。
 * 依赖：App.UI / App.DB / App.Util / App.Router / App.Group（加载顺序见 index.html）
 */
(function () {
  'use strict';
  var App = window.App = window.App || {};

  function UI() { return App.UI; }
  function U() { return App.Util || {}; }
  function DB() { return App.DB || null; }
  function Router() { return App.Router || {}; }
  function Group() { return App.Group || null; }

  function el(tag, attrs) {
    var ui = UI();
    var args = Array.prototype.slice.call(arguments);
    return ui.el.apply(ui, args);
  }

  function toast(text, type) {
    try { UI().toast(text, type || 'info'); } catch (e) { console.warn('[groupCreate]', text); }
  }

  var state = {
    root: null,
    page: null,
    chars: [],
    selected: {},      // id -> true
    order: [],         // 勾选顺序，决定群成员顺序
    nameDraft: '',     // 群名草稿（从别的页面返回重新渲染时保留）
    loading: true,
    error: null,
    saving: false,
    destroyed: false,
    lastRoute: '',
    offChange: null,
    nodes: {}
  };

  function resetState(root, page) {
    state.root = root;
    state.page = page;
    state.chars = [];
    state.selected = {};
    state.order = [];
    state.nameDraft = '';
    state.loading = true;
    state.error = null;
    state.saving = false;
    state.destroyed = false;
    state.lastRoute = 'groupCreate';
    state.offChange = null;
    state.nodes = {};
  }

  function errText(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    return err.message || String(err);
  }

  /* ---------------- 数据 ---------------- */

  function load() {
    var D = DB();
    if (!D || typeof D.all !== 'function') {
      state.loading = false;
      state.error = new Error('数据层未就绪，请重启应用');
      render();
      return Promise.resolve();
    }
    state.loading = true;
    state.error = null;
    if (state.nodes && state.nodes.nameInput) state.nameDraft = state.nodes.nameInput.value;
    return Promise.resolve(D.all('characters')).then(function (list) {
      if (state.destroyed) return null;
      var chars = (Array.isArray(list) ? list : []).filter(function (c) {
        return c && c.id && !c.hidden && !c.hideFromList;
      });
      chars.sort(function (a, b) {
        return Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0);
      });
      state.chars = chars;
      state.loading = false;
      render();
      return null;
    }).catch(function (err) {
      if (state.destroyed) return null;
      console.error('[groupCreate] 读取角色失败', err);
      state.loading = false;
      state.error = err;
      render();
      return null;
    });
  }

  /* ---------------- 选中状态 ---------------- */

  function selectedIds() { return state.order.slice(); }

  function toggle(id) {
    if (!id) return;
    if (state.selected[id]) {
      delete state.selected[id];
      var at = state.order.indexOf(id);
      if (at >= 0) state.order.splice(at, 1);
    } else {
      state.selected[id] = true;
      state.order.push(id);
    }
    updateSummary();
  }

  function updateSummary() {
    var n = selectedIds().length;
    var count = state.nodes.count;
    if (count) {
      count.textContent = '已选 ' + n + ' 人' + (n < 2 ? '（至少 2 人）' : '');
      count.classList.toggle('group-count-warn', n < 2);
    }
    var btn = state.nodes.submit;
    if (btn) {
      var ok = n >= 2 && String(state.nodes.nameInput ? state.nodes.nameInput.value : '').trim() !== '';
      if (ok) btn.removeAttribute('disabled');
      else btn.setAttribute('disabled', 'disabled');
    }
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    if (!state.root || state.destroyed) return;
    var ui = UI();
    ui.clear(state.root);
    state.root.classList.add('group-create-page');
    state.nodes = {};

    if (state.loading) {
      var box = el('div', { class: 'group-status' });
      state.root.appendChild(box);
      try { ui.loading(box, '正在读取角色…'); } catch (e) { box.appendChild(el('div', { class: 'loading', text: '正在读取角色…' })); }
      return;
    }

    if (state.error) {
      state.root.appendChild(ui.errorState({
        title: '角色加载失败',
        desc: errText(state.error),
        actionText: '重试',
        onAction: function () { load(); }
      }));
      return;
    }

    if (!state.chars.length) {
      state.root.appendChild(ui.empty({
        icon: 'character',
        title: '还没有角色',
        desc: '创建群聊至少需要 2 位角色，先创建角色再来建群吧。',
        actionText: '去创建角色',
        onAction: function () { goCharacterCreate(); }
      }));
      return;
    }

    if (state.chars.length < 2) {
      state.root.appendChild(ui.empty({
        icon: 'character',
        title: '角色数量不足',
        desc: '创建群聊至少需要 2 位角色，现在只有 1 位，再创建 1 位角色吧。',
        actionText: '去创建角色',
        onAction: function () { goCharacterCreate(); }
      }));
      return;
    }

    var scroll = el('div', { class: 'page-scroll group-create-scroll' });
    scroll.appendChild(nameCard());
    scroll.appendChild(memberSection());
    state.root.appendChild(scroll);
    state.root.appendChild(actionsBar());
    renderList();
    updateSummary();
  }

  function goCharacterCreate() {
    var R = Router();
    if (!R || typeof R.push !== 'function') return;
    var ret;
    try { ret = R.push('characterCreate'); } catch (e) { ret = null; }
    if (ret && typeof ret.catch === 'function') {
      ret.catch(function (err) { console.error('[groupCreate] 打开创建角色失败', err); toast('创建角色页打不开', 'error'); });
    }
  }

  function nameCard() {
    var input = el('input', {
      class: 'input group-name-input',
      attrs: { type: 'text', maxlength: '30', placeholder: '例如：周末闲聊群', 'aria-label': '群聊名称' },
      value: state.nameDraft || ''
    });
    input.addEventListener('input', function () {
      state.nameDraft = input.value;
      updateSummary();
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); try { input.blur(); } catch (e) { /* 忽略 */ } }
    });
    state.nodes.nameInput = input;

    var field = el('div', { class: 'field group-name-field' },
      el('label', { text: '群聊名称' }),
      input,
      el('div', { class: 'hint group-name-hint', text: '群名会显示在聊天列表和群聊页顶部，创建后还能改。' })
    );
    return el('div', { class: 'form group-form' }, field);
  }

  function memberSection() {
    var section = el('div', { class: 'group-section' });
    var count = el('div', { class: 'group-count group-count-warn', text: '已选 0 人（至少 2 人）' });
    state.nodes.count = count;
    section.appendChild(el('div', { class: 'group-section-head' },
      el('div', { class: 'group-section-title', text: '选择成员' }),
      count
    ));

    var searchInput = el('input', {
      class: 'group-member-search',
      attrs: { type: 'search', placeholder: '搜索角色名 / 性格 / 类型', 'aria-label': '搜索角色' }
    });
    var onSearch = function () { renderList(); };
    var debounced = null;
    try {
      if (typeof U().debounce === 'function') debounced = U().debounce(onSearch, 120);
    } catch (e) { debounced = null; }
    searchInput.addEventListener('input', debounced || onSearch);
    state.nodes.searchInput = searchInput;

    section.appendChild(el('div', { class: 'search-bar group-member-search-bar' },
      el('span', { class: 'search-icon', html: UI().icon('search') }),
      searchInput
    ));

    state.nodes.list = el('div', { class: 'list group-member-list' });
    section.appendChild(state.nodes.list);
    return section;
  }

  function actionsBar() {
    var btn = el('button', { class: 'btn primary block group-create-submit', attrs: { type: 'button' }, text: '创建群聊' });
    btn.addEventListener('click', submit);
    btn.setAttribute('disabled', 'disabled');
    state.nodes.submit = btn;
    return el('div', { class: 'page-actions group-create-actions' }, btn);
  }

  function hayOf(c) {
    var t = String(c.type || '');
    var typeText = t === 'assistant' ? '助手' : '陪聊';
    return [c.name, c.personality, c.description, typeText, t].join(' ').toLowerCase();
  }

  function renderList() {
    if (!state.nodes.list || state.destroyed) return;
    var ui = UI();
    var q = String(state.nodes.searchInput ? state.nodes.searchInput.value : '').trim().toLowerCase();
    var list = state.chars.filter(function (c) {
      if (!q) return true;
      if (state.selected[c.id]) return true; // 已选中的始终显示，避免搜索时误以为丢了
      return hayOf(c).indexOf(q) >= 0;
    });
    ui.clear(state.nodes.list);
    if (!list.length) {
      state.nodes.list.appendChild(el('div', { class: 'group-member-none', text: '没有匹配的角色' }));
      return;
    }
    var frag = ui.frag();
    list.forEach(function (c) { frag.appendChild(memberRow(c)); });
    state.nodes.list.appendChild(frag);
  }

  function typeText(c) { return c && c.type === 'assistant' ? '助手' : '陪聊'; }

  function memberRow(c) {
    var ui = UI();
    var on = !!state.selected[c.id];
    var row = el('div', { class: 'cell group-member-item' + (on ? ' selected' : ''), dataset: { id: c.id } });
    row.appendChild(ui.avatar(c.name || '角色', c.avatar, 'md'));

    var title = el('div', { class: 'title group-member-name' },
      el('span', { class: 'ellipsis', text: c.name || '未命名角色' }),
      el('span', { class: 'type-tag group-type-tag ' + (c.type === 'assistant' ? 'assistant' : 'companion'), text: typeText(c) })
    );
    var desc = el('div', {
      class: 'sub group-member-desc ellipsis',
      text: String(c.personality || c.description || '暂无角色简介').replace(/\s+/g, ' ').trim()
    });
    row.appendChild(el('div', { class: 'main' }, title, desc));

    var check = el('span', { class: 'group-check' + (on ? ' on' : ''), html: on ? ui.icon('check') : '' });
    row.appendChild(el('div', { class: 'side group-member-check' }, check));

    row.addEventListener('click', function (ev) {
      ev.preventDefault();
      toggle(c.id);
      var now = !!state.selected[c.id];
      row.classList.toggle('selected', now);
      check.classList.toggle('on', now);
      check.innerHTML = now ? UI().icon('check') : '';
    });
    return row;
  }

  /* ---------------- 提交 ---------------- */

  function setSaving(on) {
    state.saving = !!on;
    var btn = state.nodes.submit;
    if (!btn) return;
    btn.classList.toggle('loading', !!on);
    if (on) btn.setAttribute('disabled', 'disabled');
    else updateSummary();
  }

  function submit() {
    if (state.saving) return;
    var nameInput = state.nodes.nameInput;
    var name = String(nameInput ? nameInput.value : '').replace(/\s+/g, ' ').trim();
    var ids = selectedIds();

    if (!name) {
      toast('请先填写群聊名称', 'error');
      try { if (nameInput) nameInput.focus(); } catch (e) { /* 忽略 */ }
      return;
    }
    if (ids.length < 2) {
      toast('至少选择 2 位成员', 'error');
      return;
    }
    var G = Group();
    if (!G || typeof G.create !== 'function') {
      toast('群聊模块未加载，请重启应用', 'error');
      return;
    }

    setSaving(true);
    Promise.resolve(G.create({ name: name, characterIds: ids })).then(function (res) {
      if (state.destroyed) return null;
      if (!res || !res.session || !res.session.id) throw new Error('创建失败，请重试');
      state.saving = false;
      toast('群聊已创建', 'ok');
      // 先退出本页，再直接进入新建的群聊（与 PLAN §3 一致）
      try { App.Router.pop(); } catch (e) { console.error('[groupCreate] 返回失败', e); }
      var R = Router();
      var ret = null;
      try { ret = R.push('chat', { sessionId: res.session.id }); } catch (e2) { ret = null; }
      if (ret && typeof ret.catch === 'function') {
        ret.catch(function (err2) {
          console.error('[groupCreate] 打开群聊失败', err2);
          toast('群聊已创建，但打开失败：' + errText(err2), 'error');
        });
      }
      return null;
    }).catch(function (err) {
      if (state.destroyed) return null;
      setSaving(false);
      console.error('[groupCreate] 创建群聊失败', err);
      toast('创建群聊失败：' + errText(err), 'error');
      return null;
    });
  }

  /* ---------------- 注册 ---------------- */

  function build(root, params, page) {
    resetState(root, page);
    try { page.setTitle('新建群聊'); } catch (e) { /* 忽略 */ }

    // 从「创建角色」等二级页返回时重新读取角色列表（新角色要能选）；停留在本页时不动已有选择
    try {
      state.offChange = App.Router.onChange(function (cur) {
        if (state.destroyed) return;
        var name = (cur && cur.name) || '';
        var prev = state.lastRoute;
        state.lastRoute = name;
        if (name === 'groupCreate' && prev !== 'groupCreate' && !state.saving) load();
      });
    } catch (e) {
      state.offChange = null;
    }

    page.onDestroy(function () {
      state.destroyed = true;
      state.nodes = {};
      if (typeof state.offChange === 'function') {
        try { state.offChange(); } catch (e) { /* 忽略 */ }
        state.offChange = null;
      }
    });
    return load();
  }

  if (App.Router && typeof App.Router.register === 'function') {
    App.Router.register('groupCreate', {
      title: '新建群聊',
      tab: false,
      build: build
    });
  } else {
    console.warn('[groupCreate] Router 未就绪，页面注册失败');
  }
})();
