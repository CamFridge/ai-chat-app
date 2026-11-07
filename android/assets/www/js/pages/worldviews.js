/* ============================================================
 * pages/worldviews.js —— 世界观库（二级页）
 *
 * 功能：
 *   - 列表：7 个内置世界观（只读，可「复制并自定义」）+ 用户自定义（可编辑 / 删除）；
 *   - 新建自定义世界观：名称 + 粗略描述 → 引导 API 补全 → 预览可逐项修改 → 保存；
 *   - 「让 API 改」反复调整（固定使用引导 API）；
 *   - 引导 API 不可用时不阻断：可手动填写完整设定并保存（标记为草稿）；
 *   - 草稿持久化 settings.draft_worldview。
 * ============================================================ */
(function () {
  'use strict';

  var UI = App.UI;
  var U = App.Util;
  var DB = App.DB;
  var Kit = App.CharKit;
  var P = App.Prompts;

  var PAGE = 'worldviews';
  var DRAFT_KEY = 'draft_worldview';

  var st = {
    root: null,
    page: null,
    destroyed: false,
    loading: true,
    presets: [],
    users: [],
    providers: [],
    mode: 'list',
    work: null,
    busy: false,
    progress: null,
    progressSlot: null,
    stopAnim: null,
    saveTimer: null,
    lastRewrite: null,
    genStartAt: 0,
    genChars: 0,
    genPhase: 'idle',
    genAttempt: 1,
    genLive: '',
    genTimer: null,
    genRaf: null,
    genEls: null,
    genFollow: true
  };

  /* ------------------------------------------------------------
   * 小工具
   * ---------------------------------------------------------- */

  function detailFields() {
    return (App.Data && App.Data.WORLDVIEW_FIELDS) || [];
  }

  function blankDetails() {
    return {
      era: '',
      place: '',
      rules: '',
      society: '',
      taboos: '',
      elements: [],
      characterHints: ''
    };
  }

  function blankWork() {
    return {
      id: '',
      name: '',
      rawInput: '',
      summary: '',
      details: blankDetails(),
      fieldOrigin: {},
      raw: '',
      stage: 'input',
      isNew: true,
      aiFailed: false,
      aiError: null,
      createdAt: 0,
      updatedAt: 0
    };
  }

  function normalizeWork(raw) {
    var w = blankWork();
    if (!raw || typeof raw !== 'object') return w;
    w.id = raw.id || '';
    w.name = raw.name || '';
    w.rawInput = raw.rawInput || '';
    w.summary = raw.summary || '';
    var d = raw.details || {};
    w.details = {
      era: String(d.era || ''),
      place: String(d.place || ''),
      rules: String(d.rules || ''),
      society: String(d.society || ''),
      taboos: String(d.taboos || ''),
      elements: Array.isArray(d.elements) ? d.elements.filter(Boolean).map(String) : [],
      characterHints: String(d.characterHints || '')
    };
    w.fieldOrigin = raw.fieldOrigin && typeof raw.fieldOrigin === 'object' ? raw.fieldOrigin : {};
    w.raw = raw.raw || '';
    w.stage = raw.stage === 'preview' ? 'preview' : 'input';
    w.isNew = raw.isNew !== false;
    w.aiFailed = !!raw.aiFailed;
    w.aiError = raw.aiError || null;
    w.createdAt = raw.createdAt || 0;
    w.updatedAt = raw.updatedAt || 0;
    return w;
  }

  function hasAnyDetail(w) {
    if (!w) return false;
    if (String(w.summary || '').trim()) return true;
    var d = w.details || {};
    if ((d.elements || []).length) return true;
    return !!(d.era || d.place || d.rules || d.society || d.taboos || d.characterHints);
  }

  function detailText(w, key) {
    var d = (w && w.details) || {};
    if (key === 'elements') return (d.elements || []).join('、');
    return d[key] || '';
  }

  function currentText() {
    var w = st.work;
    if (!w) return '';
    var lines = ['名称：' + (w.name || ''), '摘要：' + (w.summary || '')];
    detailFields().forEach(function (f) {
      var v = f.key === 'elements'
        ? (w.details.elements || []).join('、')
        : (w.details[f.key] || '');
      lines.push(f.label + '：' + v);
    });
    return lines.join('\n');
  }

  /* ------------------------------------------------------------
   * 草稿持久化（settings.draft_worldview）
   * ---------------------------------------------------------- */

  function saveDraftSoon() {
    if (st.mode !== 'edit' || !st.work) return;
    if (st.saveTimer) clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(function () {
      st.saveTimer = null;
      saveDraftNow();
    }, 400);
  }

  function saveDraftNow() {
    if (!st.work) return;
    st.work.updatedAt = Kit.now();
    DB.settings.set(DRAFT_KEY, Kit.clone(st.work)).catch(function (err) {
      console.warn('[worldviews] 保存草稿失败', err);
    });
  }

  function clearDraft() {
    if (st.saveTimer) {
      clearTimeout(st.saveTimer);
      st.saveTimer = null;
    }
    DB.settings.del(DRAFT_KEY).catch(function (err) {
      console.warn('[worldviews] 清除草稿失败', err);
    });
  }

  /* ------------------------------------------------------------
   * 数据加载
   * ---------------------------------------------------------- */

  function reloadAll() {
    return Promise.all([Kit.loadWorldviews(), Kit.loadProviders()]).then(function (arr) {
      var wv = arr[0] || {};
      st.presets = wv.presets || [];
      st.users = wv.users || [];
      st.providers = arr[1] || [];
    }).catch(function (err) {
      console.warn('[worldviews] 读取世界观失败', err);
      UI.toast('读取世界观失败：' + ((err && err.message) || '未知错误'), 'error');
    });
  }

  /* ------------------------------------------------------------
   * 页头 / 页面动作 / 引导上下文
   * ---------------------------------------------------------- */

  function updateChrome() {
    if (!st.page) return;
    if (st.mode === 'edit') {
      st.page.setTitle(st.work && !st.work.isNew ? '编辑世界观' : '自定义世界观');
      st.page.setActions([{
        icon: 'close',
        label: '取消',
        onClick: function () { cancelEdit(); }
      }]);
    } else {
      st.page.setTitle('世界观库');
      st.page.setActions([{
        icon: 'plus',
        label: '自定义',
        onClick: function () { startCreate(); }
      }]);
    }
  }

  function updateGuide() {
    if (!st.page || typeof st.page.guide !== 'function') return;
    if (st.mode !== 'edit' || !st.work) {
      st.page.guide({
        pageId: PAGE,
        title: '世界观库',
        stage: 'list',
        totalSteps: 1,
        filledFields: {},
        missingFields: []
      });
      return;
    }
    var w = st.work;
    var filled = {};
    var missing = [];
    if (w.name) filled.name = true; else missing.push('name');
    if (w.rawInput) filled.rawInput = true;
    if (w.stage === 'preview') {
      if (!w.summary) missing.push('summary');
      detailFields().forEach(function (f) {
        if (f.key === 'elements' ? (w.details.elements || []).length : w.details[f.key]) {
          filled[f.key] = true;
        }
      });
    }
    st.page.guide({
      pageId: PAGE,
      title: '自定义世界观',
      stage: w.stage,
      totalSteps: 3,
      filledFields: filled,
      missingFields: missing
    });
  }

  /* ------------------------------------------------------------
   * 渲染入口
   * ---------------------------------------------------------- */

  function render() {
    if (!st.root || st.destroyed) return;
    UI.clear(st.root);
    if (st.loading) {
      var loading = UI.el('div', { class: 'loading' });
      loading.appendChild(UI.spinnerEl());
      loading.appendChild(UI.el('span', { text: '加载中…' }));
      st.root.appendChild(loading);
      return;
    }
    if (st.mode === 'edit' && st.work) {
      st.root.appendChild(buildEditor());
    } else {
      st.root.appendChild(buildList());
    }
    updateChrome();
    updateGuide();
  }

  /* ------------------------------------------------------------
   * 列表
   * ---------------------------------------------------------- */

  function buildList() {
    var wrap = UI.el('div', { class: 'ck-wizard' });
    var scroll = UI.el('div', { class: 'page-scroll' });

    scroll.appendChild(UI.el('div', {
      class: 'ck-note',
      text: '世界观是多个角色共享的设定。创建角色时可以选一个，也可以不选；角色会保存当时的快照，之后改世界观不影响已有角色。'
    }));

    // 内置
    scroll.appendChild(Kit.groupTitle('内置世界观（只读）'));
    var builtinList = UI.el('div', { class: 'list section' });
    st.presets.forEach(function (wv) {
      builtinList.appendChild(listRow(wv, '内置', function () { openBuiltin(wv); }));
    });
    scroll.appendChild(builtinList);

    // 自定义
    scroll.appendChild(Kit.groupTitle('我的世界观'));
    if (!st.users.length) {
      scroll.appendChild(UI.el('div', { class: 'ck-empty-wrap' },
        UI.empty({
          icon: 'world',
          title: '还没有自定义世界观',
          desc: '写一句粗略描述，AI 会帮你补全成一整套设定；也可以手动填写。',
          actionText: '＋ 新建世界观',
          onAction: function () { startCreate(); }
        })
      ));
    } else {
      var userList = UI.el('div', { class: 'list section' });
      st.users.forEach(function (wv) {
        userList.appendChild(listRow(wv, wv.draft ? '草稿' : '自定义', function () { openUser(wv); }));
      });
      scroll.appendChild(userList);
    }

    scroll.appendChild(UI.el('div', {
      class: 'ck-note',
      text: '内置世界观只读，可「复制并自定义」后修改；自定义世界观可以随时编辑或删除。'
    }));

    wrap.appendChild(scroll);
    return wrap;
  }

  function listRow(wv, badgeText, onClick) {
    var row = UI.el('div', { class: 'cell', attrs: { role: 'button', tabindex: '0' } },
      UI.el('div', { class: 'main' },
        UI.el('div', { class: 'title' },
          UI.el('span', { text: wv.name || '未命名世界观' }),
          UI.el('span', { class: 'badge ' + (badgeText === '内置' ? 'gray' : 'green'), text: badgeText })
        ),
        UI.el('div', { class: 'sub ellipsis', text: wv.summary || '暂无摘要' })
      ),
      UI.el('span', { class: 'chev', html: UI.icon('chev', 17) })
    );
    row.addEventListener('click', onClick);
    return row;
  }

  function detailNode(wv) {
    var box = UI.el('div');
    box.appendChild(UI.el('div', { class: 'ck-wv-summary', text: wv.summary || '暂无摘要' }));
    var list = UI.el('div', { class: 'ck-wv-detail-list' });
    detailFields().forEach(function (f) {
      var value = detailText(wv, f.key);
      list.appendChild(UI.el('div', { class: 'ck-wv-detail-item' },
        UI.el('div', { class: 'ck-wv-detail-label', text: f.label }),
        UI.el('div', { class: 'ck-wv-detail-value' + (value ? '' : ' ck-empty'), text: value || '未填写' })
      ));
    });
    box.appendChild(list);

    // 世界书（v1.4.0）：按这个世界观，为某个角色生成触发式设定条目
    var loreActions = UI.el('div', { class: 'lorebook-detail-actions' });
    var loreBtn = UI.el('button', {
      class: 'btn outline small',
      attrs: { type: 'button', text: '生成世界书条目' }
    });
    loreBtn.addEventListener('click', function () {
      if (UI.closeTopOverlay) UI.closeTopOverlay();
      genLorebookFor(wv);
    });
    loreActions.appendChild(loreBtn);
    box.appendChild(loreActions);

    return box;
  }

  // 生成世界书条目：挑一个角色（优先使用该世界观的角色）→ 进入 AI 生成页
  function genLorebookFor(wv) {
    if (!App.Lorebook) {
      UI.toast('世界书模块未加载', 'error');
      return Promise.resolve(null);
    }
    var wvId = wv && wv.id ? wv.id : '';
    return DB.all('characters').then(function (list) {
      var chars = (Array.isArray(list) ? list : []).filter(function (ch) { return ch && ch.id; });
      var bound = chars.filter(function (ch) { return wvId && ch.worldviewId === wvId; });
      var pool = bound.length ? bound : chars;
      if (!pool.length) {
        UI.toast('还没有角色，先创建一个角色再生成世界书条目');
        return null;
      }
      if (pool.length === 1) return pushLorebookGen(pool[0], wvId);
      var items = pool.map(function (ch) {
        return {
          id: ch.id,
          label: ch.name || '未命名角色',
          desc: bound.length ? '正在使用这个世界观' : '还没有绑定这个世界观，仍可按它的设定生成',
          icon: 'character'
        };
      });
      return UI.sheet({ title: '给哪个角色生成条目？', items: items }).then(function (item) {
        if (!item) return null;
        var picked = null;
        for (var i = 0; i < pool.length; i++) {
          if (pool[i].id === item.id) { picked = pool[i]; break; }
        }
        return picked ? pushLorebookGen(picked, wvId) : null;
      });
    }).catch(function (err) {
      console.error('[worldviews] 打开世界书生成失败', err);
      UI.toast('打不开生成页：' + ((err && err.message) || '未知错误'), 'error');
      return null;
    });
  }

  function pushLorebookGen(ch, wvId) {
    try {
      var params = { characterId: ch.id };
      if (wvId) params.worldviewId = wvId;
      return App.Router.push('lorebookGen', params);
    } catch (e) {
      UI.toast('打不开生成页：' + ((e && e.message) || '未知错误'), 'error');
      return null;
    }
  }

  function openBuiltin(wv) {
    var handle = UI.modal({
      title: wv.name || '世界观',
      content: detailNode(wv),
      actions: [
        {
          text: '复制并自定义',
          class: 'primary',
          onClick: function (close) {
            close();
            copyWorldview(wv);
          }
        },
        { text: '关闭', onClick: function (close) { close(); } }
      ]
    });
    return handle;
  }

  function openUser(wv) {
    return UI.sheet({
      title: wv.name || '世界观',
      items: [
        { id: 'detail', label: '查看设定', icon: 'world' },
        { id: 'edit', label: '编辑设定', icon: 'edit' },
        { id: 'copy', label: '复制', icon: 'copy' },
        { id: 'delete', label: '删除', icon: 'delete', danger: true }
      ]
    }).then(function (item) {
      if (!item) return null;
      if (item.id === 'detail') {
        UI.modal({
          title: wv.name || '世界观',
          content: detailNode(wv),
          actions: [{ text: '关闭', onClick: function (close) { close(); } }]
        });
        return null;
      }
      if (item.id === 'edit') return startEdit(wv);
      if (item.id === 'copy') return copyWorldview(wv);
      if (item.id === 'delete') return deleteWorldview(wv);
      return null;
    }).catch(function (err) {
      console.error('[worldviews] 操作失败', err);
      return null;
    });
  }

  function deleteWorldview(wv) {
    return UI.confirm({
      title: '删除世界观',
      message: '删除「' + (wv.name || '') + '」？\n已经使用它的角色不受影响（角色保存的是当时的设定快照）。',
      okText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return null;
      return DB.del('worldviews', wv.id).then(function () {
        st.users = st.users.filter(function (x) { return x.id !== wv.id; });
        Kit.notifyData('worldviews');
        UI.toast('已删除世界观', 'ok');
        render();
        return null;
      }).catch(function (err) {
        console.error('[worldviews] 删除失败', err);
        UI.toast('删除失败：' + ((err && err.message) || '未知错误'), 'error');
        return null;
      });
    });
  }

  /* ------------------------------------------------------------
   * 新建 / 编辑 / 复制
   * ---------------------------------------------------------- */

  function startCreate() {
    st.mode = 'edit';
    st.work = blankWork();
    st.busy = false;
    st.progress = null;
    clearDraft();
    render();
    focusSoon('ck-wv-name');
  }

  function startEdit(wv) {
    st.mode = 'edit';
    st.work = normalizeWork({
      id: wv.id,
      name: wv.name,
      rawInput: wv.rawInput || '',
      summary: wv.summary,
      details: wv.details,
      fieldOrigin: wv.fieldOrigin || {},
      stage: 'preview',
      isNew: false,
      aiFailed: !!wv.draft,
      createdAt: wv.createdAt,
      updatedAt: wv.updatedAt
    });
    st.busy = false;
    st.progress = null;
    render();
  }

  function copyWorldview(wv) {
    var copy = Kit.copyWorldview(wv);
    copy.summary = wv.summary || '';
    copy.details = Kit.clone(wv.details || blankDetails());
    copy.rawInput = wv.rawInput || '';
    copy.draft = false;
    copy.fieldOrigin = Kit.clone(wv.fieldOrigin || {});
    copy.createdAt = Kit.now();
    copy.updatedAt = copy.createdAt;

    return DB.put('worldviews', copy).then(function (saved) {
      Kit.notifyData('worldviews');
      UI.toast('已复制，可接着自定义', 'ok');
      return reloadAll().then(function () {
        if (!st.destroyed) render();
        startEdit(saved || copy);
        return null;
      });
    }).catch(function (err) {
      console.error('[worldviews] 复制失败', err);
      UI.toast('复制失败：' + ((err && err.message) || '未知错误'), 'error');
      return null;
    });
  }

  function cancelEdit() {
    var w = st.work;
    var dirty = !!(w && (w.name || w.rawInput || hasAnyDetail(w)));
    if (!dirty) {
      st.mode = 'list';
      st.work = null;
      clearDraft();
      render();
      return Promise.resolve(null);
    }
    return UI.confirm({
      title: '放弃这次编辑？',
      message: '当前填写的世界观内容还没有保存，放弃后会清空（已有的自定义世界观不受影响）。',
      okText: '放弃',
      danger: true
    }).then(function (ok) {
      if (!ok) return null;
      st.mode = 'list';
      st.work = null;
      st.busy = false;
      st.progress = null;
      clearDraft();
      render();
      return null;
    }).catch(function (err) {
      console.error('[worldviews] 取消编辑失败', err);
      return null;
    });
  }

  function focusSoon(id) {
    setTimeout(function () {
      try {
        var node = st.root && st.root.querySelector('#' + id);
        if (node && node.focus) node.focus();
      } catch (e) { /* 忽略 */ }
    }, 80);
  }

  /* ------------------------------------------------------------
   * 编辑器
   * ---------------------------------------------------------- */

  function buildEditor() {
    var wrap = UI.el('div', { class: 'ck-wizard' });
    var head = UI.el('div', { class: 'ck-wizard-head' });
    head.appendChild(Kit.progressDots(['描述设定', '补全并调整', '保存'], st.work.stage === 'input' ? 0 : 1));
    head.appendChild(UI.el('div', {
      class: 'ck-wizard-caption',
      text: st.work.stage === 'input'
        ? '第 1 / 3 步 · 名称与粗略描述'
        : '第 2 / 3 步 · 检查并修改设定'
    }));
    wrap.appendChild(head);

    var body = UI.el('div', { class: 'ck-wizard-body' });
    if (st.work.stage === 'input') buildInputStage(body);
    else buildPreviewStage(body);

    // 生成中：实时输出 + 真实计时
    if (st.busy) {
      body.appendChild(genLiveBox());
    } else if (st.work.aiError) {
      body.appendChild(renderAiError());
      if (st.work.raw) {
        body.appendChild(UI.el('div', { class: 'ck-raw-title', text: '模型原始输出（可参考手动填写）' }));
        body.appendChild(UI.el('div', { class: 'ck-raw-box', text: st.work.raw }));
      }
    }

    wrap.appendChild(body);
    wrap.appendChild(buildEditorFooter());
    return wrap;
  }

  /* ------------------------------------------------------------
   * 生成中：实时输出 / 真实计时 / 可停止
   * ---------------------------------------------------------- */

  function genLiveBox() {
    var box = UI.el('div', { class: 'ck-gen-live' });

    var status = UI.el('div', { class: 'ck-gen-status' });
    var statusText = UI.el('span', { class: 'ck-gen-status-text', text: '正在连接 API…' });
    var elapsed = UI.el('span', { class: 'ck-gen-elapsed', text: '0.0s' });
    status.appendChild(UI.el('span', { class: 'ck-gen-dot' }));
    status.appendChild(statusText);
    status.appendChild(elapsed);
    box.appendChild(status);

    var meta = UI.el('div', { class: 'ck-gen-meta' });
    var chars = UI.el('span', { class: 'ck-gen-chars', text: '已接收 0 字' });
    var attempt = UI.el('span', { class: 'ck-gen-attempt', text: '第 1 次尝试' });
    meta.appendChild(chars);
    meta.appendChild(attempt);
    box.appendChild(meta);

    var textEl = UI.el('span', { class: 'ck-gen-preview-text', text: '' });
    var caret = UI.el('span', { class: 'ck-gen-caret' });
    var pre = UI.el('pre', { class: 'ck-gen-preview' }, textEl, caret);
    pre.addEventListener('scroll', function () {
      var gap = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
      st.genFollow = gap < 60;
    });
    box.appendChild(pre);
    box.appendChild(UI.el('div', { class: 'ck-gen-hint', text: '这里是模型原始输出，完成后自动整理成世界观设定' }));

    st.genEls = {
      status: statusText,
      elapsed: elapsed,
      chars: chars,
      attempt: attempt,
      pre: pre,
      text: textEl
    };
    updateGenView();
    return box;
  }

  function stopGenLoop() {
    if (st.genTimer) { clearInterval(st.genTimer); st.genTimer = null; }
    if (st.genRaf) {
      try { cancelAnimationFrame(st.genRaf); } catch (e) { /* 忽略 */ }
      st.genRaf = null;
    }
  }

  function startGenLoop() {
    stopGenLoop();
    st.genTimer = setInterval(updateGenView, 200);
  }

  function scheduleGenUpdate() {
    if (st.genRaf) return;
    st.genRaf = U.raf(function () {
      st.genRaf = null;
      updateGenView();
    });
  }

  function updateGenView() {
    var e = st.genEls;
    if (!e) return;
    var ms = st.genStartAt ? (Date.now() - st.genStartAt) : 0;
    e.elapsed.textContent = (ms / 1000).toFixed(1) + 's';
    e.chars.textContent = '已接收 ' + st.genChars + ' 字';
    e.attempt.textContent = '第 ' + (st.genAttempt || 1) + ' 次尝试';
    var phases = {
      connecting: '正在连接 API…',
      streaming: '正在生成…',
      parsing: '正在解析设定…',
      retrying: '正在重试…',
      stopping: '正在停止…',
      done: '生成完成',
      stopped: '已停止',
      error: '生成失败'
    };
    e.status.textContent = phases[st.genPhase] || '正在生成…';
    if (st.genLive && e.text.textContent !== st.genLive) {
      e.text.textContent = st.genLive;
      e.pre.classList.add('has-text');
    }
    if (st.genFollow !== false) {
      try { e.pre.scrollTop = e.pre.scrollHeight; } catch (err) { /* 忽略 */ }
    }
  }

  function cancelGenerate() {
    if (!st.busy) return;
    st.genPhase = 'stopping';
    try { P.cancelCompletion(); } catch (e) { /* 忽略 */ }
    updateGenView();
    setTimeout(function () {
      if (!st.busy || st.destroyed) return;
      finishStopped();
    }, 900);
  }

  function finishStopped() {
    if (st.destroyed || !st.work) return;
    st.busy = false;
    st.genPhase = 'stopped';
    st.work.aiError = { code: 'cancel', message: '已停止生成' };
    st.work.raw = st.genLive || st.work.raw || '';
    st.work.aiFailed = true;
    stopGenLoop();
    saveDraftNow();
    render();
  }

  function renderAiError() {
    var err = st.work.aiError || {};
    var info = Kit.errorInfo(err);
    var cancelled = err.code === 'cancel';
    var title;
    var hint;
    if (cancelled) {
      title = '已停止生成';
      hint = '已经收到的内容保留在下方。可以继续生成、重试，或手动填写。';
    } else if (err.parseFailed) {
      title = 'AI 补全失败，内容可能不完整';
      hint = '返回内容不是合法的世界观 JSON，已经自动重试过一次。可以再试一次，或手动填写。';
    } else if (err.code === 'noprovider') {
      title = '没有可用的引导 API';
      hint = err.message || '请先到「API 管理」配置引导 API；也可以直接手动填写。';
    } else {
      title = info.title || 'AI 补全失败';
      hint = (info.hint ? info.hint + ' ' : '') + (err.message || '');
    }

    var actions = [];
    if (err.code === 'noprovider' || err.code === 'nomodel') {
      actions.push({
        text: '去配置 API',
        class: 'primary',
        onClick: function () { App.Router.tab('apiList'); }
      });
    } else {
      actions.push({
        text: cancelled ? '继续生成' : '重试',
        class: 'primary',
        onClick: function () {
          if (st.busy) return;
          var last = st.lastRewrite || { isRewrite: false, instruction: '' };
          st.work.aiError = null;
          render();
          runComplete(!!last.isRewrite, last.instruction);
        }
      });
    }
    actions.push({
      text: '手动填写',
      onClick: function () {
        st.work.aiError = null;
        st.work.aiFailed = true;
        st.work.stage = 'preview';
        saveDraftNow();
        render();
      }
    });
    return Kit.errorBox({ title: title, hint: hint, actions: actions });
  }

  /* ---------------------------- 第一步 ---------------------------- */

  function buildInputStage(body) {
    var w = st.work;
    var form = UI.el('div', { class: 'form' });

    form.appendChild(UI.el('div', { class: 'field' },
      UI.el('label', null,
        UI.el('span', { text: '世界观名称 ' }),
        UI.el('span', { class: 'ck-required', text: '*' })
      ),
      UI.el('input', {
        class: 'input',
        attrs: { id: 'ck-wv-name', type: 'text', maxlength: '30', placeholder: '例如：永夜海国', 'data-guide-focus': 'name' },
        value: w.name,
        on: {
          input: function (ev) {
            w.name = ev.target.value;
            saveDraftSoon();
          }
        }
      }),
      UI.el('div', { class: 'hint', text: '名称会原样保留，AI 不会改它。' })
    ));

    form.appendChild(UI.el('div', { class: 'field' },
      UI.el('label', { text: '一句话描述这个世界' }),
      UI.el('textarea', {
        class: 'textarea',
        attrs: {
          id: 'ck-wv-raw',
          rows: '5',
          maxlength: '800',
          placeholder: '例如：一个被永夜笼罩的海上城邦，靠捕捞发光的鱼维持照明；城里分为灯塔区、渔市和沉船墓场，人们信奉会吃梦的潮神。',
          'data-guide-focus': 'rawInput'
        },
        value: w.rawInput,
        on: {
          input: function (ev) {
            w.rawInput = ev.target.value;
            saveDraftSoon();
          }
        }
      }),
      UI.el('div', { class: 'hint', text: '写得越具体，补全结果越贴近你的想法。名称 + 一两句就够。' })
    ));

    body.appendChild(form);

    if (!Kit.findGuide(st.providers)) {
      var warn = UI.el('div', { class: 'ck-warn-box' },
        UI.el('div', { class: 'ck-warn-title', text: '还没有可用的引导 API' }),
        UI.el('div', { class: 'ck-warn-text', text: 'AI 补全需要先配置引导 API。你也可以手动填写完整设定，不影响保存和使用。' }),
        UI.el('button', {
          class: 'btn small ghost',
          type: 'button',
          text: '去配置 API',
          on: { click: function () { App.Router.tab('apiList'); } }
        })
      );
      body.appendChild(warn);
    } else {
      body.appendChild(UI.el('div', {
        class: 'ck-note',
        text: '「AI 补全」固定使用引导 API，会自动扩写摘要、时代、地点、规则、社会结构、禁忌、常用元素与角色人设建议。'
      }));
    }
  }

  /* ---------------------------- 第二步 ---------------------------- */

  function buildPreviewStage(body) {
    var w = st.work;

    var head = UI.el('div', { class: 'ck-preview-head' },
      UI.el('div', { class: 'ck-preview-main' },
        UI.el('div', { class: 'ck-preview-name', text: w.name || '未命名世界观' }),
        UI.el('div', { class: 'ck-preview-sub' },
          UI.el('span', { class: 'badge ' + (w.aiFailed ? 'orange' : 'green'), text: w.aiFailed ? '草稿 · 手动填写' : '自定义' }),
          UI.el('span', { class: 'ck-wv-source', text: '共用设定' })
        )
      )
    );
    body.appendChild(head);

    body.appendChild(UI.el('div', {
      class: 'ck-note',
      text: '点任意字段可以修改。AI 补的字段带「AI 补全」标记；改过的字段会记为你填写。'
    }));

    var list = UI.el('div', { class: 'ck-field-list' });

    list.appendChild(fieldRow('name', '名称', w.name, true, function () {
      return Kit.editField({ label: '世界观名称', value: w.name, multiline: false, placeholder: '世界观名称' }).then(function (text) {
        if (text === null) return null;
        if (!text.trim()) { UI.toast('名称不能为空', 'error'); return null; }
        w.name = text.trim();
        w.fieldOrigin.name = 'user';
        saveDraftNow();
        render();
        return null;
      });
    }));

    list.appendChild(fieldRow('summary', '摘要', w.summary, false, function () {
      return Kit.editField({
        label: '一句话摘要',
        value: w.summary,
        multiline: true,
        placeholder: '一两句话概括这个世界'
      }).then(function (text) {
        if (text === null) return null;
        w.summary = text;
        w.fieldOrigin.summary = 'user';
        saveDraftNow();
        render();
        return null;
      });
    }));

    detailFields().forEach(function (f) {
      var value = f.key === 'elements' ? (w.details.elements || []).join('、') : (w.details[f.key] || '');
      var row = Kit.fieldRow({
        label: f.label,
        value: value,
        empty: !String(value || '').trim(),
        placeholder: '点此填写' + f.label,
        ai: (w.fieldOrigin || {})[f.key] === 'ai',
        user: (w.fieldOrigin || {})[f.key] === 'user',
        onClick: function () {
          if (f.key === 'elements') {
            return Kit.editList({
              label: '常用元素',
              values: w.details.elements || [],
              hint: '一行一个元素，例如「异火」「拍卖行」'
            }).then(function (arr) {
              if (arr === null) return null;
              w.details.elements = arr;
              w.fieldOrigin.elements = 'user';
              saveDraftNow();
              render();
              return null;
            });
          }
          return Kit.editField({
            label: f.label,
            value: w.details[f.key] || '',
            multiline: true,
            placeholder: '填写' + f.label
          }).then(function (text) {
            if (text === null) return null;
            w.details[f.key] = text;
            w.fieldOrigin[f.key] = 'user';
            saveDraftNow();
            render();
            return null;
          });
        }
      });
      list.appendChild(row);
    });

    body.appendChild(list);

    if (w.aiError) return;
    if (w.aiFailed) {
      body.appendChild(UI.el('div', {
        class: 'ck-info-box',
        text: '这是手动填写/兜底保存的设定，保存后会以「草稿」标记出现在列表里，之后可以随时编辑。'
      }));
    }
  }

  function fieldRow(key, label, value, required, onClick) {
    var w = st.work;
    var fo = (w.fieldOrigin || {})[key] || '';
    return Kit.fieldRow({
      label: label + (required ? ' *' : ''),
      value: value,
      empty: !String(value || '').trim(),
      placeholder: '点此填写' + label,
      ai: fo === 'ai',
      user: fo === 'user',
      onClick: onClick
    });
  }

  /* ---------------------------- 底部操作 ---------------------------- */

  function buildEditorFooter() {
    var w = st.work;
    var foot = UI.el('div', { class: 'ck-action-row' });
    var busy = st.busy;

    if (busy) {
      foot.appendChild(btn('停止生成', 'danger', function () { cancelGenerate(); }, false));
      return foot;
    }

    if (w.stage === 'input') {
      foot.appendChild(btn('取消', 'ghost', function () { cancelEdit(); }, false));
      foot.appendChild(btn('手动填写', 'ghost', function () { goManual(); }, false));
      foot.appendChild(btn('AI 补全', 'primary', function () { runComplete(false); }, false));
    } else {
      foot.appendChild(btn('返回描述', 'ghost', function () {
        w.stage = 'input';
        saveDraftNow();
        render();
      }, busy));
      foot.appendChild(btn(busy ? '调整中…' : '让 AI 改', 'ghost', function () { askRewrite(); }, busy));
      foot.appendChild(btn('保存', 'primary', function () { saveWork(); }, busy));
    }
    return foot;
  }

  function btn(text, cls, onClick, disabled) {
    var node = UI.el('button', { class: 'btn ' + cls, type: 'button', text: text });
    if (disabled) {
      node.disabled = true;
    } else {
      node.addEventListener('click', onClick);
    }
    return node;
  }

  function goManual() {
    st.work.aiFailed = true;
    st.work.stage = 'preview';
    saveDraftNow();
    render();
  }

  /* ------------------------------------------------------------
   * AI 补全 / 让 API 改
   * ---------------------------------------------------------- */

  function runComplete(isRewrite, instruction) {
    if (st.busy || !st.work) return Promise.resolve(null);
    var w = st.work;

    if (!String(w.name || '').trim()) {
      UI.toast('请先填写世界观名称', 'error');
      return Promise.resolve(null);
    }
    if (!isRewrite && !String(w.rawInput || '').trim()) {
      UI.toast('写一句描述，AI 才知道往哪个方向补全', 'error');
      return Promise.resolve(null);
    }

    var guide = Kit.findGuide(st.providers);
    if (!guide) {
      w.aiError = { code: 'noprovider', message: '还没有可用的引导 API，请先到「API 管理」配置。' };
      w.aiFailed = true;
      saveDraftNow();
      render();
      return Promise.resolve(null);
    }
    var model = guide.defaultModel || (guide.models && guide.models[0]) || '';
    if (!model) {
      w.aiError = {
        code: 'nomodel',
        message: '「' + (guide.name || '引导 API') + '」还没有设置模型，请到「API 管理」补上。'
      };
      w.aiFailed = true;
      saveDraftNow();
      render();
      return Promise.resolve(null);
    }

    var rawInput = String(w.rawInput || '');
    if (isRewrite) {
      rawInput = '【当前设定】\n' + currentText() +
        '\n\n【修改意见】\n' + (instruction || '') +
        '\n\n请在保留名称与整体框架的前提下，按修改意见完整重写这套设定。';
    }

    w.aiError = null;
    st.busy = true;
    st.lastRewrite = { isRewrite: !!isRewrite, instruction: instruction || '' };
    st.genStartAt = Date.now();
    st.genChars = 0;
    st.genPhase = 'connecting';
    st.genAttempt = 1;
    st.genLive = '';
    st.genEls = null;
    st.genFollow = true;
    render();
    startGenLoop();

    return P.completeWorldview({
      name: String(w.name || '').trim(),
      rawInput: rawInput,
      provider: guide,
      model: model,
      timeoutMs: (P && P.TIMEOUT_MS) ? P.TIMEOUT_MS : 60000,
      stream: true,
      onDelta: function (acc) {
        if (st.destroyed || !st.busy) return;
        if (typeof acc !== 'string') return;
        st.genLive = acc;
        st.genChars = acc.length;
        if (st.genPhase !== 'streaming') st.genPhase = 'streaming';
        scheduleGenUpdate();
      },
      onAttempt: function (n) {
        if (st.destroyed || !st.busy) return;
        st.genAttempt = n || 1;
        st.genPhase = st.genAttempt > 1 ? 'retrying' : 'connecting';
        st.genLive = '';
        st.genChars = 0;
        scheduleGenUpdate();
      }
    }).then(function (res) {
      stopGenLoop();
      if (st.destroyed) return null;
      st.busy = false;

      if (!res || !res.ok) {
        var err = (res && res.error) || { code: 'unknown', message: 'AI 补全失败' };
        if (err.code === 'cancel') {
          w.aiError = { code: 'cancel', message: '已停止生成' };
          st.genPhase = 'stopped';
        } else {
          w.aiError = err;
          st.genPhase = 'error';
        }
        w.raw = (res && res.raw) || st.genLive || '';
        w.aiFailed = true;
        saveDraftNow();
        render();
        return null;
      }

      st.genPhase = 'done';
      applyGenerated(res.worldview, res.raw);
      saveDraftNow();
      render();
      UI.toast(isRewrite ? '已按意见调整，记得保存' : '补全完成，可以逐项修改', 'ok');
      return null;
    }).catch(function (err) {
      stopGenLoop();
      st.busy = false;
      console.error('[worldviews] AI 补全失败', err);
      if (st.destroyed) return null;
      w.aiError = {
        code: (err && err.code) || 'unknown',
        message: (err && err.message) || '调用异常'
      };
      st.genPhase = 'error';
      w.raw = w.raw || st.genLive || '';
      w.aiFailed = true;
      saveDraftNow();
      render();
      return null;
    });
  }

  function applyGenerated(wv, raw) {
    var w = st.work;
    if (!wv) return;
    var typedName = String(w.name || '').trim();
    if (wv.name) w.name = typedName || wv.name;
    else if (typedName) w.name = typedName;
    w.summary = wv.summary || w.summary || '';
    var d = wv.details || {};
    w.details = {
      era: String(d.era || ''),
      place: String(d.place || ''),
      rules: String(d.rules || ''),
      society: String(d.society || ''),
      taboos: String(d.taboos || ''),
      elements: Array.isArray(d.elements) ? d.elements.filter(Boolean).map(String) : [],
      characterHints: String(d.characterHints || '')
    };

    // fieldOrigin：用户自己填的名称算 user，其余 AI 写了内容的算 ai
    var origin = {};
    if (typedName) origin.name = 'user';
    else if (wv.name) origin.name = 'ai';
    if (w.summary) origin.summary = 'ai';
    ['era', 'place', 'rules', 'society', 'taboos', 'characterHints'].forEach(function (k) {
      if (w.details[k]) origin[k] = 'ai';
    });
    if (w.details.elements.length) origin.elements = 'ai';
    w.fieldOrigin = origin;
    w.raw = raw || '';
    w.stage = 'preview';
    w.aiFailed = false;
    w.aiError = null;
  }

  function askRewrite() {
    if (st.busy) return;
    if (!Kit.findGuide(st.providers)) {
      UI.toast('需要先在「API 管理」里配置引导 API', 'error');
      return;
    }
    UI.prompt({
      title: '让 AI 改',
      message: '写一句修改意见，例如「更阴冷一点」「加一套等级体系」「去掉现代科技」。',
      placeholder: '更阴冷一点，规则更残酷',
      multiline: true,
      okText: '开始修改'
    }).then(function (text) {
      var instruction = String(text || '').trim();
      if (!instruction) return null;
      runComplete(true, instruction);
      return null;
    }).catch(function (err) {
      console.error('[worldviews] 输入修改意见失败', err);
    });
  }

  /* ------------------------------------------------------------
   * 保存
   * ---------------------------------------------------------- */

  function saveWork() {
    if (st.busy || !st.work) return Promise.resolve(null);
    var w = st.work;

    if (!String(w.name || '').trim()) {
      UI.toast('请填写世界观名称', 'error');
      return Promise.resolve(null);
    }
    if (!hasAnyDetail(w)) {
      UI.toast('请先填写摘要或至少一项设定内容', 'error');
      return Promise.resolve(null);
    }

    var now = Kit.now();
    var rec = {
      id: w.id || U.uid('wv'),
      name: String(w.name).trim(),
      summary: w.summary || '',
      details: {
        era: w.details.era || '',
        place: w.details.place || '',
        rules: w.details.rules || '',
        society: w.details.society || '',
        taboos: w.details.taboos || '',
        elements: (w.details.elements || []).slice(),
        characterHints: w.details.characterHints || ''
      },
      isBuiltin: false,
      source: 'user',
      rawInput: w.rawInput || '',
      draft: !!w.aiFailed,
      fieldOrigin: w.fieldOrigin || {},
      createdAt: w.createdAt || now,
      updatedAt: now
    };

    st.busy = true;
    render();

    return DB.put('worldviews', rec).then(function (saved) {
      st.busy = false;
      clearDraft();
      Kit.notifyData('worldviews');
      UI.toast(rec.draft ? '已保存为草稿，可随时编辑' : '世界观已保存', 'ok');
      st.mode = 'list';
      st.work = null;
      st.progress = null;
      return reloadAll().then(function () {
        if (!st.destroyed) render();
        return saved || null;
      });
    }).catch(function (err) {
      st.busy = false;
      console.error('[worldviews] 保存失败', err);
      UI.toast('保存失败：' + ((err && err.message) || '未知错误'), 'error');
      render();
      return null;
    });
  }

  /* ------------------------------------------------------------
   * 页面注册
   * ---------------------------------------------------------- */

  App.Router.register(PAGE, {
    title: '世界观库',
    build: function (root, params, page) {
      st.root = root;
      st.page = page;
      st.destroyed = false;
      st.loading = true;
      st.mode = 'list';
      st.work = null;
      st.busy = false;
      st.progress = null;
      st.genStartAt = 0;
      st.genChars = 0;
      st.genPhase = 'idle';
      st.genAttempt = 1;
      st.genLive = '';
      st.genEls = null;
      stopGenLoop();

      page.setTitle('世界观库');

      page.onDestroy(function () {
        try { P.cancelCompletion(); } catch (e) { /* 忽略 */ }
        stopGenLoop();
        st.destroyed = true;
        st.busy = false;
      });

      return reloadAll().then(function () {
        return DB.settings.get(DRAFT_KEY, null);
      }).then(function (draft) {
        if (st.destroyed) return;
        st.loading = false;

        // 恢复上次未完成的世界观编辑（杀进程后也能回来）
        if (draft && typeof draft === 'object' &&
          (draft.name || draft.rawInput || (draft.summary && draft.summary !== ''))) {
          st.mode = 'edit';
          st.work = normalizeWork(draft);
          UI.toast('已恢复上次未完成的世界观编辑', 'ok');
        }

        render();
        if (st.mode === 'edit') focusSoon('ck-wv-name');
      }).catch(function (err) {
        console.error('[worldviews] 页面加载失败', err);
        st.loading = false;
        if (st.destroyed) return;
        UI.clear(root);
        root.appendChild(UI.errorState({
          title: '加载失败',
          desc: (err && err.message) || '读取世界观数据失败，请重试。',
          actionText: '重试',
          onAction: function () { App.Router.replace(PAGE, params); }
        }));
      });
    }
  });
})();
