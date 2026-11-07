/* pages/group-manage.js —— 群聊设置页（v1.4.0 §3，路由名 groupManage，参数 {sessionId}）
 * 支持：改群名、添加成员（从未入群角色里选）、移除成员（至少保留 2 人）、解散群聊。
 * 依赖：App.UI / App.DB / App.Util / App.Router / App.Group
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
    try { UI().toast(text, type || 'info'); } catch (e) { console.warn('[groupManage]', text); }
  }

  function errText(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    return err.message || String(err);
  }

  var MIN = 2;

  var state = {
    root: null,
    page: null,
    sessionId: '',
    session: null,
    group: null,
    members: [],
    memberIds: {},
    chars: [],
    loading: true,
    error: null,
    busy: false,
    destroyed: false
  };

  /* ---------------- 数据 ---------------- */

  function load() {
    var D = DB();
    if (!D || typeof D.get !== 'function') {
      state.loading = false;
      state.error = new Error('数据层未就绪，请重启应用');
      render();
      return Promise.resolve();
    }
    if (!state.sessionId) {
      state.loading = false;
      state.error = new Error('缺少会话参数');
      render();
      return Promise.resolve();
    }
    state.loading = true;
    state.error = null;
    return Promise.resolve(D.get('sessions', state.sessionId)).then(function (s) {
      if (state.destroyed) return null;
      if (!s) throw new Error('会话不存在或已被删除');
      if (s.kind !== 'group') throw new Error('这不是群聊会话');
      state.session = s;
      var G = Group();
      var groupP = (G && typeof G.groupOf === 'function') ? G.groupOf(s) : Promise.resolve(null);
      var membersP = (G && typeof G.membersOf === 'function') ? G.membersOf(s) : Promise.resolve([]);
      var charsP = Promise.resolve(D.all('characters')).catch(function () { return []; });
      return Promise.all([groupP, membersP, charsP]).then(function (arr) {
        if (state.destroyed) return null;
        state.group = arr[0] || null;
        setMembers(arr[1]);
        state.chars = (Array.isArray(arr[2]) ? arr[2] : []).filter(function (c) {
          return c && c.id && !c.hidden;
        });
        state.loading = false;
        render();
        return null;
      });
    }).catch(function (err) {
      if (state.destroyed) return null;
      console.error('[groupManage] 加载群聊失败', err);
      state.loading = false;
      state.error = err;
      render();
      return null;
    });
  }

  function setMembers(list) {
    var members = (Array.isArray(list) ? list : []).filter(function (m) { return m && m.id; });
    state.members = members;
    state.memberIds = {};
    members.forEach(function (m) { state.memberIds[m.id] = true; });
  }

  function reloadMembers() {
    var G = Group();
    if (!G || typeof G.membersOf !== 'function' || !state.session) {
      setMembers([]);
      return Promise.resolve();
    }
    return Promise.resolve(G.membersOf(state.session)).then(function (list) {
      setMembers(list);
      return null;
    }).catch(function (err) {
      console.error('[groupManage] 重新读取成员失败', err);
      return null;
    });
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    if (!state.root || state.destroyed) return;
    var ui = UI();
    ui.clear(state.root);
    state.root.classList.add('group-manage-page');

    if (state.loading) {
      var box = el('div', { class: 'group-status' });
      state.root.appendChild(box);
      try { ui.loading(box, '正在读取群聊…'); } catch (e) { box.appendChild(el('div', { class: 'loading', text: '正在读取群聊…' })); }
      return;
    }

    if (state.error) {
      state.root.appendChild(ui.errorState({
        title: '群聊加载失败',
        desc: errText(state.error),
        actionText: '返回聊天列表',
        onAction: goChatList
      }));
      return;
    }

    if (!state.session) {
      state.root.appendChild(ui.errorState({
        title: '群聊不存在',
        desc: '这个群聊可能已经被删除了。',
        actionText: '返回聊天列表',
        onAction: goChatList
      }));
      return;
    }

    var scroll = el('div', { class: 'page-scroll group-manage-scroll' });
    scroll.appendChild(nameCard());
    scroll.appendChild(memberSection());
    scroll.appendChild(dangerSection());
    state.root.appendChild(scroll);
    state.root.appendChild(actionsBar());
    updateActions();
  }

  function nameCard() {
    var title = state.session ? (state.session.title || '群聊') : '群聊';
    var input = el('input', {
      class: 'input group-name-input',
      attrs: { type: 'text', maxlength: '30', placeholder: '群聊名称', 'aria-label': '群聊名称' },
      value: title
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); saveName(); }
    });
    input.addEventListener('input', updateActions);
    state.nameInput = input;
    return el('div', { class: 'form group-manage-form' },
      el('div', { class: 'field group-name-field' },
        el('label', { text: '群聊名称' }),
        input,
        el('div', { class: 'hint group-name-hint', text: '改完点下方「保存群名」；群名也会同步到聊天列表。' })
      )
    );
  }

  function memberSection() {
    var section = el('div', { class: 'group-section' });
    var addBtn = el('button', {
      class: 'btn ghost small group-add-btn',
      attrs: { type: 'button', 'aria-label': '添加成员' },
      text: '添加成员'
    });
    addBtn.addEventListener('click', openAddPicker);
    if (state.busy) addBtn.setAttribute('disabled', 'disabled');

    section.appendChild(el('div', { class: 'group-section-head' },
      el('div', { class: 'group-section-title', text: '群成员 · ' + state.members.length + ' 人' }),
      addBtn
    ));

    var list = el('div', { class: 'list group-member-list group-manage-member-list' });
    if (!state.members.length) {
      list.appendChild(el('div', { class: 'group-member-none', text: '群成员加载失败或角色已被删除' }));
    } else {
      state.members.forEach(function (m) { list.appendChild(memberRow(m)); });
    }
    section.appendChild(list);
    section.appendChild(el('div', {
      class: 'hint group-member-tip',
      text: '群聊至少保留 ' + MIN + ' 位成员；移除后该成员不再参与群聊发言。'
    }));
    return section;
  }

  function typeText(c) { return c && c.type === 'assistant' ? '助手' : '陪聊'; }

  function memberRow(m) {
    var ui = UI();
    var c = m.character || {};
    var row = el('div', { class: 'cell group-member-item group-manage-member', dataset: { id: m.id } });
    row.appendChild(ui.avatar(m.name || c.name || '角色', m.avatar || c.avatar, 'md'));

    var title = el('div', { class: 'title group-member-name' },
      el('span', { class: 'ellipsis', text: m.name || '未命名角色' }),
      el('span', { class: 'type-tag group-type-tag ' + (c.type === 'assistant' ? 'assistant' : 'companion'), text: typeText(c) })
    );
    var desc = el('div', {
      class: 'sub group-member-desc ellipsis',
      text: String(c.personality || c.description || '暂无角色简介').replace(/\s+/g, ' ').trim()
    });
    row.appendChild(el('div', { class: 'main' }, title, desc));

    var canRemove = state.members.length > MIN && !state.busy;
    var removeBtn = el('button', {
      class: 'btn ghost small group-remove-btn',
      attrs: { type: 'button', 'aria-label': '移除成员' },
      text: '移除'
    });
    if (!canRemove) {
      removeBtn.setAttribute('disabled', 'disabled');
      if (state.members.length <= MIN) removeBtn.setAttribute('title', '至少保留 ' + MIN + ' 位成员');
    }
    removeBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      removeFlow(m);
    });
    row.appendChild(el('div', { class: 'side group-member-check' }, removeBtn));
    return row;
  }

  function dangerSection() {
    var btn = el('button', {
      class: 'btn danger block group-dissolve-btn',
      attrs: { type: 'button' },
      text: '解散群聊'
    });
    btn.addEventListener('click', dissolveFlow);
    if (state.busy) btn.setAttribute('disabled', 'disabled');
    return el('div', { class: 'group-danger-zone' },
      el('div', { class: 'group-danger-title', text: '危险操作' }),
      el('div', { class: 'hint group-danger-hint', text: '解散后会删除这个群聊的群记录与全部聊天消息，且无法恢复。' }),
      btn
    );
  }

  function actionsBar() {
    var btn = el('button', { class: 'btn primary block group-save-name', attrs: { type: 'button' }, text: '保存群名' });
    btn.addEventListener('click', saveName);
    if (state.busy) btn.setAttribute('disabled', 'disabled');
    state.saveBtn = btn;
    return el('div', { class: 'page-actions group-manage-actions' }, btn);
  }

  function updateActions() {
    var btn = state.saveBtn;
    if (!btn || !state.session) return;
    var cur = String(state.nameInput ? state.nameInput.value : '').replace(/\s+/g, ' ').trim();
    var title = String(state.session.title || '').trim();
    if (state.busy || !cur || cur === title) btn.setAttribute('disabled', 'disabled');
    else btn.removeAttribute('disabled');
  }

  /* ---------------- 操作 ---------------- */

  function goChatList() {
    var R = Router();
    try {
      if (R && typeof R.goChatList === 'function') { R.goChatList(); return; }
      if (R && typeof R.pop === 'function') { R.pop(); return; }
    } catch (e) {
      console.error('[groupManage] 返回聊天列表失败', e);
    }
  }

  function setBusy(on) {
    state.busy = !!on;
    render();
  }

  function saveName() {
    if (state.busy) return;
    var G = Group();
    if (!G || typeof G.rename !== 'function') { toast('群聊模块未加载，请重启应用', 'error'); return; }
    var next = String(state.nameInput ? state.nameInput.value : '').replace(/\s+/g, ' ').trim();
    if (!next) { toast('群名不能为空', 'error'); return; }
    if (next === String(state.session && state.session.title || '').trim()) {
      toast('群名没有变化');
      return;
    }
    setBusy(true);
    Promise.resolve(G.rename(state.session, next)).then(function (s) {
      if (state.destroyed) return null;
      if (s) state.session = s;
      state.busy = false;
      render();
      toast('群名已保存', 'ok');
      return null;
    }).catch(function (err) {
      if (state.destroyed) return null;
      state.busy = false;
      render();
      console.error('[groupManage] 保存群名失败', err);
      toast('保存失败：' + errText(err), 'error');
      return null;
    });
  }

  function removeFlow(m) {
    if (state.busy || !m) return;
    if (state.members.length <= MIN) {
      toast('群聊至少需要 ' + MIN + ' 位成员，不能再减少', 'error');
      return;
    }
    var name = m.name || '这位成员';
    Promise.resolve(UI().confirm({
      title: '移除成员',
      message: '把「' + name + '」移出这个群聊？移除后他/她不再参与群聊发言。',
      okText: '移除',
      danger: true
    })).then(function (ok) {
      if (!ok || state.destroyed) return null;
      return doRemove(m);
    }).catch(function (err) {
      console.error('[groupManage] 移除成员失败', err);
      toast('移除失败：' + errText(err), 'error');
      return null;
    });
  }

  function doRemove(m) {
    var G = Group();
    if (!G || typeof G.removeMember !== 'function') { toast('群聊模块未加载，请重启应用', 'error'); return Promise.resolve(); }
    setBusy(true);
    return Promise.resolve(G.removeMember(state.session, m.id)).then(function (s) {
      if (state.destroyed) return null;
      if (s) state.session = s;
      return reloadMembers();
    }).then(function () {
      if (state.destroyed) return null;
      state.busy = false;
      render();
      toast('已移除 ' + (m.name || '成员'), 'ok');
      return null;
    }).catch(function (err) {
      if (state.destroyed) return null;
      state.busy = false;
      render();
      console.error('[groupManage] 移除成员失败', err);
      toast('移除失败：' + errText(err), 'error');
      return null;
    });
  }

  function openAddPicker() {
    if (state.busy) return;
    var ui = UI();
    var G = Group();
    if (!G || typeof G.addMembers !== 'function') { toast('群聊模块未加载，请重启应用', 'error'); return; }

    var candidates = state.chars.filter(function (c) { return c && c.id && !state.memberIds[c.id]; });
    if (!candidates.length) {
      toast('没有可添加的角色了，先去创建更多角色吧');
      return;
    }

    var picked = {};
    var order = [];

    var searchInput = el('input', {
      class: 'group-picker-search',
      attrs: { type: 'search', placeholder: '搜索角色名 / 性格 / 类型', 'aria-label': '搜索角色' }
    });
    var listWrap = el('div', { class: 'list group-picker-list' });
    var countEl = el('div', { class: 'hint group-picker-hint', text: '单选或多选都可以，添加后立即生效。' });

    function pickedIds() { return order.slice(); }

    function updateCount() {
      var n = order.length;
      countEl.textContent = n ? ('已选 ' + n + ' 位成员') : '单选或多选都可以，添加后立即生效。';
    }

    function hayOf(c) {
      var t = String(c.type || '');
      return [c.name, c.personality, c.description, t === 'assistant' ? '助手' : '陪聊', t].join(' ').toLowerCase();
    }

    function rowOf(c) {
      var on = !!picked[c.id];
      var row = el('div', { class: 'cell group-picker-item' + (on ? ' selected' : ''), dataset: { id: c.id } });
      row.appendChild(ui.avatar(c.name || '角色', c.avatar, 'sm'));
      row.appendChild(el('div', { class: 'main' },
        el('div', { class: 'title group-picker-name ellipsis', text: c.name || '未命名角色' }),
        el('div', {
          class: 'sub group-picker-desc ellipsis',
          text: String(c.personality || c.description || '暂无角色简介').replace(/\s+/g, ' ').trim()
        })
      ));
      var check = el('span', { class: 'group-check' + (on ? ' on' : ''), html: on ? ui.icon('check') : '' });
      row.appendChild(el('div', { class: 'side group-picker-check' }, check));
      row.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (picked[c.id]) {
          delete picked[c.id];
          var at = order.indexOf(c.id);
          if (at >= 0) order.splice(at, 1);
        } else {
          picked[c.id] = true;
          order.push(c.id);
        }
        var now = !!picked[c.id];
        row.classList.toggle('selected', now);
        check.classList.toggle('on', now);
        check.innerHTML = now ? ui.icon('check') : '';
        updateCount();
      });
      return row;
    }

    function renderPicker() {
      var q = String(searchInput.value || '').trim().toLowerCase();
      var list = candidates.filter(function (c) {
        if (!q) return true;
        if (picked[c.id]) return true;
        return hayOf(c).indexOf(q) >= 0;
      });
      ui.clear(listWrap);
      if (!list.length) {
        listWrap.appendChild(el('div', { class: 'group-picker-none', text: '没有匹配的角色' }));
        return;
      }
      var frag = ui.frag();
      list.forEach(function (c) { frag.appendChild(rowOf(c)); });
      listWrap.appendChild(frag);
    }

    var debounced = null;
    try { if (typeof U().debounce === 'function') debounced = U().debounce(renderPicker, 120); } catch (e) { debounced = null; }
    searchInput.addEventListener('input', debounced || renderPicker);

    var body = el('div', { class: 'group-picker' },
      el('div', { class: 'search-bar group-picker-search-bar' },
        el('span', { class: 'search-icon', html: ui.icon('search') }),
        searchInput
      ),
      listWrap,
      countEl
    );
    renderPicker();
    updateCount();

    ui.modal({
      title: '添加群成员',
      content: body,
      dismissible: true,
      actions: [
        { text: '取消', class: 'ghost', onClick: function (close) { close(); } },
        {
          text: '添加',
          class: 'primary',
          onClick: function (close) {
            var ids = pickedIds();
            if (!ids.length) { toast('请至少选择 1 位角色', 'error'); return; }
            close();
            doAdd(ids);
          }
        }
      ]
    });
  }

  function doAdd(ids) {
    var G = Group();
    if (!G || typeof G.addMembers !== 'function') { toast('群聊模块未加载，请重启应用', 'error'); return; }
    setBusy(true);
    Promise.resolve(G.addMembers(state.session, ids)).then(function (s) {
      if (state.destroyed) return null;
      if (s) state.session = s;
      return reloadMembers();
    }).then(function () {
      if (state.destroyed) return null;
      state.busy = false;
      render();
      toast('已添加 ' + ids.length + ' 位成员', 'ok');
      return null;
    }).catch(function (err) {
      if (state.destroyed) return null;
      state.busy = false;
      render();
      console.error('[groupManage] 添加成员失败', err);
      toast('添加失败：' + errText(err), 'error');
      return null;
    });
  }

  function dissolveFlow() {
    if (state.busy) return;
    var G = Group();
    if (!G || typeof G.dissolve !== 'function') { toast('群聊模块未加载，请重启应用', 'error'); return; }
    var title = (state.session && state.session.title) || '这个群聊';
    Promise.resolve(UI().confirm({
      title: '解散群聊',
      message: '解散「' + title + '」后，群记录和全部聊天消息都会被删除，且无法恢复。确定解散吗？',
      okText: '解散',
      danger: true
    })).then(function (ok) {
      if (!ok || state.destroyed) return null;
      setBusy(true);
      return Promise.resolve(G.dissolve(state.session)).then(function () {
        if (state.destroyed) return null;
        state.busy = false;
        toast('群聊已解散', 'ok');
        goChatList();
        return null;
      }).catch(function (err) {
        if (state.destroyed) return null;
        state.busy = false;
        render();
        console.error('[groupManage] 解散群聊失败', err);
        toast('解散失败：' + errText(err), 'error');
        return null;
      });
    }).catch(function (err) {
      console.error('[groupManage] 解散流程出错', err);
      toast('操作失败：' + errText(err), 'error');
      return null;
    });
  }

  /* ---------------- 注册 ---------------- */

  function build(root, params, page) {
    state.root = root;
    state.page = page;
    state.sessionId = String((params && params.sessionId) || '');
    state.session = null;
    state.group = null;
    state.members = [];
    state.memberIds = {};
    state.chars = [];
    state.loading = true;
    state.error = null;
    state.busy = false;
    state.destroyed = false;
    state.nameInput = null;
    state.saveBtn = null;

    try { page.setTitle('群成员'); } catch (e) { /* 忽略 */ }
    page.onDestroy(function () {
      state.destroyed = true;
      state.nameInput = null;
      state.saveBtn = null;
    });
    return load();
  }

  if (App.Router && typeof App.Router.register === 'function') {
    App.Router.register('groupManage', {
      title: '群成员',
      tab: false,
      build: build
    });
  } else {
    console.warn('[groupManage] Router 未就绪，页面注册失败');
  }
})();
