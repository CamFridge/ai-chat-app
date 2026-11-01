/* ============================================================
 * style.js —— 聊天界面外观（v1.3.0）
 * - 聊天界面样式：wechat（默认微信）/ imessage / qq
 * - 自定义聊天背景（可选，data URI 存 settings.chat_bg）
 * - 我的头像（可选，data URI 存 settings.user_avatar）
 * 通过 body[data-chat-style] + CSS 变量统一生效；启动时尽早 apply，避免闪一下。
 * ============================================================ */
(function () {
  'use strict';

  var App = (window.App = window.App || {});
  var STYLES = [
    { id: 'wechat', name: '微信', desc: '绿色气泡，默认样式' },
    { id: 'imessage', name: 'iMessage', desc: '蓝色气泡、无头像的简洁风格' },
    { id: 'qq', name: 'QQ', desc: '蓝色主题、小圆角气泡' }
  ];
  var DEFAULTS = { style: 'wechat', bg: '', avatar: '' };
  var cfg = { style: DEFAULTS.style, bg: DEFAULTS.bg, avatar: DEFAULTS.avatar };
  var loaded = false;

  function isStyle(id) {
    for (var i = 0; i < STYLES.length; i++) if (STYLES[i].id === id) return true;
    return false;
  }

  function bgCss(uri) {
    if (!uri) return 'none';
    return 'url("' + String(uri).replace(/"/g, '%22') + '")';
  }

  function apply() {
    try {
      var body = document.body;
      if (!body) return;
      body.setAttribute('data-chat-style', cfg.style);
      body.style.setProperty('--chat-bg-image', bgCss(cfg.bg));
      body.classList.toggle('has-chat-bg', !!cfg.bg);
      body.classList.toggle('has-user-avatar', !!cfg.avatar);
    } catch (e) { /* 忽略 */ }
  }

  function readSettings() {
    var D = App.DB;
    if (!D) return Promise.resolve(DEFAULTS);
    return D.settings.getMany(['chat_style', 'chat_bg', 'user_avatar']).then(function (map) {
      map = map || {};
      return {
        style: isStyle(map.chat_style) ? map.chat_style : DEFAULTS.style,
        bg: typeof map.chat_bg === 'string' ? map.chat_bg : '',
        avatar: typeof map.user_avatar === 'string' ? map.user_avatar : ''
      };
    }).catch(function () { return DEFAULTS; });
  }

  function persist(key, value) {
    if (!App.DB || !App.DB.settings) return Promise.resolve();
    return App.DB.settings.set(key, value).catch(function (e) {
      console.error('[style] 保存失败', e);
    });
  }

  var S = {
    STYLES: STYLES,
    DEFAULTS: DEFAULTS,
    init: function () {
      apply();
      return readSettings().then(function (next) {
        cfg = next;
        loaded = true;
        apply();
        return S;
      });
    },
    apply: apply,
    isLoaded: function () { return loaded; },
    getStyle: function () { return cfg.style; },
    setStyle: function (id) {
      var next = isStyle(id) ? id : DEFAULTS.style;
      cfg.style = next;
      apply();
      if (App.UI && App.UI.setNavStyle) App.UI.setNavStyle(next);
      return persist('chat_style', next);
    },
    getBackground: function () { return cfg.bg; },
    setBackground: function (dataUri) {
      cfg.bg = typeof dataUri === 'string' ? dataUri : '';
      apply();
      return persist('chat_bg', cfg.bg);
    },
    clearBackground: function () { return S.setBackground(''); },
    getUserAvatar: function () { return cfg.avatar; },
    setUserAvatar: function (dataUri) {
      cfg.avatar = typeof dataUri === 'string' ? dataUri : '';
      apply();
      return persist('user_avatar', cfg.avatar);
    },
    clearUserAvatar: function () { return S.setUserAvatar(''); },
    styleName: function (id) {
      for (var i = 0; i < STYLES.length; i++) if (STYLES[i].id === id) return STYLES[i].name;
      return STYLES[0].name;
    }
  };

  App.Style = S;
})();
