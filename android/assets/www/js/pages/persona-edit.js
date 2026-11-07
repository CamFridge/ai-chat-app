/* persona-edit.js —— 新建 / 编辑「我的身份」
 * 入口：身份列表页点一行（编辑）或点「新建身份」（新建）→ Router.push('personaEdit', {id})
 * 字段：名字（必填）、头像（相册选图，存 dataUri）、设定描述
 */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var UI = App.UI;
  var U = App.Util;
  var DB = App.DB;
  var Router = App.Router;

  var PAGE = 'personaEdit';

  var state = {
    root: null,
    page: null,
    id: '',
    loading: false,
    error: null,
    busy: false,
    avatarBusy: false,
    destroyed: false,
    buildId: 0,
    form: { name: '', description: '', avatar: '', createdAt: 0 }
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

  function personaModule() {
    return App.Persona && typeof App.Persona.list === 'function' ? App.Persona : null;
  }

  function mediaModule() {
    return App.Media && typeof App.Media.pickImage === 'function' ? App.Media : null;
  }

  function isNew() {
    return !state.id;
  }

  /* ---------------- 加载 ---------------- */

  function load() {
    if (state.destroyed) return Promise.resolve(null);
    if (isNew()) {
      state.loading = false;
      state.error = null;
      render();
      return Promise.resolve(null);
    }
    state.loading = true;
    state.error = null;
    render();

    return Promise.resolve(DB.get('personas', String(state.id)))
      .then(function (rec) {
        if (state.destroyed) return null;
        if (!rec) {
          state.loading = false;
          state.error = new Error('这个身份不存在，可能已经被删除了');
          render();
          return null;
        }
        state.form = {
          name: rec.name || '',
          description: rec.description || '',
          avatar: rec.avatar || '',
          createdAt: rec.createdAt || 0
        };
        state.loading = false;
        state.error = null;
        render();
        return null;
      })
      .catch(function (err) {
        if (state.destroyed) return null;
        console.error('[personaEdit] 读取身份失败', err);
        state.loading = false;
        state.error = err;
        render();
        return null;
      });
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    if (!state.root || state.destroyed) return;
    UI.clear(state.root);
    state.root.classList.add('persona-edit-page');

    if (state.loading) {
      var loadingBox = el('div', { class: 'persona-status' });
      state.root.appendChild(loadingBox);
      try {
        UI.loading(loadingBox, '正在读取身份…');
      } catch (e) {
        loadingBox.appendChild(el('div', { class: 'loading', text: '正在读取身份…' }));
      }
      return;
    }

    if (state.error) {
      state.root.appendChild(
        UI.errorState({
          title: '身份加载失败',
          desc: errText(state.error),
          actionText: '返回',
          onAction: back
        })
      );
      return;
    }

    var scroll = el('div', { class: 'page-scroll' }, avatarCard(), formEl());
    state.root.appendChild(scroll);
    state.root.appendChild(actionsEl());
  }

  function avatarCard() {
    var avatar = UI.avatar(state.form.name || '我', state.form.avatar, 'xl');

    var pickBtn = el('button', {
      class: 'btn ghost small persona-avatar-pick',
      attrs: { type: 'button' },
      text: state.avatarBusy ? '选择中…' : '从相册选择'
    });
    pickBtn.addEventListener('click', function () {
      pickAvatar();
    });

    var clearBtn = state.form.avatar
      ? el('button', { class: 'btn ghost small persona-avatar-clear', attrs: { type: 'button' }, text: '清除头像' })
      : null;
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        state.form.avatar = '';
        render();
        toast('已清除头像');
      });
    }

    return el(
      'div',
      { class: 'persona-avatar-card' },
      avatar,
      el(
        'div',
        { class: 'persona-avatar-main' },
        el('div', { class: 'persona-avatar-title', text: isNew() ? '新建我的身份' : '编辑我的身份' }),
        el('div', {
          class: 'persona-avatar-hint',
          text: '头像会显示在身份列表里；不设置则用名字的第一个字。'
        }),
        el('div', { class: 'persona-avatar-actions' }, pickBtn, clearBtn)
      )
    );
  }

  function formEl() {
    var nameInput = el('input', {
      class: 'input',
      attrs: { type: 'text', placeholder: '例如：小明、旅人、我', maxlength: '24', 'aria-label': '名字' },
      value: state.form.name
    });
    nameInput.addEventListener('input', function () {
      state.form.name = nameInput.value;
    });

    var nameField = el(
      'div',
      { class: 'field persona-field-name' },
      el('label', { text: '名字（必填）' }),
      nameInput
    );

    var descInput = el('textarea', {
      class: 'textarea',
      attrs: { placeholder: '例如：一个在江湖里行走的年轻剑客，说话直来直去', rows: '4', 'aria-label': '设定描述' },
      value: state.form.description
    });
    descInput.addEventListener('input', function () {
      state.form.description = descInput.value;
    });

    var descField = el(
      'div',
      { class: 'field persona-field-desc' },
      el('label', { text: '设定描述' }),
      descInput,
      el('div', {
        class: 'hint',
        text: '一两句话即可。聊天时角色会知道「你是谁」，例如身份、性格、和角色的关系。'
      })
    );

    return el('div', { class: 'form persona-form' }, nameField, descField);
  }

  function actionsEl() {
    var saveBtn = el('button', {
      class: 'btn primary persona-save-btn',
      attrs: { type: 'button' },
      text: state.busy ? '保存中…' : '保存'
    });
    saveBtn.addEventListener('click', function () {
      save();
    });
    if (state.busy) saveBtn.setAttribute('disabled', 'disabled');

    var buttons = [saveBtn];
    if (!isNew()) {
      var delBtn = el('button', {
        class: 'btn danger persona-delete-btn',
        attrs: { type: 'button' },
        text: '删除'
      });
      delBtn.addEventListener('click', function () {
        remove();
      });
      if (state.busy) delBtn.setAttribute('disabled', 'disabled');
      buttons.unshift(delBtn);
    }

    var wrap = el('div', { class: 'page-actions persona-actions' });
    buttons.forEach(function (b) {
      wrap.appendChild(b);
    });
    return wrap;
  }

  /* ---------------- 操作 ---------------- */

  function back() {
    try {
      Promise.resolve(Router.pop()).catch(function () {
        Router.tab('settings');
      });
    } catch (e) {
      console.error('[personaEdit] 返回失败', e);
    }
  }

  function pickAvatar() {
    if (state.avatarBusy || state.busy) return;
    var M = mediaModule();
    if (!M) {
      toast('图片功能暂不可用，请稍后重试', 'error');
      return;
    }
    state.avatarBusy = true;
    render();

    Promise.resolve(M.pickImage({ maxSide: 1024, quality: 88 }))
      .then(function (att) {
        state.avatarBusy = false;
        if (!att) {
          // 用户取消：恢复按钮文案
          render();
          return null;
        }
        state.form.avatar = att.dataUri || '';
        render();
        if (!state.form.avatar) toast('这张图片无法作为头像使用', 'error');
        return null;
      })
      .catch(function (err) {
        state.avatarBusy = false;
        console.error('[personaEdit] 选择头像失败', err);
        render();
        toast('选择头像失败：' + errText(err), 'error');
        return null;
      });
  }

  function save() {
    if (state.busy) return;
    var name = String(state.form.name || '').trim();
    var nameField = state.root ? state.root.querySelector('.persona-field-name') : null;
    if (nameField) nameField.classList.remove('error');
    if (!name) {
      if (nameField) nameField.classList.add('error');
      toast('名字不能为空', 'error');
      return;
    }
    if (name.length > 24) {
      toast('名字太长了（最多 24 个字）', 'error');
      return;
    }

    state.busy = true;
    render();

    var data = {
      name: name,
      description: String(state.form.description || '').trim(),
      avatar: state.form.avatar || ''
    };
    if (!isNew()) data.id = state.id;
    if (!isNew() && state.form.createdAt) data.createdAt = state.form.createdAt;

    var P = personaModule();
    var saving = P && typeof P.save === 'function'
      ? Promise.resolve(P.save(data))
      : Promise.resolve(DB.put('personas', data));

    saving
      .then(function (rec) {
        if (!rec) throw new Error('保存失败');
        state.id = rec.id;
        var ts = Date.now();
        state.form.createdAt = rec.createdAt || ts;
        // 没有默认身份时（第一次使用 / 默认被删）把这一条设为默认
        if (P && typeof P.getDefaultId === 'function' && typeof P.setDefault === 'function') {
          return Promise.resolve(P.getDefaultId())
            .then(function (defaultId) {
              if (defaultId) return null;
              return Promise.resolve(P.setDefault(rec.id));
            })
            .catch(function (err) {
              console.error('[personaEdit] 设置默认身份失败', err);
              return null;
            });
        }
        return null;
      })
      .then(function () {
        state.busy = false;
        toast('已保存', 'ok');
        back();
        return null;
      })
      .catch(function (err) {
        state.busy = false;
        console.error('[personaEdit] 保存身份失败', err);
        render();
        toast('保存失败：' + errText(err), 'error');
        return null;
      });
  }

  function remove() {
    if (state.busy || isNew()) return;
    var name = String(state.form.name || '').trim() || '我';
    Promise.resolve(
      UI.confirm({
        title: '删除身份',
        message: '删除「' + name + '」后不可恢复，使用这个身份的会话会改用匿名「我」。',
        okText: '删除',
        danger: true
      })
    )
      .then(function (ok) {
        if (!ok) return null;
        state.busy = true;
        render();
        var P = personaModule();
        var removing = P && typeof P.remove === 'function'
          ? Promise.resolve(P.remove(state.id))
          : Promise.resolve(DB.del('personas', state.id));
        return removing
          .then(function () {
            state.busy = false;
            toast('已删除身份', 'ok');
            back();
            return null;
          })
          .catch(function (err) {
            state.busy = false;
            console.error('[personaEdit] 删除身份失败', err);
            render();
            toast('删除失败：' + errText(err), 'error');
            return null;
          });
      })
      .catch(function (err) {
        state.busy = false;
        console.error('[personaEdit] 删除身份失败', err);
        toast('删除失败：' + errText(err), 'error');
        return null;
      });
  }

  /* ---------------- 页面注册 ---------------- */

  Router.register(PAGE, {
    tab: false,
    title: '我的身份',

    build: function (root, params, page) {
      state.root = root;
      state.page = page;
      state.destroyed = false;
      state.buildId = (state.buildId || 0) + 1;
      state.id = (params && params.id) ? String(params.id) : '';
      state.loading = !isNew();
      state.error = null;
      state.busy = false;
      state.avatarBusy = false;
      state.form = { name: '', description: '', avatar: '', createdAt: 0 };

      try {
        page.setTitle(isNew() ? '新建身份' : '编辑身份');
      } catch (e) {
        /* 忽略 */
      }

      page.onDestroy(function () {
        state.destroyed = true;
      });

      return load();
    }
  });
})();
