/* ui.js —— App.UI：DOM 构造、图标、Toast/Modal/Sheet、主题、状态组件 */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var UI = App.UI = {};

  /* ============================ 图标 ============================ */
  var ICONS = {
    chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    character: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    api: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
    settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    back: '<polyline points="15 18 9 12 15 6"/>',
    chev: '<polyline points="9 18 15 12 9 6"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    delete: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pin: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    world: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    guide: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
    arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    bot: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><line x1="8" y1="16" x2="8.01" y2="16"/><line x1="16" y1="16" x2="16.01" y2="16"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    time: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    spark: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    add: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'
  };

  var ICON_ALIAS = { '新增': 'plus', 'new': 'plus', 'trash': 'delete', 'world': 'world', 'globe': 'globe' };

  UI.icon = function (name, size) {
    var key = ICON_ALIAS[name] || name || 'info';
    var body = ICONS[key] || ICONS.info;
    var s = size || 22;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  };
  UI.iconNames = Object.keys(ICONS);

  /* ============================ DOM 构造 ============================ */
  function applyAttrs(el, attrs) {
    if (!attrs) return;
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class' || k === 'className') { el.className = (el.className ? el.className + ' ' : '') + v; return; }
      if (k === 'text') { el.textContent = String(v); return; }
      if (k === 'html') { el.innerHTML = String(v); return; }
      if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.keys(v).forEach(function (p) { el.style[p] = v[p]; });
        return;
      }
      if (k === 'dataset') { Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; }); return; }
      if (k === 'on') { Object.keys(v).forEach(function (evt) { if (typeof v[evt] === 'function') el.addEventListener(evt, v[evt]); }); return; }
      if (k === 'attrs') { Object.keys(v).forEach(function (a) { if (v[a] === true) el.setAttribute(a, ''); else if (v[a] !== false && v[a] !== null) el.setAttribute(a, v[a]); }); return; }
      if (k === 'value') { el.value = v; return; }
      if (k === 'checked') { el.checked = !!v; return; }
      if (k === 'disabled') { el.disabled = !!v; return; }
      el.setAttribute(k, v);
    });
  }

  function appendChildren(el, children) {
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) { appendChildren(el, child); return; }
      if (typeof child === 'string' || typeof child === 'number') { el.appendChild(document.createTextNode(String(child))); return; }
      if (child instanceof Node) { el.appendChild(child); return; }
    });
  }

  UI.el = function (tag, attrs) {
    var el = document.createElement(tag || 'div');
    applyAttrs(el, attrs);
    appendChildren(el, Array.prototype.slice.call(arguments, 2));
    return el;
  };

  UI.frag = function () {
    var f = document.createDocumentFragment();
    appendChildren(f, Array.prototype.slice.call(arguments, 0));
    return f;
  };

  UI.spinnerEl = function (cls) { return UI.el('span', { class: 'spinner' + (cls ? ' ' + cls : '') }); };
  UI.clear = function (node) { if (node) while (node.firstChild) node.removeChild(node.firstChild); return node; };

  /* ============================ 头像 ============================ */
  function hashColor(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return 'hsl(' + h + ',42%,46%)';
  }
  UI.avatar = function (name, uri, size) {
    var cls = 'avatar' + (size && size !== 'md' ? ' ' + size : '');
    var el = UI.el('div', { class: cls, 'aria-hidden': 'true' });
    var isImg = uri && /^(data:image\/|https?:\/\/|file:)/i.test(String(uri));
    if (isImg) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = uri;
      img.onerror = function () {
        el.innerHTML = '';
        el.textContent = App.Util.initial(name);
        el.style.background = hashColor(String(name || '?'));
      };
      el.appendChild(img);
    } else {
      el.textContent = App.Util.initial(name);
      el.style.background = hashColor(String(name || '?'));
    }
    return el;
  };

  /* ============================ 浮层管理 ============================ */
  var overlays = [];

  function overlayRoot() {
    return document.getElementById('overlay-root') || document.body;
  }

  function pushOverlay(item) {
    overlays.push(item);
    item.node.setAttribute('data-overlay', '1');
    overlayRoot().appendChild(item.node);
    return item;
  }

  function removeOverlay(item, skipAnim) {
    var idx = overlays.indexOf(item);
    if (idx >= 0) overlays.splice(idx, 1);
    if (!item || !item.node) return;
    if (skipAnim) { if (item.node.parentNode) item.node.parentNode.removeChild(item.node); return; }
    item.node.classList.remove('show');
    setTimeout(function () {
      if (item.node && item.node.parentNode) item.node.parentNode.removeChild(item.node);
    }, 180);
  }

  UI.closeTopOverlay = function () {
    for (var i = overlays.length - 1; i >= 0; i--) {
      var o = overlays[i];
      if (o.dismissible !== false) { try { o.close(); } catch (e) {} return true; }
    }
    return false;
  };
  UI.hasOverlay = function () { return overlays.length > 0; };

  /* ============================ Modal ============================ */
  UI.modal = function (opts) {
    opts = opts || {};
    var mask = UI.el('div', { class: 'overlay-mask' });
    var wrap = UI.el('div', { class: 'modal-wrap' }, mask);
    var box = UI.el('div', { class: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true' } });
    mask.appendChild(box);

    if (opts.title) box.appendChild(UI.el('div', { class: 'modal-head', text: opts.title }));
    var body = UI.el('div', { class: 'modal-body' + (opts.alignLeft ? ' left' : '') });
    if (opts.content) {
      if (opts.content instanceof Node) body.appendChild(opts.content);
      else body.innerHTML = String(opts.content);
    }
    box.appendChild(body);
    var foot = null;
    if (opts.actions && opts.actions.length) {
      foot = UI.el('div', { class: 'modal-foot' });
      opts.actions.slice(0, 2).forEach(function (a) {
        var b = UI.el('button', { class: 'btn ' + (a.class || ''), type: 'button', text: a.text || '确定' });
        b.addEventListener('click', function (ev) {
          ev.preventDefault();
          if (a.onClick) { try { a.onClick(handle.close, ev); } catch (e) { console.error(e); } }
          else handle.close();
        });
        foot.appendChild(b);
      });
      box.appendChild(foot);
    }

    var handle = {
      node: wrap, box: body, el: box, close: function () {
        removeOverlay(handle);
        if (opts.onClose) { try { opts.onClose(); } catch (e) {} }
      }
    };
    wrap.addEventListener('click', function (ev) {
      if (ev.target === wrap && opts.dismissible !== false) handle.close();
    });
    pushOverlay(handle);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
    return handle;
  };

  /* ============================ Sheet ============================ */
  UI.sheet = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var mask = UI.el('div', { class: 'overlay-mask' });
      var wrap = UI.el('div', { class: 'sheet-wrap', style: { position: 'fixed', inset: '0', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } }, mask);
      var sheet = UI.el('div', { class: 'sheet' });
      if (opts.title) sheet.appendChild(UI.el('div', { class: 'sheet-head', text: opts.title }));
      var list = UI.el('div', { class: 'sheet-list' });
      (opts.items || []).forEach(function (it) {
        var row = UI.el('button', { class: 'sheet-item' + (it.danger ? ' danger' : ''), type: 'button' });
        if (it.danger) row.classList.add('danger');
        if (it.icon) {
          var ic = UI.el('span', { class: 'sheet-icon', html: UI.icon(it.icon) });
          row.appendChild(ic);
        }
        var main = UI.el('span', { class: 'grow' }, UI.el('span', { text: it.label || '' }));
        if (it.desc) main.appendChild(UI.el('span', { class: 'sheet-desc', text: it.desc }));
        row.appendChild(main);
        if (opts.selected !== undefined && it.id === opts.selected) row.appendChild(UI.el('span', { class: 'side', html: UI.icon('check') }));
        row.addEventListener('click', function () {
          finish(it);
        });
        list.appendChild(row);
      });
      sheet.appendChild(list);
      sheet.appendChild(UI.el('button', { class: 'sheet-cancel', type: 'button', text: opts.cancelText || '取消', on: { click: function () { finish(null); } } }));
      wrap.appendChild(sheet);

      var handle = {
        node: wrap, sheet: sheet, dismissible: opts.dismissible !== false,
        close: function () { finish(null, true); },
        update: function (next) {
          UI.clear(list);
          (next || []).forEach(function (it) {
            var row = UI.el('button', { class: 'sheet-item' + (it.danger ? ' danger' : ''), type: 'button' });
            row.appendChild(UI.el('span', { class: 'grow', text: it.label || '' }));
            row.addEventListener('click', function () { finish(it); });
            list.appendChild(row);
          });
        }
      };

      var settled = false;
      function finish(item, silent) {
        if (settled) return;
        settled = true;
        removeOverlay(handle);
        if (!silent) resolve(item);
        else resolve(null);
      }
      mask.addEventListener('click', function () { if (opts.dismissible !== false) finish(null); });
      pushOverlay(handle);
      requestAnimationFrame(function () { wrap.classList.add('show'); });
    });
  };

  /* ============================ Toast ============================ */
  var toastWrap = null;
  UI.toast = function (text, type, duration) {
    if (!text) return;
    if (!toastWrap || !toastWrap.parentNode) {
      toastWrap = UI.el('div', { class: 'toast-wrap' });
      document.body.appendChild(toastWrap);
    }
    var t = UI.el('div', { class: 'toast' + (type === 'error' ? ' err' : type === 'ok' ? ' ok' : ''), text: String(text) });
    toastWrap.appendChild(t);
    var ms = duration || (type === 'error' ? 3200 : 2000);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
    }, ms);
  };

  /* ============================ Confirm / Prompt ============================ */
  UI.confirm = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      var m = UI.modal({
        title: opts.title || '提示',
        content: opts.message ? UI.el('div', { text: opts.message }) : null,
        dismissible: opts.dismissible !== false,
        onClose: function () { if (!settled) { settled = true; resolve(false); } },
        actions: [
          {
            text: opts.cancelText || '取消', class: '', onClick: function (close) { close(); }
          },
          {
            text: opts.okText || '确定', class: opts.danger ? 'danger' : 'primary', onClick: function (close) {
              settled = true; close(); resolve(true);
            }
          }
        ]
      });
    });
  };

  UI.prompt = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      var input;
      if (opts.multiline) {
        input = UI.el('textarea', { class: 'textarea', attrs: { placeholder: opts.placeholder || '' }, value: opts.value || '' });
      } else {
        input = UI.el('input', { class: 'input', attrs: { placeholder: opts.placeholder || '', inputmode: opts.inputMode || 'text' }, value: opts.value || '' });
      }
      var content = UI.el('div', null, opts.message ? UI.el('div', { class: 'small', style: { marginBottom: '2px' }, text: opts.message }) : null, input);
      function done(ok) {
        if (settled) return;
        settled = true;
        var v = String(input.value || '').trim();
        m.close();
        resolve(ok ? v : null);
      }
      var m = UI.modal({
        title: opts.title || '输入',
        alignLeft: true,
        content: content,
        dismissible: opts.dismissible !== false,
        onClose: function () { if (!settled) { settled = true; resolve(null); } },
        actions: [
          { text: opts.cancelText || '取消', onClick: function () { done(false); } },
          { text: opts.okText || '确定', class: 'primary', onClick: function () { done(true); } }
        ]
      });
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) {} }, 60);
      if (!opts.multiline) {
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); done(true); }
          if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
        });
      }
    });
  };

  /* ============================ 状态组件 ============================ */
  UI.empty = function (opts) {
    opts = opts || {};
    var box = UI.el('div', { class: 'empty' });
    if (opts.icon) box.appendChild(UI.el('div', { class: 'empty-icon', html: UI.icon(opts.icon, 56) }));
    if (opts.title) box.appendChild(UI.el('div', { class: 'empty-title', text: opts.title }));
    if (opts.desc) box.appendChild(UI.el('div', { class: 'empty-desc', text: opts.desc }));
    if (opts.actionText) {
      box.appendChild(UI.el('button', { class: 'btn primary small', type: 'button', text: opts.actionText, on: { click: function () { if (opts.onAction) opts.onAction(); } } }));
    }
    return box;
  };

  UI.loading = function (container, text) {
    var box = UI.el('div', { class: 'loading' }, UI.spinnerEl(), UI.el('span', { text: text || '加载中…' }));
    if (container) container.appendChild(box);
    return {
      el: box,
      remove: function () { if (box.parentNode) box.parentNode.removeChild(box); },
      setText: function (t) { box.lastChild.textContent = t; }
    };
  };

  UI.errorState = function (opts) {
    opts = opts || {};
    var box = UI.el('div', { class: 'empty' });
    box.appendChild(UI.el('div', { class: 'empty-icon', html: UI.icon(opts.icon || 'warning', 56) }));
    box.appendChild(UI.el('div', { class: 'empty-title', text: opts.title || '出错了' }));
    if (opts.desc) box.appendChild(UI.el('div', { class: 'empty-desc', text: opts.desc }));
    if (opts.actionText) {
      box.appendChild(UI.el('button', {
        class: 'btn small primary', type: 'button', text: opts.actionText,
        on: { click: function () { if (opts.onAction) opts.onAction(); } }
      }));
    }
    return box;
  };

  UI.statusPill = function (text, type) {
    var cls = type === 'ok' ? 'green' : type === 'error' ? 'red' : type === 'warn' ? 'orange' : '';
    return UI.el('span', { class: 'badge ' + cls, text: text || '' });
  };

  UI.pageError = function (err) {
    var info = { title: '出错了', desc: (err && err.message) || String(err || '未知错误') };
    if (App.API && App.API.errorInfo) {
      try {
        var ei = App.API.errorInfo(err);
        info = { title: ei.title, desc: ei.hint };
      } catch (e) {}
    }
    return UI.errorState({ title: info.title, desc: info.desc });
  };

  /* ============================ 主题 ============================ */
  var THEMES = ['light', 'dark', 'amoled'];
  UI.themes = THEMES;
  UI.theme = function () {
    var t = document.documentElement.getAttribute('data-theme');
    return THEMES.indexOf(t) >= 0 ? t : 'light';
  };
  UI.setTheme = function (name) {
    var t = THEMES.indexOf(name) >= 0 ? name : 'light';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('aichat.theme', t); } catch (e) {}
    if (App.Bridge && App.Bridge.available) {
      App.Bridge.call('ui.statusBar', { dark: t !== 'light', color: t === 'light' ? '#ededed' : t === 'amoled' ? '#000000' : '#1c1c1e' }).catch(function () {});
    }
    if (App.DB && App.DB.settings) App.DB.settings.set('theme', t).catch(function () {});
    return Promise.resolve(t);
  };
  UI.applyStoredTheme = function () {
    return App.DB.settings.get('theme', null).then(function (t) {
      if (t && THEMES.indexOf(t) >= 0) {
        document.documentElement.setAttribute('data-theme', t);
        try { localStorage.setItem('aichat.theme', t); } catch (e) {}
      }
      return UI.theme();
    }).catch(function () { return UI.theme(); });
  };

  /* ============================ 便捷：从 HTML 字符串建节点 ============================ */
  UI.html = function (str, tag) {
    var wrap = document.createElement(tag || 'div');
    wrap.innerHTML = String(str || '');
    return wrap.firstElementChild || wrap;
  };
})();
