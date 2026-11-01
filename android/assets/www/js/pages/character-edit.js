/* ============================================================
 * pages/character-edit.js —— 编辑角色（二级页）
 * 参数：{ id } 角色 id
 *
 * 功能：
 *   - 编辑全部字段（陪聊 / 助手各自显示对应字段）；
 *   - 类型可切换，但需要二次确认，并提示部分字段会重置；
 *   - 保存落库（保留 id / createdAt，重建 systemPrompt）；
 *   - 「让它更像…」：可选，固定用引导 API 按意见微调。
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

    // 类型专属字段
    var keys = state.card.type === 'assistant' ? ASSISTANT_KEYS : COMPANION_KEYS;
    keys.forEach(function (key) {
      var def = fieldDef(key, state.card.type);
      if (!def) return;
      list.appendChild(fieldRow(key, def.label, state.card[key], def));
    });

    // 开场白（两类共有）
    list.appendChild(fieldRow('firstMessage', '开场白', state.card.firstMessage, { multiline: true }));

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

  function saveCard() {
    if (state.busy) return Promise.resolve(null);
    if (!state.card || !validate()) return Promise.resolve(null);

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
      try { App.Router.pop(); } catch (e) { /* 忽略 */ }
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
      state.id = (params && params.id) || '';

      page.setTitle('编辑角色');

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
        render();
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
