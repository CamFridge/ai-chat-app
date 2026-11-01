/* ============================================================
 * pages/character-edit.js —— 编辑角色（二级页）
 * 参数：{ id } 角色 id
 *
 * 功能：
 *   - 编辑全部字段（陪聊 / 助手各自显示对应字段）；
 *   - 类型可切换，但需要二次确认，并提示部分字段会重置；
 *   - 保存落库（保留 id / createdAt，重建 systemPrompt）；
 *   - 「让它更像…」：可选，固定用引导 API 按意见微调；
 *   - 角色图片库：查看 / 添加 / 重命名 / 改说明 / 删除（落 characterImages 表，供聊天里主动发图）；
 *   - 问候语：首选（firstMessage）+ 0~10 条备选（alternateGreetings），聊天页可随时切换。
 * ============================================================ */
(function () {
  'use strict';

  var UI = App.UI;
  var U = App.Util;
  var DB = App.DB;
  var Kit = App.CharKit;
  var P = App.Prompts;

  var PAGE = 'characterEdit';

  var state = {
    root: null,
    page: null,
    id: '',
    card: null,
    presets: [],
    userWvs: [],
    providers: [],
    images: [],        // 角色图片库（characterImages 表）
    imgBusy: false,    // 正在选图 / 添加图片
    imgModal: null,    // 图片库弹窗句柄
    imgGridBox: null,  // 弹窗内网格容器（新增/删除后局部刷新）
    imgCountEl: null,  // 弹窗内数量文案
    greetModal: null,  // 问候语弹窗句柄（首选 + 备选）
    destroyed: false,
    busy: false,
    loaded: false
  };

  var COMPANION_KEYS = ['personality', 'habits', 'background', 'speechStyle', 'catchphrases', 'scenario'];
  var ASSISTANT_KEYS = ['domain', 'specialty', 'duties', 'answerStyle', 'knowledgeBoundary', 'refusalPolicy'];

  /* ------------------------------------------------------------
   * 渲染
   * ---------------------------------------------------------- */

  function render() {
    if (!state.root || state.destroyed || !state.card) return;
    UI.clear(state.root);

    var scroll = UI.el('div', { class: 'page-scroll' });
    scroll.appendChild(cardHead());
    scroll.appendChild(formList());
    if (state.busy) {
      scroll.appendChild(UI.el('div', { class: 'ck-loading-inline', html: UI.icon('spark', 18) + '<span>AI 正在调整…</span>' }));
    }
    state.root.appendChild(scroll);
    state.root.appendChild(footer());
    updateGuide();
  }

  function cardHead() {
    var card = state.card;
    return UI.el('div', { class: 'ck-preview-head' },
      UI.avatar(card.name || '角', card.avatar, 'lg'),
      UI.el('div', { class: 'ck-preview-main' },
        UI.el('div', { class: 'ck-preview-name', text: card.name || '未命名角色' }),
        UI.el('div', { class: 'ck-preview-sub' },
          UI.el('span', { class: 'badge ' + (card.type === 'assistant' ? 'blue' : 'green'), text: Kit.typeName(card.type) }),
          card.worldviewSnapshot
            ? UI.el('span', { class: 'ck-wv-mini', text: Kit.snapshotName(card.worldviewSnapshot) || '' })
            : UI.el('span', { class: 'ck-wv-mini', text: '未绑定世界观' })
        )
      )
    );
  }

  function formList() {
    var list = UI.el('div', { class: 'ck-field-list' });

    // 名称
    list.appendChild(fieldRow('name', '名称', state.card.name, { required: true, multiline: false }));

    // 类型
    list.appendChild(typeRow());

    // 头像
    list.appendChild(fieldRow('avatar', '头像地址（可空）', state.card.avatar, { multiline: false, placeholder: '图片 URL 或留空用文字头像' }));

    // 世界观
    list.appendChild(worldviewRow());

    // 角色图片库（聊天时 TA 可以主动发图）
    list.appendChild(imageRow());

    // 类型专属字段
    var keys = state.card.type === 'assistant' ? ASSISTANT_KEYS : COMPANION_KEYS;
    keys.forEach(function (key) {
      var def = fieldDef(key, state.card.type);
      if (!def) return;
      list.appendChild(fieldRow(key, def.label, state.card[key], def));
    });

    // 问候语（首选 + 备选，两类共有）
    list.appendChild(greetingsRow());

    // 示例对话（仅陪聊）
    if (state.card.type !== 'assistant') {
      list.appendChild(dialogsRow());
    }

    // system prompt
    list.appendChild(fieldRow('systemPrompt', 'System Prompt', state.card.systemPrompt, {
      multiline: true,
      big: true,
      hint: '留空保存时会按其他字段自动生成'
    }));

    return list;
  }

  function fieldDef(key, type) {
    var data = App.Data || {};
    var arr = (type === 'assistant' ? data.ASSISTANT_FIELDS : data.COMPANION_FIELDS) || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].key === key) return arr[i];
    }
    return { key: key, label: key };
  }

  function fieldRow(key, label, value, opts) {
    opts = opts || {};
    var text;
    if (Array.isArray(value)) text = value.filter(Boolean).join(' / ');
    else text = value == null ? '' : String(value);

    var fo = (state.card.fieldOrigin || {})[key] || '';
    var row = Kit.fieldRow({
      label: label + (opts.required ? ' *' : ''),
      value: text,
      empty: !String(text || '').trim(),
      placeholder: '点此编辑',
      ai: fo === 'ai',
      user: fo === 'user',
      onClick: function () { editField(key, label, opts); }
    });
    return row;
  }

  function typeRow() {
    var cell = UI.el('div', { class: 'cell ck-field', attrs: { role: 'button', tabindex: '0' } },
      UI.el('div', { class: 'main' },
        UI.el('div', { class: 'ck-field-label' },
          UI.el('span', { class: 'ck-field-title', text: '角色类型' })
        ),
        UI.el('div', { class: 'ck-field-value', text: Kit.typeName(state.card.type) })
      ),
      UI.el('span', { class: 'chev', html: UI.icon('chev', 17) })
    );
    cell.addEventListener('click', changeType);
    return cell;
  }

  function worldviewRow() {
    var name = Kit.snapshotName(state.card.worldviewSnapshot) || '无世界观';
    var cell = UI.el('div', { class: 'cell ck-field', attrs: { role: 'button', tabindex: '0' } },
      UI.el('div', { class: 'main' },
        UI.el('div', { class: 'ck-field-label' },
          UI.el('span', { class: 'ck-field-title', text: '世界观' })
        ),
        UI.el('div', { class: 'ck-field-value', text: name })
      ),
      UI.el('span', { class: 'chev', html: UI.icon('chev', 17) })
    );
    cell.addEventListener('click', pickWorldview);
    return cell;
  }

  /* ------------------------------------------------------------
   * 角色图片库
   * ---------------------------------------------------------- */

  function imageRow() {
    var n = (state.images || []).length;
    var cell = UI.el('div', {
      class: 'cell ck-field',
      attrs: { role: 'button', tabindex: '0', 'data-guide-focus': 'characterImages' }
    },
      UI.el('div', { class: 'main' },
        UI.el('div', { class: 'ck-field-label' },
          UI.el('span', { class: 'ck-field-title', text: '角色图片库' })
        ),
        UI.el('div', { class: 'ck-field-value', text: n + ' 张 · 可让 TA 在聊天里发给你' })
      ),
      UI.el('span', { class: 'chev', html: UI.icon('chev', 17) })
    );
    cell.addEventListener('click', openImageModal);
    return cell;
  }

  // 读取图片库（优先 App.Media，缺失时直接读 characterImages 表兜底）
  function loadImages() {
    if (!state.id) return Promise.resolve([]);
    var M = App.Media;
    if (M && typeof M.list === 'function') {
      return Promise.resolve(M.list(state.id)).then(function (rows) {
        return Array.isArray(rows) ? rows : [];
      }).catch(function (err) {
        console.error('[characterEdit] 读取图片库失败', err);
        return [];
      });
    }
    return DB.byIndex('characterImages', 'characterId', state.id).then(function (rows) {
      return (rows || []).slice().sort(function (a, b) {
        return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
      });
    }).catch(function (err) {
      console.error('[characterEdit] 读取图片库失败', err);
      return [];
    });
  }

  function refreshImages() {
    return loadImages().then(function (rows) {
      if (state.destroyed) return null;
      state.images = rows;
      render();          // 刷新表单里「N 张」副标题
      renderImageGrid(); // 刷新弹窗网格
      return rows;
    });
  }

  function openImageModal() {
    if (!state.card || state.destroyed) return;
    if (state.imgModal) return;

    var content = UI.el('div', { class: 'ck-img-modal' });
    content.appendChild(UI.el('div', { class: 'ck-img-desc', text: '把图片放进 TA 的图片库。聊天时 TA 可以主动挑一张发给你；也可以让引导助手帮你添加。' }));

    var count = UI.el('div', { class: 'ck-img-count' });
    var gridBox = UI.el('div', {});
    content.appendChild(count);
    content.appendChild(gridBox);

    var foot = UI.el('div', { class: 'ck-img-foot' });
    var addBtn = UI.el('button', {
      class: 'btn primary block',
      type: 'button',
      attrs: { 'data-guide-tap': 'addCharacterImage' },
      text: '＋ 添加图片'
    });
    var helpBtn = UI.el('button', { class: 'btn ghost block', type: 'button', text: '让引导助手帮我加' });
    addBtn.addEventListener('click', addLibraryImage);
    helpBtn.addEventListener('click', helpAddImage);
    foot.appendChild(addBtn);
    foot.appendChild(helpBtn);
    content.appendChild(foot);

    state.imgGridBox = gridBox;
    state.imgCountEl = count;
    renderImageGrid();

    state.imgModal = UI.modal({
      title: '角色图片库',
      content: content,
      dismissible: true,
      onClose: function () {
        state.imgModal = null;
        state.imgGridBox = null;
        state.imgCountEl = null;
      }
    });
    // 内容区约 80vh（base.css 里 .modal-body 默认 45vh；小屏时按视口高度收敛）
    if (state.imgModal && state.imgModal.box) state.imgModal.box.style.maxHeight = 'min(80vh, calc(100vh - 150px))';
  }

  function renderImageGrid() {
    var box = state.imgGridBox;
    if (!box) return;
    UI.clear(box);
    if (state.imgCountEl) state.imgCountEl.textContent = state.images.length ? ('共 ' + state.images.length + ' 张') : '';

    if (!state.images.length) {
      box.appendChild(UI.el('div', { class: 'ck-img-empty', text: '还没有图片。添加后，聊天时角色可以主动发给你。' }));
      return;
    }

    var grid = UI.el('div', { class: 'ck-img-grid' });
    state.images.forEach(function (rec) {
      var cell = UI.el('div', { class: 'ck-img-cell', attrs: { role: 'button', tabindex: '0' } });
      cell.appendChild(UI.el('img', { attrs: { src: rec.dataUri, alt: rec.name || '图片', loading: 'lazy' } }));
      cell.appendChild(UI.el('div', { class: 'ck-img-cell-name', text: rec.name || '图片' }));

      var more = UI.el('button', {
        class: 'ck-img-more',
        type: 'button',
        attrs: { 'aria-label': '图片操作' },
        html: UI.icon('more', 16)
      });
      more.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openImageMenu(rec);
      });
      cell.appendChild(more);

      cell.addEventListener('click', function () { previewImage(rec); });
      grid.appendChild(cell);
    });
    box.appendChild(grid);
  }

  function previewImage(rec) {
    var M = App.Media;
    if (!M || typeof M.preview !== 'function') {
      UI.toast('当前环境不支持图片预览', 'error');
      return;
    }
    try {
      Promise.resolve(M.preview(rec)).catch(function (err) {
        console.error('[characterEdit] 预览图片失败', err);
        UI.toast('无法预览这张图片', 'error');
      });
    } catch (err) {
      console.error('[characterEdit] 预览图片失败', err);
      UI.toast('无法预览这张图片', 'error');
    }
  }

  function addLibraryImage() {
    if (state.imgBusy) return;
    if (!state.id) {
      UI.toast('请先保存角色后再添加图片', 'error');
      return;
    }
    var M = App.Media;
    if (!M || typeof M.pickImage !== 'function' || typeof M.addImage !== 'function') {
      UI.toast('图片功能暂不可用，请稍后重试', 'error');
      return;
    }

    state.imgBusy = true;
    Promise.resolve(M.pickImage())
      .then(function (att) {
        if (!att) return null; // 用户取消
        return M.addImage(state.id, att, { source: 'user', caption: '' });
      })
      .then(function (rec) {
        if (!rec) return null;
        UI.toast('已添加到图片库', 'ok');
        return refreshImages();
      })
      .catch(function (err) {
        console.error('[characterEdit] 添加图片失败', err);
        UI.toast('添加图片失败：' + ((err && err.message) || '未知错误'), 'error');
      })
      .then(function () {
        state.imgBusy = false;
      });
  }

  function openImageMenu(rec) {
    var M = App.Media;
    if (!M) return Promise.resolve(null);
    return UI.sheet({
      title: rec.name || '图片',
      items: [
        { id: 'rename', label: '重命名', icon: 'edit' },
        { id: 'caption', label: '修改说明', desc: rec.caption || '给 TA 一个提示，说明这张图是什么', icon: 'edit' },
        { id: 'delete', label: '删除', icon: 'delete', danger: true }
      ]
    }).then(function (item) {
      if (!item) return null;
      if (item.id === 'rename') return renameImage(rec);
      if (item.id === 'caption') return editImageCaption(rec);
      if (item.id === 'delete') return deleteImage(rec);
      return null;
    }).catch(function (err) {
      console.error('[characterEdit] 图片操作失败', err);
      return null;
    });
  }

  function renameImage(rec) {
    return UI.prompt({
      title: '重命名图片',
      value: rec.name || '',
      placeholder: '例如：猫猫照片',
      okText: '保存'
    }).then(function (text) {
      var name = String(text || '').trim();
      if (!name || name === rec.name) return null;
      return Promise.resolve(App.Media.update(rec.id, { name: name })).then(function () {
        UI.toast('已重命名', 'ok');
        return refreshImages();
      });
    }).catch(function (err) {
      console.error('[characterEdit] 重命名图片失败', err);
      UI.toast('重命名失败：' + ((err && err.message) || '未知错误'), 'error');
      return null;
    });
  }

  function editImageCaption(rec) {
    return UI.prompt({
      title: '修改图片说明',
      message: '写一句说明，帮助 TA 知道这张图是什么、什么时候发给你。',
      value: rec.caption || '',
      placeholder: '例如：我养的猫，心情好时发给你',
      multiline: true,
      okText: '保存'
    }).then(function (text) {
      var caption = String(text == null ? '' : text).trim();
      if (caption === (rec.caption || '')) return null;
      return Promise.resolve(App.Media.update(rec.id, { caption: caption })).then(function () {
        UI.toast('已更新说明', 'ok');
        return refreshImages();
      });
    }).catch(function (err) {
      console.error('[characterEdit] 修改图片说明失败', err);
      UI.toast('修改失败：' + ((err && err.message) || '未知错误'), 'error');
      return null;
    });
  }

  function deleteImage(rec) {
    return UI.confirm({
      title: '删除图片',
      message: '确定删除「' + (rec.name || '这张图片') + '」吗？删除后不可恢复。',
      okText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return null;
      return Promise.resolve(App.Media.remove(rec.id)).then(function () {
        UI.toast('已删除', 'ok');
        return refreshImages();
      });
    }).catch(function (err) {
      console.error('[characterEdit] 删除图片失败', err);
      UI.toast('删除失败：' + ((err && err.message) || '未知错误'), 'error');
      return null;
    });
  }

  function helpAddImage() {
    if (App.Help && typeof App.Help.open === 'function') {
      App.Help.open({ source: 'character_images', page: PAGE });
      UI.toast('可以在引导助手里发送图片，让它帮你加到「' + (state.card && state.card.name ? state.card.name : '这个角色') + '」的图片库', 'ok', 3200);
    } else {
      UI.toast('引导助手暂不可用', 'error');
    }
  }

  /* ------------------------------------------------------------
   * 问候语（首选 + 备选）
   *   - firstMessage：首选问候语，新建会话时默认使用；
   *   - alternateGreetings：备选问候语（0~10 条，每条 ≤200 字），
   *     聊天页「…」菜单里可以随时切换。
   * ---------------------------------------------------------- */

  var MAX_GREETINGS = 10;      // 备选问候语上限
  var MAX_GREETING_LEN = 200;  // 单条上限（字符）

  // 取角色卡上的备选问候语（过滤空串 / 非字符串，最多 10 条）
  function altGreetingsOf(card) {
    var list = (card && Array.isArray(card.alternateGreetings)) ? card.alternateGreetings : [];
    return list.filter(function (s) {
      return typeof s === 'string' && !!s.trim();
    }).slice(0, MAX_GREETINGS);
  }

  function greetingsRow() {
    var n = altGreetingsOf(state.card).length;
    var cell = UI.el('div', {
      class: 'cell ck-field',
      attrs: { role: 'button', tabindex: '0', 'data-guide-focus': 'greetings' }
    },
      UI.el('div', { class: 'main' },
        UI.el('div', { class: 'ck-field-label' },
          UI.el('span', { class: 'ck-field-title', text: '问候语' })
        ),
        UI.el('div', { class: 'ck-field-value', text: '首选 + ' + n + ' 条备选' })
      ),
      UI.el('span', { class: 'chev', html: UI.icon('chev', 17) })
    );
    cell.addEventListener('click', openGreetingsModal);
    return cell;
  }

  function closeGreetModal() {
    if (!state.greetModal) return;
    var h = state.greetModal;
    state.greetModal = null;
    try { h.close(); } catch (e) { /* 忽略 */ }
  }

  function openGreetingsModal() {
    if (!state.card || state.destroyed) return;
    if (state.greetModal) return;

    var card = state.card;
    var draftAlts = altGreetingsOf(card).slice(0, MAX_GREETINGS);

    var content = UI.el('div', { class: 'ck-greet-modal' });
    content.appendChild(UI.el('div', {
      class: 'ck-greet-desc',
      text: '首选是新建会话默认的开场白；备选可以在聊天页随时切换。'
    }));

    // 首选问候语
    var prefField = UI.el('div', { class: 'ck-greet-field' });
    prefField.appendChild(UI.el('div', { class: 'ck-greet-label' },
      UI.el('span', { text: '首选问候语' })
    ));
    var prefTa = UI.el('textarea', {
      class: 'ck-greet-ta',
      attrs: { rows: '3', placeholder: '例如：晚上好呀，今天想聊点什么？', 'aria-label': '首选问候语' }
    });
    prefTa.value = card.firstMessage || '';
    prefField.appendChild(prefTa);
    content.appendChild(prefField);

    // 备选问候语
    var altHead = UI.el('div', { class: 'ck-greet-label' },
      UI.el('span', { text: '备选问候语' }),
      UI.el('span', { class: 'ck-greet-count' })
    );
    var listBox = UI.el('div', { class: 'ck-greet-list' });
    var addBtn = UI.el('button', {
      class: 'btn ghost block ck-greet-add',
      type: 'button',
      attrs: { 'data-guide-tap': 'addAlternateGreeting' }
    });
    var hint = UI.el('div', {
      class: 'ck-greet-hint',
      text: '最多 ' + MAX_GREETINGS + ' 条备选，每条不超过 ' + MAX_GREETING_LEN + ' 字。'
    });
    content.appendChild(altHead);
    content.appendChild(listBox);
    content.appendChild(hint);
    content.appendChild(addBtn);

    // 底部按钮：取消 / 保存
    var foot = UI.el('div', { class: 'ck-greet-foot' });
    var cancelBtn = UI.el('button', { class: 'btn ghost', type: 'button', text: '取消' });
    var saveBtn = UI.el('button', { class: 'btn primary', type: 'button', text: '保存' });
    foot.appendChild(cancelBtn);
    foot.appendChild(saveBtn);
    content.appendChild(foot);

    // 渲染备选列表（新增/删除后局部重绘，保留已输入内容）
    function refreshAlts() {
      UI.clear(listBox);
      if (!draftAlts.length) {
        listBox.appendChild(UI.el('div', { class: 'ck-greet-empty', text: '还没有备选问候语' }));
      } else {
        draftAlts.forEach(function (text, idx) {
          var row = UI.el('div', { class: 'ck-greet-item' });
          var ta = UI.el('textarea', {
            class: 'ck-greet-ta',
            attrs: { rows: '2', maxlength: String(MAX_GREETING_LEN), placeholder: '输入一条备选问候语' }
          });
          ta.value = text == null ? '' : String(text);
          ta.addEventListener('input', function () { draftAlts[idx] = ta.value; });
          var del = UI.el('button', {
            class: 'ck-greet-del',
            type: 'button',
            text: '×',
            attrs: { 'aria-label': '删除这条备选问候语' }
          });
          del.addEventListener('click', function () {
            draftAlts.splice(idx, 1);
            refreshAlts();
          });
          row.appendChild(ta);
          row.appendChild(del);
          listBox.appendChild(row);
        });
      }
      // 数量 + 上限状态
      altHead.querySelector('.ck-greet-count').textContent = draftAlts.length + ' / ' + MAX_GREETINGS;
      var full = draftAlts.length >= MAX_GREETINGS;
      addBtn.disabled = full;
      addBtn.textContent = full ? '已达上限（' + MAX_GREETINGS + ' 条）' : '＋ 添加备选';
    }

    addBtn.addEventListener('click', function () {
      if (draftAlts.length >= MAX_GREETINGS) {
        UI.toast('最多添加 ' + MAX_GREETINGS + ' 条备选问候语', 'error');
        return;
      }
      draftAlts.push('');
      refreshAlts();
      var tas = listBox.querySelectorAll('textarea');
      if (tas.length) tas[tas.length - 1].focus();
    });

    cancelBtn.addEventListener('click', closeGreetModal);

    saveBtn.addEventListener('click', function () {
      // 首选：去首尾空白；备选：去空白、滤空串、截断 200 字、最多 10 条
      var preferred = String(prefTa.value == null ? '' : prefTa.value).trim();
      var alts = draftAlts.map(function (s) {
        return String(s == null ? '' : s).trim();
      }).filter(function (s) {
        return !!s;
      }).map(function (s) {
        return s.length > MAX_GREETING_LEN ? s.slice(0, MAX_GREETING_LEN) : s;
      }).slice(0, MAX_GREETINGS);

      card.firstMessage = preferred;
      card.alternateGreetings = alts;
      if (!card.fieldOrigin) card.fieldOrigin = {};
      card.fieldOrigin.firstMessage = 'user';
      card.fieldOrigin.alternateGreetings = 'user';
      // 问候语变化后 systemPrompt 需要重建
      delete card.fieldOrigin.systemPrompt;
      card.systemPrompt = '';

      closeGreetModal();
      render();                       // 先刷新入口行副标题
      saveCard({ stay: true });       // 沿用页面现有保存流程落库（不另建记录，保存后停留本页）
    });

    refreshAlts();

    state.greetModal = UI.modal({
      title: '问候语',
      content: content,
      dismissible: true,
      onClose: function () { state.greetModal = null; }
    });
    try {
      state.greetModal.box.style.maxHeight = 'min(80vh, calc(100vh - 150px))';
      state.greetModal.box.style.overflowY = 'auto';
    } catch (e) { /* 忽略 */ }
    try { prefTa.focus(); } catch (e) { /* 忽略 */ }
  }

  function dialogsRow() {
    var list = state.card.exampleDialogues || [];
    var text = list.map(function (d) {
      return '用户：' + (d && d.user ? d.user : '') + '\n角色：' + (d && d.char ? d.char : '');
    }).join('\n\n');
    var fo = (state.card.fieldOrigin || {}).exampleDialogues || '';
    var cell = Kit.fieldRow({
      label: '示例对话',
      value: text,
      empty: !list.length,
      placeholder: '点此添加 2-3 段示例对话',
      ai: fo === 'ai',
      user: fo === 'user',
      onClick: function () {
        Kit.editDialogs(state.card.exampleDialogues).then(function (out) {
          if (out === null) return null;
          state.card.exampleDialogues = out;
          markUser('exampleDialogues');
          return null;
        }).catch(function (err) {
          console.error('[characterEdit] 编辑示例对话失败', err);
        });
      }
    });
    return cell;
  }

  function footer() {
    var foot = UI.el('div', { class: 'ck-action-row' },
      UI.el('button', { class: 'btn ghost', type: 'button', text: '取消', attrs: { id: 'ck-edit-cancel' } }),
      UI.el('button', { class: 'btn ghost', type: 'button', text: '让它更像…', attrs: { id: 'ck-edit-like' } }),
      UI.el('button', { class: 'btn primary', type: 'button', text: state.busy ? '处理中…' : '保存', attrs: { id: 'ck-edit-save' } })
    );
    var cancel = foot.querySelector('#ck-edit-cancel');
    var like = foot.querySelector('#ck-edit-like');
    var save = foot.querySelector('#ck-edit-save');
    if (state.busy) save.disabled = true;
    cancel.addEventListener('click', function () {
      App.Router.pop();
    });
    like.addEventListener('click', askLike);
    save.addEventListener('click', saveCard);
    return foot;
  }

  function updateGuide() {
    if (!state.page || !state.page.guide || !state.card) return;
    var filled = { name: !!state.card.name, type: true };
    filled.characterImages = (state.images || []).length > 0;
    filled.greetings = !!(String(state.card.firstMessage || '').trim() || altGreetingsOf(state.card).length);
    var missing = [];
    if (!state.card.name) missing.push('name');
    if (state.card.type === 'assistant') {
      if (state.card.domain) filled.domain = true; else missing.push('domain');
      if ((state.card.specialty || []).length) filled.specialty = true; else missing.push('specialty');
    } else if (!state.card.personality) {
      missing.push('personality');
    }
    state.page.guide({
      pageId: PAGE,
      title: '编辑角色',
      stage: 'edit',
      totalSteps: 1,
      filledFields: filled,
      missingFields: missing
    });
  }

  /* ------------------------------------------------------------
   * 字段编辑
   * ---------------------------------------------------------- */

  function editField(key, label, opts) {
    opts = opts || {};
    var card = state.card;

    if (Array.isArray(card[key])) {
      return Kit.editList({ label: label, values: card[key] }).then(function (list) {
        if (list === null) return null;
        card[key] = list;
        markUser(key);
        return null;
      }).catch(function (err) {
        console.error('[characterEdit] 编辑列表失败', err);
        return null;
      });
    }

    var value = card[key] == null ? '' : String(card[key]);
    return Kit.editField({
      label: label,
      value: value,
      multiline: opts.multiline !== false,
      placeholder: opts.placeholder || '',
      hint: opts.hint || ''
    }).then(function (text) {
      if (text === null) return null;
      if (opts.required && !String(text || '').trim()) {
        UI.toast('「' + label + '」不能为空', 'error');
        return null;
      }
      card[key] = text;
      markUser(key);
      // 名称变化时同步标题
      if (key === 'name' && state.page) state.page.setTitle('编辑角色');
      return null;
    }).catch(function (err) {
      console.error('[characterEdit] 编辑字段失败', err);
      return null;
    });
  }

  function markUser(key) {
    if (!state.card.fieldOrigin) state.card.fieldOrigin = {};
    state.card.fieldOrigin[key] = 'user';
    if (key === 'systemPrompt') {
      // 用户手动改过 systemPrompt，保存时不再覆盖
    } else if (key !== 'name' && key !== 'avatar') {
      // 改了设定字段后，systemPrompt 需要重建
      state.card.systemPrompt = '';
      delete state.card.fieldOrigin.systemPrompt;
    }
    render();
  }

  /* ------------------------------------------------------------
   * 换类型 / 换世界观
   * ---------------------------------------------------------- */

  function changeType() {
    var card = state.card;
    return UI.sheet({
      title: '角色类型',
      items: [
        { id: 'companion', label: '陪聊角色', desc: '有性格与开场白，像真人一样聊天', icon: 'user' },
        { id: 'assistant', label: '领域助手', desc: '在某个领域里专业回答', icon: 'bot' }
      ],
      selected: card.type
    }).then(function (item) {
      if (!item || item.id === card.type) return null;
      return UI.confirm({
        title: '切换角色类型',
        message: '切换类型后，两类角色的专属字段会重置（陪聊的性格/习惯等，与助手的领域/职责等不通用）。\n确定切换吗？',
        okText: '切换',
        danger: true
      }).then(function (ok) {
        if (!ok) return null;
        card.type = item.id;
        if (item.id === 'assistant') {
          COMPANION_KEYS.forEach(function (k) { card[k] = ''; });
          card.exampleDialogues = [];
        } else {
          ASSISTANT_KEYS.forEach(function (k) {
            card[k] = (k === 'specialty' || k === 'duties') ? [] : '';
          });
        }
        card.systemPrompt = '';
        if (card.fieldOrigin) delete card.fieldOrigin.systemPrompt;
        UI.toast('已切换为' + Kit.typeName(card.type), 'ok');
        render();
        return null;
      });
    }).catch(function (err) {
      console.error('[characterEdit] 切换类型失败', err);
      return null;
    });
  }

  function pickWorldview() {
    var card = state.card;
    var options = [{ id: 'wv-none', label: '无世界观', desc: '按现代日常语境' }];
    (state.presets || []).forEach(function (wv) {
      if (wv.id === 'wv-none') return;
      options.push({ id: wv.id, label: wv.name, desc: wv.summary || '' });
    });
    (state.userWvs || []).forEach(function (wv) {
      options.push({ id: wv.id, label: wv.name, desc: '自定义 · ' + (wv.summary || '') });
    });

    return UI.sheet({ title: '选择世界观', items: options, selected: card.worldviewId || 'wv-none' }).then(function (item) {
      if (!item) return null;
      var wv = null;
      if (item.id !== 'wv-none') {
        wv = Kit.findWorldview(item.id);
      }
      return Promise.resolve(wv).then(function (found) {
        if (item.id !== 'wv-none' && !found) {
          UI.toast('该世界观已不存在', 'error');
          return null;
        }
        card.worldviewId = item.id === 'wv-none' ? '' : item.id;
        card.worldviewSnapshot = (found && P && P.worldviewSnapshotText)
          ? P.worldviewSnapshotText(found)
          : '';
        if (card.fieldOrigin) delete card.fieldOrigin.systemPrompt;
        card.systemPrompt = '';
        render();
        return null;
      });
    }).catch(function (err) {
      console.error('[characterEdit] 选择世界观失败', err);
      return null;
    });
  }

  /* ------------------------------------------------------------
   * 让它更像…（可选，固定引导 API）
   * ---------------------------------------------------------- */

  function askLike() {
    if (state.busy) return;
    var guide = Kit.findGuide(state.providers);
    if (!guide) {
      UI.toast('需要先在「API 管理」里配置引导 API', 'error');
      return;
    }
    var model = guide.defaultModel || (guide.models && guide.models[0]) || '';
    if (!model) {
      UI.toast('引导 API 还没有设置模型', 'error');
      return;
    }
    UI.prompt({
      title: '让它更像…',
      message: '写一句调整意见，例如「更毒舌一点」「回答更简短」。',
      placeholder: '更毒舌一点',
      multiline: true,
      okText: '开始调整'
    }).then(function (text) {
      var instruction = String(text || '').trim();
      if (!instruction) return null;
      runLike(guide, model, instruction);
      return null;
    }).catch(function (err) {
      console.error('[characterEdit] 输入修改意见失败', err);
    });
  }

  function runLike(guide, model, instruction) {
    if (state.busy) return;
    state.busy = true;
    render();

    var ctx = {
      card: Kit.clone(state.card),
      instruction: instruction,
      type: state.card.type,
      provider: guide,
      model: model,
      timeoutMs: P && P.TIMEOUT_MS ? P.TIMEOUT_MS : 60000
    };

    P.rewriteCharacter(ctx).then(function (res) {
      state.busy = false;
      if (state.destroyed) return;
      if (!res || !res.ok || !res.card) {
        UI.toast('AI 调整失败：' + ((res && res.error && res.error.message) || '未知错误'), 'error');
        render();
        return;
      }
      var old = state.card;
      var next = res.card;
      // 保留 id / 时间 / 生成信息
      next.id = old.id;
      next.createdAt = old.createdAt;
      next.avatar = old.avatar || next.avatar;
      state.card = next;
      if (state.page) state.page.setTitle('编辑角色');
      render();
      UI.toast('已按意见调整，记得保存', 'ok');
    }).catch(function (err) {
      state.busy = false;
      console.error('[characterEdit] AI 调整失败', err);
      UI.toast('AI 调整失败：' + ((err && err.message) || '未知错误'), 'error');
      render();
    });
  }

  /* ------------------------------------------------------------
   * 保存
   * ---------------------------------------------------------- */

  function validate() {
    var card = state.card;
    if (!String(card.name || '').trim()) {
      UI.toast('请填写角色名称', 'error');
      return false;
    }
    if (card.type === 'assistant') {
      if (!String(card.domain || '').trim()) {
        UI.toast('领域助手需要填写领域', 'error');
        return false;
      }
      if (!(card.specialty || []).filter(Boolean).length) {
        UI.toast('请至少填写一个专业方向', 'error');
        return false;
      }
    } else if (!String(card.personality || '').trim()) {
      UI.toast('请至少写一句角色性格', 'error');
      return false;
    }
    return true;
  }

  // opts.stay === true：保存后停留在当前页（问候语弹窗保存时用）
  function saveCard(opts) {
    if (state.busy) return Promise.resolve(null);
    if (!state.card || !validate()) return Promise.resolve(null);
    var stay = !!(opts && opts.stay === true);

    var card = state.card;
    var now = Kit.now();

    // 字段变化过（systemPrompt 被清空）或用户没改过 systemPrompt → 重建
    if (!card.systemPrompt || (card.fieldOrigin || {}).systemPrompt !== 'user') {
      card.systemPrompt = Kit.rebuildSystemPrompt(card) || card.systemPrompt || '';
    }
    card.updatedAt = now;
    if (!card.createdAt) card.createdAt = now;

    state.busy = true;
    render();

    return DB.put('characters', card).then(function () {
      state.busy = false;
      Kit.notifyData('characters');
      UI.toast('已保存', 'ok');
      if (stay) {
        render();  // 停留时刷新页面（如「首选 + N 条备选」副标题）
      } else {
        try { App.Router.pop(); } catch (e) { /* 忽略 */ }
      }
      return null;
    }).catch(function (err) {
      state.busy = false;
      console.error('[characterEdit] 保存失败', err);
      UI.toast('保存失败：' + ((err && err.message) || '未知错误'), 'error');
      render();
      return null;
    });
  }

  /* ------------------------------------------------------------
   * 页面注册
   * ---------------------------------------------------------- */

  App.Router.register(PAGE, {
    title: '编辑角色',
    build: function (root, params, page) {
      state.root = root;
      state.page = page;
      state.destroyed = false;
      state.busy = false;
      state.loaded = false;
      state.images = [];
      state.imgBusy = false;
      state.imgModal = null;
      state.imgGridBox = null;
      state.imgCountEl = null;
      state.greetModal = null;
      state.id = (params && params.id) || '';

      page.setTitle('编辑角色');

      page.onDestroy(function () {
        state.destroyed = true;
        closeGreetModal();
        if (state.imgModal) {
          try { state.imgModal.close(); } catch (e) { /* 忽略 */ }
          state.imgModal = null;
        }
        state.imgGridBox = null;
        state.imgCountEl = null;
      });

      if (!state.id) {
        UI.clear(root);
        root.appendChild(UI.errorState({
          title: '缺少角色参数',
          desc: '没有指定要编辑的角色，请返回列表重试。',
          actionText: '返回',
          onAction: function () { App.Router.pop(); }
        }));
        return Promise.resolve();
      }

      return Promise.all([
        DB.get('characters', state.id),
        Kit.loadWorldviews(),
        Kit.loadProviders()
      ]).then(function (arr) {
        if (state.destroyed) return;
        var card = arr[0];
        var wv = arr[1] || {};
        state.presets = wv.presets || [];
        state.userWvs = wv.users || [];
        state.providers = arr[2] || [];

        if (!card) {
          UI.clear(root);
          root.appendChild(UI.errorState({
            title: '角色不存在',
            desc: '这个角色可能已经被删除了。',
            actionText: '返回列表',
            onAction: function () { App.Router.pop(); }
          }));
          return;
        }

        state.card = Kit.clone(card);
        if (!state.card.fieldOrigin) state.card.fieldOrigin = {};
        if (!Array.isArray(state.card.specialty)) state.card.specialty = [];
        if (!Array.isArray(state.card.duties)) state.card.duties = [];
        if (!Array.isArray(state.card.exampleDialogues)) state.card.exampleDialogues = [];
        state.loaded = true;

        page.setTitle('编辑角色');
        return loadImages().then(function (rows) {
          if (state.destroyed) return null;
          state.images = rows || [];
          render();
          return null;
        });
      }).catch(function (err) {
        console.error('[characterEdit] 加载失败', err);
        if (state.destroyed) return;
        UI.clear(root);
        root.appendChild(UI.errorState({
          title: '加载失败',
          desc: (err && err.message) || '读取角色数据失败，请重试。',
          actionText: '重试',
          onAction: function () { App.Router.replace(PAGE, { id: state.id }); }
        }));
      });
    }
  });
})();
