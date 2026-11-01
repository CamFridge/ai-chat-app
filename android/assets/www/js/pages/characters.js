/* ============================================================
 * pages/characters.js —— 角色管理（Tab 页）
 * 职责：
 *   1. 顶部「陪聊 / 助手」分段切换；
 *   2. 搜索、统计、空态引导；
 *   3. 列表行：头像 + 名称 + 一句话 + 世界观小标，点击开始聊天；
 *   4. 长按 / 「…」菜单：编辑、复制、删除（解绑会话但不删会话）、开始聊天；
 *   5. 右上角：世界观库入口 + 新建角色。
 *
 * 注意：Tab 页的 build 只会执行一次（Router 永久缓存），
 * 所以数据刷新靠 App.CharKit.onData 事件 + Router.onChange 重新激活。
 * ============================================================ */
(function () {
  'use strict';

  var UI = App.UI;
  var U = App.Util;
  var DB = App.DB;
  var Kit = App.CharKit;

  var PAGE = 'characters';

  var state = {
    root: null,
    page: null,
    destroyed: false,
    active: false,
    type: 'companion',
    q: '',
    rows: [],
    counts: { companion: 0, assistant: 0 },
    segBox: null,
    statsBox: null,
    listBox: null,
    scrollBox: null,
    refreshToken: 0,
    starting: false,
    buildId: 0
  };

  /* ------------------------------------------------------------
   * 数据读取
   * ---------------------------------------------------------- */

  function refresh() {
    if (!state.listBox) return Promise.resolve();
    var token = ++state.refreshToken;
    return DB.all('characters').then(function (rows) {
      if (token !== state.refreshToken || state.destroyed) return;
      var list = (rows || []).slice();
      list.sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      state.rows = list;
      state.counts.companion = 0;
      state.counts.assistant = 0;
      list.forEach(function (ch) {
        if (ch && ch.type === 'assistant') state.counts.assistant++;
        else state.counts.companion++;
      });
      renderSeg();
      renderStats();
      renderList();
    }).catch(function (err) {
      console.error('[characters] 读取角色失败', err);
      if (state.destroyed) return;
      UI.clear(state.listBox);
      state.listBox.appendChild(UI.errorState({
        title: '角色加载失败',
        desc: (err && err.message) || '本地数据库读取异常，请重试。',
        actionText: '重试',
        onAction: function () { refresh(); }
      }));
    });
  }

  /* ------------------------------------------------------------
   * 渲染：分段 / 统计 / 列表
   * ---------------------------------------------------------- */

  function segNode(id, label, count) {
    var active = state.type === id;
    var node = UI.el('button', {
      class: 'seg' + (active ? ' active' : ''),
      type: 'button',
      attrs: { role: 'tab', 'aria-selected': active ? 'true' : 'false' }
    }, UI.el('span', { text: label }), UI.el('span', { class: 'ck-seg-count', text: String(count) }));
    node.addEventListener('click', function () {
      if (state.type === id) return;
      state.type = id;
      renderSeg();
      renderList();
    });
    return node;
  }

  function renderSeg() {
    if (!state.segBox) return;
    UI.clear(state.segBox);
    state.segBox.appendChild(segNode('companion', '陪聊', state.counts.companion));
    state.segBox.appendChild(segNode('assistant', '助手', state.counts.assistant));
  }

  function renderStats() {
    if (!state.statsBox) return;
    var total = state.rows.length;
    UI.clear(state.statsBox);
    if (!total) {
      state.statsBox.textContent = '还没有角色';
      return;
    }
    state.statsBox.textContent = '共 ' + total + ' 个角色 · 陪聊 ' + state.counts.companion +
      ' · 助手 ' + state.counts.assistant;
  }

  // 过滤：类型 + 关键词（名称 / 一句话 / 领域 / 专业 / 世界观名）
  function filteredRows() {
    var q = (state.q || '').trim().toLowerCase();
    return state.rows.filter(function (ch) {
      if (!ch) return false;
      if (state.type === 'assistant' ? ch.type !== 'assistant' : ch.type === 'assistant') return false;
      if (!q) return true;
      var hay = [
        ch.name || '',
        ch.personality || '',
        ch.habits || '',
        ch.background || '',
        ch.domain || '',
        (ch.specialty || []).join(' '),
        Kit.snapshotName(ch.worldviewSnapshot) || ''
      ].join('\n').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function renderList() {
    if (!state.listBox) return;
    UI.clear(state.listBox);

    // 完全没有角色：引导创建
    if (!state.rows.length) {
      state.listBox.appendChild(UI.empty({
        icon: 'character',
        title: '还没有角色',
        desc: '创建一个陪聊角色或领域助手，就能开始聊天了。',
        actionText: '＋ 新建角色',
        onAction: function () { createCharacter(state.type); }
      }));
      return;
    }

    var rows = filteredRows();

    // 有角色但当前筛选无结果
    if (!rows.length) {
      var tip = state.q
        ? '没有匹配「' + state.q + '」的角色，换个关键词试试。'
        : (state.type === 'assistant' ? '还没有领域助手，点右上角「＋新建角色」创建一个。' : '还没有陪聊角色，点右上角「＋新建角色」创建一个。');
      state.listBox.appendChild(UI.empty({
        icon: 'search',
        title: state.q ? '没有匹配的角色' : '这里还是空的',
        desc: tip,
        actionText: state.q ? null : '＋ 新建角色',
        onAction: state.q ? null : function () { createCharacter(state.type); }
      }));
      return;
    }

    var list = UI.el('div', { class: 'list' });
    rows.forEach(function (ch) {
      list.appendChild(rowNode(ch));
    });
    state.listBox.appendChild(list);

    var foot = UI.el('div', { class: 'ck-note', text: '长按角色可编辑、复制或删除。' });
    state.listBox.appendChild(foot);
  }

  function rowNode(ch) {
    var summary = Kit.charSummary(ch) || '还没有描述';
    var wvName = Kit.snapshotName(ch.worldviewSnapshot) || '';

    var cell = UI.el('div', {
      class: 'cell',
      attrs: { role: 'button', tabindex: '0' }
    },
      UI.avatar(ch.name || '角', ch.avatar, 'md'),
      UI.el('div', { class: 'main ck-list-main' },
        UI.el('div', { class: 'title ellipsis', text: ch.name || '未命名角色' }),
        UI.el('div', { class: 'sub ck-sub-line' },
          UI.el('span', { class: 'ck-sub-text ellipsis', text: summary }),
          wvName ? UI.el('span', { class: 'ck-wv-mini', text: wvName }) : null
        )
      ),
      UI.el('div', { class: 'side row gap-8' },
        UI.el('span', { class: 'chev', html: UI.icon('chev', 17) }),
        moreButton(ch)
      )
    );

    bindTap(cell, function () { startChat(ch); }, function () { openMenu(ch); });
    return cell;
  }

  // 「…」按钮
  function moreButton(ch) {
    var btn = UI.el('button', {
      class: 'ck-more',
      type: 'button',
      attrs: { 'aria-label': '更多操作' },
      html: UI.icon('more', 20)
    });
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openMenu(ch);
    });
    return btn;
  }

  /**
   * 绑定「点击」与「长按」两种手势。
   * @param {Element} node
   * @param {Function} onTap
   * @param {Function} onLongPress
   */
  function bindTap(node, onTap, onLongPress) {
    var timer = null;
    var longFired = false;

    function cancelTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    node.addEventListener('touchstart', function () {
      longFired = false;
      cancelTimer();
      timer = setTimeout(function () {
        longFired = true;
        if (typeof onLongPress === 'function') onLongPress();
      }, 550);
    }, { passive: true });

    node.addEventListener('touchend', cancelTimer, { passive: true });
    node.addEventListener('touchmove', cancelTimer, { passive: true });
    node.addEventListener('touchcancel', cancelTimer, { passive: true });

    node.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      cancelTimer();
      longFired = true;
      if (typeof onLongPress === 'function') onLongPress();
    });

    node.addEventListener('click', function (ev) {
      if (ev) ev.preventDefault();
      cancelTimer();
      if (longFired) {
        longFired = false;
        return;
      }
      if (typeof onTap === 'function') onTap();
    });
  }

  /* ------------------------------------------------------------
   * 操作：菜单 / 开始聊天 / 复制 / 删除 / 新建 / 编辑 / 世界观库
   * ---------------------------------------------------------- */

  function openMenu(ch) {
    return UI.sheet({
      title: ch.name || '角色操作',
      items: [
        { id: 'chat', label: '开始聊天', icon: 'chat' },
        { id: 'edit', label: '编辑角色', icon: 'edit' },
        { id: 'copy', label: '复制角色', icon: 'copy' },
        { id: 'delete', label: '删除角色', icon: 'delete', danger: true }
      ]
    }).then(function (item) {
      if (!item) return null;
      if (item.id === 'chat') return startChat(ch);
      if (item.id === 'edit') return editCharacter(ch);
      if (item.id === 'copy') return copyCharacter(ch);
      if (item.id === 'delete') return deleteCharacter(ch);
      return null;
    }).catch(function (err) {
      console.error('[characters] 操作失败', err);
      UI.toast('操作失败：' + ((err && err.message) || '未知错误'), 'error');
      return null;
    });
  }

  function startChat(ch) {
    if (state.starting) return Promise.resolve(null);
    state.starting = true;
    return Kit.startChat(ch).catch(function (err) {
      console.error('[characters] 开始聊天失败', err);
      UI.toast('开始聊天失败', 'error');
      return null;
    }).then(function (res) {
      state.starting = false;
      return res;
    });
  }

  function editCharacter(ch) {
    return App.Router.push('characterEdit', { id: ch.id }).catch(function (err) {
      console.error('[characters] 打开编辑页失败', err);
      UI.toast('打开编辑页失败', 'error');
    });
  }

  function copyCharacter(ch) {
    var now = Kit.now();
    var copy = Kit.clone(ch) || {};
    copy.id = U.uid('char');
    copy.name = (ch.name || '角色') + ' 副本';
    copy.createdAt = now;
    copy.updatedAt = now;
    return DB.put('characters', copy).then(function (saved) {
      UI.toast('已复制为「' + (saved.name || copy.name) + '」', 'ok');
      Kit.notifyData('characters');
      return refresh();
    }).catch(function (err) {
      console.error('[characters] 复制角色失败', err);
      UI.toast('复制失败：' + ((err && err.message) || '未知错误'), 'error');
      return null;
    });
  }

  function deleteCharacter(ch) {
    return UI.confirm({
      title: '删除角色',
      message: '确定删除「' + (ch.name || '该角色') + '」吗？\n关联的聊天会话会保留，但会解除与该角色的绑定。',
      okText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return null;
      return DB.del('characters', ch.id).then(function () {
        // 只解除绑定，不删会话
        return DB.byIndex('sessions', 'characterId', ch.id).catch(function (e) {
          console.error('[characters] 查询关联会话失败', e);
          return [];
        }).then(function (rows) {
          var list = (rows || []).filter(function (s) { return s && s.characterId === ch.id; });
          if (!list.length) return [];
          return Promise.all(list.map(function (s) {
            var patch = Kit.clone(s) || {};
            patch.characterId = '';
            patch.updatedAt = Kit.now();
            return DB.put('sessions', patch);
          }));
        });
      }).then(function () {
        UI.toast('已删除角色，关联会话已保留', 'ok');
        Kit.notifyData('characters');
        return refresh();
      }).catch(function (err) {
        console.error('[characters] 删除角色失败', err);
        UI.toast('删除失败：' + ((err && err.message) || '未知错误'), 'error');
        return null;
      });
    }).catch(function (err) {
      console.error('[characters] 删除确认异常', err);
      return null;
    });
  }

  function createCharacter(type) {
    return App.Router.push('characterCreate', { type: type || state.type }).catch(function (err) {
      console.error('[characters] 打开创建向导失败', err);
      UI.toast('打开创建向导失败', 'error');
    });
  }

  function goWorldviews() {
    return App.Router.push('worldviews', {}).catch(function (err) {
      console.error('[characters] 打开世界观库失败', err);
      UI.toast('打开世界观库失败', 'error');
    });
  }

  /* ------------------------------------------------------------
   * 页面骨架
   * ---------------------------------------------------------- */

  function buildShell(root, page) {
    root.classList.add('page-characters');

    var searchInput = UI.el('input', {
      class: 'input',
      attrs: {
        type: 'search',
        placeholder: '搜索角色名称或描述',
        'aria-label': '搜索角色',
        autocomplete: 'off'
      }
    });
    searchInput.addEventListener('input', U.debounce(function () {
      state.q = String(searchInput.value || '').trim();
      renderList();
    }, 200));

    var searchBar = UI.el('div', { class: 'search-bar' },
      UI.el('span', { class: 'muted', html: UI.icon('search', 18) }),
      searchInput
    );

    state.segBox = UI.el('div', { class: 'segmented', attrs: { role: 'tablist' } });
    state.statsBox = UI.el('div', { class: 'ck-stats' });
    state.listBox = UI.el('div', { class: 'ck-char-list' });
    state.scrollBox = UI.el('div', { class: 'page-scroll' },
      searchBar,
      state.segBox,
      state.statsBox,
      state.listBox
    );

    root.appendChild(state.scrollBox);

    // 引导气泡上下文（不注入任何 Key / 正文）
    page.guide({
      pageId: PAGE,
      title: '角色管理',
      stage: 'list',
      totalSteps: 1,
      filledFields: {},
      missingFields: []
    });
  }

  /* ------------------------------------------------------------
   * 页面注册
   * ---------------------------------------------------------- */

  App.Router.register(PAGE, {
    tab: true,
    title: '角色管理',
    tabLabel: '角色',
    tabIcon: 'character',

    build: function (root, params, page) {
      state.root = root;
      state.page = page;
      state.destroyed = false;
      state.active = true;
      state.buildId = (state.buildId || 0) + 1;
      var myBuild = state.buildId;
      state.type = (params && (params.type === 'assistant' || params.type === 'companion'))
        ? params.type
        : 'companion';

      buildShell(root, page);

      page.setActions([
        { icon: 'world', label: '世界观库', onClick: goWorldviews },
        { icon: 'plus', label: '新建角色', onClick: function () { createCharacter(state.type); } }
      ]);

      // 内置预设兜底（main.js 可能没调用；失败不影响页面）
      if (App.Data && typeof App.Data.ensureBuiltinPresets === 'function') {
        try {
          var p = App.Data.ensureBuiltinPresets();
          if (p && typeof p.catch === 'function') {
            p.catch(function (e) { console.warn('[characters] 内置预设初始化失败', e); });
          }
        } catch (e) {
          console.warn('[characters] 内置预设初始化异常', e);
        }
      }

      // 数据变更（其他页面创建 / 编辑 / 删除角色后）
      var offData = Kit.onData(function (table) {
        if (state.destroyed || state.buildId !== myBuild) return;
        if (!state.active) return;
        if (table === 'characters' || table === 'sessions' || !table) refresh();
      });

      // 二级页返回 / Tab 切回时刷新（Tab 页 build 只执行一次）
      var offRouter = null;
      if (App.Router.onChange) {
        offRouter = App.Router.onChange(function (cur) {
          if (state.destroyed || state.buildId !== myBuild || !cur) return;
          var isThis = cur.name === PAGE;
          var wasActive = state.active;
          state.active = isThis;
          if (isThis && !wasActive) {
            refresh();
            if (page && page.guide) page.guide({
              pageId: PAGE,
              title: '角色管理',
              stage: 'list',
              totalSteps: 1,
              filledFields: {},
              missingFields: []
            });
          }
        });
      }

      page.onDestroy(function () {
        state.destroyed = true;
        state.active = false;
        if (typeof offData === 'function') offData();
        if (typeof offRouter === 'function') offRouter();
      });

      return refresh();
    }
  });
})();
