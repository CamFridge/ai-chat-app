/* tavern.js —— App.Tavern：SillyTavern / TavernAI V2 角色卡导入导出
 * 说明：本文件在 ui.js / prompts.js 之前加载，因此所有 UI / DB / Prompts 依赖都必须在
 *      函数调用时动态获取，不能在文件顶层缓存。
 */
(function () {
  'use strict';

  var App = window.App = window.App || {};
  var T = App.Tavern = {};

  var SPEC_V2 = 'chara_card_v2';
  var SPEC_V3 = 'chara_card_v3';
  var SPEC_VERSION = '2.0';
  var MAX_IMPORT_BYTES = 2 * 1024 * 1024;   // 2MB（与提示文案保持一致）
  var MAX_ALT_GREETINGS = 10;
  var MAX_DIALOGUES = 20;
  var MAX_FILE_NAME = 40;
  var IMPORT_TIMEOUT = 300000;              // 用户挑文件可能比较慢，给 5 分钟

  var importing = false;

  /* ------------------------------------------------------------------ *
   *  基础小工具
   * ------------------------------------------------------------------ */

  function str(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  }

  function clean(v) {
    return str(v).replace(/^\s+|\s+$/g, '');
  }

  function strArr(v) {
    var out = [];
    if (!Array.isArray(v)) return out;
    for (var i = 0; i < v.length; i++) {
      var s = str(v[i]);
      if (s && s.replace(/\s/g, '')) out.push(s);
    }
    return out;
  }

  function tagsOf(v) {
    if (Array.isArray(v)) return strArr(v);
    var s = str(v);
    if (!s.replace(/\s/g, '')) return [];
    return s.split(/[,，]/).map(function (x) {
      return x.replace(/^\s+|\s+$/g, '');
    }).filter(function (x) { return !!x; });
  }

  function pickField(src, keys) {
    if (!src || typeof src !== 'object') return '';
    for (var i = 0; i < keys.length; i++) {
      var v = str(src[keys[i]]);
      if (v && v.replace(/\s/g, '')) return v;
    }
    return '';
  }

  function errorText(err, fallback) {
    if (typeof err === 'string' && err) return err;
    if (err && typeof err === 'object') {
      if (err.message) return String(err.message);
      if (typeof err.error === 'string' && err.error) return err.error;
      if (err.error && typeof err.error === 'object' && err.error.message) return String(err.error.message);
    }
    return fallback || '未知错误';
  }

  function toast(text, type) {
    if (App.UI && typeof App.UI.toast === 'function') {
      try { App.UI.toast(text, type); return; } catch (e) {}
    }
    console.warn('[tavern] ' + text);
  }

  function truncateText(text, max) {
    var s = str(text);
    if (!s) return '';
    if (s.length <= max) return s;
    if (App.Util && typeof App.Util.truncate === 'function') {
      try {
        var t = App.Util.truncate(s, max);
        if (typeof t === 'string' && t) return t;
      } catch (e) {}
    }
    return s.slice(0, max) + '…';
  }

  function formatBytes(n) {
    if (App.Util && typeof App.Util.bytes === 'function') {
      try {
        var s = App.Util.bytes(n);
        if (typeof s === 'string' && s) return s;
      } catch (e) {}
    }
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (Math.round(n / (1024 * 1024) * 10) / 10) + ' MB';
  }

  function byteLength(text) {
    var s = str(text);
    if (!s) return 0;
    if (typeof Blob === 'function') {
      try { return new Blob([s]).size; } catch (e) {}
    }
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i += 1; }
      else bytes += 3;
    }
    return bytes;
  }

  function safeFileName(name) {
    var s = str(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-');
    s = s.replace(/-{2,}/g, '-');
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/^[\s.\-]+|[\s.\-]+$/g, '');
    if (s.length > MAX_FILE_NAME) {
      s = s.slice(0, MAX_FILE_NAME).replace(/[\s.\-]+$/g, '');
    }
    return s || 'character-card';
  }

  /* ------------------------------------------------------------------ *
   *  角色卡字段规范化
   * ------------------------------------------------------------------ */

  function blankCard(type) {
    var kind = type === 'assistant' ? 'assistant' : 'companion';
    if (App.Data && typeof App.Data.blankCharacter === 'function') {
      try {
        var card = App.Data.blankCharacter(kind);
        if (card && typeof card === 'object') return card;
      } catch (e) {
        console.error('[tavern] blankCharacter 调用失败', e);
      }
    }
    return {
      type: kind, name: '', avatar: '', worldviewId: '', worldviewSnapshot: '',
      personality: '', habits: '', background: '', speechStyle: '', catchphrases: '',
      scenario: '', firstMessage: '', exampleDialogues: [], systemPrompt: '',
      domain: '', specialty: [], duties: [], answerStyle: '', knowledgeBoundary: '',
      refusalPolicy: '', draft: {}, fieldOrigin: {}, generatedAt: 0,
      generationProviderId: '', generationModel: '', createdAt: 0, updatedAt: 0
    };
  }

  function normalizeTavern(tv) {
    var src = (tv && typeof tv === 'object') ? tv : {};
    return {
      creator: clean(src.creator),
      characterVersion: clean(src.characterVersion),
      tags: tagsOf(src.tags),
      creatorNotes: str(src.creatorNotes),
      systemPrompt: str(src.systemPrompt),
      postHistoryInstructions: str(src.postHistoryInstructions)
    };
  }

  function normalizeGender(v) {
    var g = clean(v).toLowerCase();
    if (!g) return '';
    if (g === 'female' || g === 'f' || g === '女' || g === '女性') return 'female';
    if (g === 'male' || g === 'm' || g === '男' || g === '男性') return 'male';
    if (g === 'other' || g === '其他' || g === '非二元') return 'other';
    return '';
  }

  function inferGenderFromTags(tags) {
    var s = strArr(tags).join(' ').toLowerCase();
    if (!s) return '';
    if (/female|女性|女生|女孩|少女|姐姐|妹妹|妈妈|母亲|she\/her/.test(s)) return 'female';
    if (/male|男性|男生|男孩|少年|哥哥|弟弟|爸爸|父亲|he\/him/.test(s)) return 'male';
    return '';
  }

  /* 把 mes_example 文本解析成 [{user, char}] */
  function parseExampleDialogues(raw) {
    var out = [];
    var text = str(raw).replace(/\r\n?/g, '\n');
    if (!text.replace(/\s/g, '')) return out;

    var tokens = [];
    var blocks = text.split(/<START>/gi);
    for (var b = 0; b < blocks.length; b++) {
      var lines = blocks[b].split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/^\s+|\s+$/g, '');
        if (!line) continue;
        var mChar = line.match(/^(?:\{\{char\}\}|<BOT>|<CHAR>|char|assistant|角色)\s*[:：]\s*([\s\S]*)$/i);
        var mUser = line.match(/^(?:\{\{user\}\}|<USER>|<HUMAN>|user|human|用户|我)\s*[:：]\s*([\s\S]*)$/i);
        if (mChar) {
          tokens.push({ role: 'char', text: mChar[1] });
        } else if (mUser) {
          tokens.push({ role: 'user', text: mUser[1] });
        } else if (tokens.length) {
          var lastTok = tokens[tokens.length - 1];
          lastTok.text += (lastTok.text ? '\n' : '') + line;
        }
      }
    }
    if (!tokens.length) return out;

    // 合并相邻同角色台词
    var merged = [];
    for (var t = 0; t < tokens.length; t++) {
      var tk = tokens[t];
      var last = merged[merged.length - 1];
      if (last && last.role === tk.role) {
        last.text += (last.text ? '\n' : '') + tk.text;
      } else {
        merged.push({ role: tk.role, text: tk.text });
      }
    }

    // 组装成「用户 → 角色」的轮次
    var idx = 0;
    while (idx < merged.length && out.length < MAX_DIALOGUES) {
      var cur = merged[idx];
      var next = merged[idx + 1];
      if (cur.role === 'user') {
        if (next && next.role === 'char') {
          out.push({ user: cur.text, char: next.text });
          idx += 2;
        } else {
          out.push({ user: cur.text, char: '' });
          idx += 1;
        }
      } else {
        out.push({ user: '', char: cur.text });
        idx += 1;
      }
    }
    return out.filter(function (d) {
      return (d.user && d.user.replace(/\s/g, '')) || (d.char && d.char.replace(/\s/g, ''));
    });
  }

  function normalizeDialogues(v) {
    var out = [];
    if (!Array.isArray(v)) return out;
    for (var i = 0; i < v.length && out.length < MAX_DIALOGUES; i++) {
      var d = v[i];
      if (d === null || d === undefined) continue;
      var user = '';
      var charLine = '';
      if (typeof d === 'string') {
        var parts = d.replace(/\r\n?/g, '\n').split('\n');
        if (parts.length > 1) {
          user = parts[0];
          charLine = parts.slice(1).join('\n');
        } else {
          charLine = d;
        }
      } else if (typeof d === 'object') {
        user = str(d.user) || str(d.user_message) || str(d.userMessage);
        charLine = str(d.char) || str(d.char_message) || str(d.charMessage);
      }
      if (!(user.replace(/\s/g, '')) && !(charLine.replace(/\s/g, ''))) continue;
      out.push({ user: user, char: charLine });
    }
    return out;
  }

  function buildMesExample(dialogues) {
    var list = normalizeDialogues(dialogues);
    if (!list.length) return '';
    var blocks = [];
    for (var i = 0; i < list.length; i++) {
      var user = str(list[i].user) || '……';
      var charLine = str(list[i].char) || '……';
      blocks.push('<START>\n{{user}}: ' + user + '\n{{char}}: ' + charLine);
    }
    return blocks.join('\n');
  }

  function buildPrompt(card) {
    if (App.Prompts && typeof App.Prompts.buildSystemPrompt === 'function') {
      try {
        var sp = App.Prompts.buildSystemPrompt(card);
        if (typeof sp === 'string' && sp) return sp;
      } catch (e) {
        console.error('[tavern] 生成系统提示失败', e);
      }
    }
    if (App.CharKit && typeof App.CharKit.rebuildSystemPrompt === 'function') {
      try {
        var sp2 = App.CharKit.rebuildSystemPrompt(card);
        if (typeof sp2 === 'string') return sp2;
      } catch (e2) {
        console.error('[tavern] 重建系统提示失败', e2);
      }
    }
    return '';
  }

  /* ------------------------------------------------------------------ *
   *  parseV2 —— 解析 V2 / V1 / 裸对象角色卡
   * ------------------------------------------------------------------ */

  function parseFail(message) {
    return { ok: false, card: null, warnings: [], error: message };
  }

  T.parseV2 = function (input) {
    var warnings = [];
    var obj = input;

    if (typeof obj === 'string') {
      var raw = String(obj).replace(/^\uFEFF/, '').replace(/^\s+|\s+$/g, '');
      if (!raw) return parseFail('文件内容为空，请选择 SillyTavern 导出的角色卡 JSON 文件');
      var parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }
      if ((!parsed || typeof parsed !== 'object') && App.Util && typeof App.Util.parseJSONLoose === 'function') {
        try { parsed = App.Util.parseJSONLoose(raw); } catch (e2) { parsed = null; }
      }
      if (!parsed || typeof parsed !== 'object') {
        return parseFail('文件不是有效的 JSON，可能不是角色卡文件，或者文件内容已损坏');
      }
      if (Array.isArray(parsed)) {
        return parseFail('角色卡内容不是 JSON 对象（当前文件是数组），无法导入');
      }
      obj = parsed;
    }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return parseFail('角色卡内容格式不正确（应为 JSON 对象）');
    }

    var spec = clean(obj.spec);
    var data = obj;

    if (spec === SPEC_V2 || spec === SPEC_V3) {
      if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
        return parseFail('角色卡缺少 data 内容，可能不是完整的 V2 角色卡');
      }
      data = obj.data;
      if (spec === SPEC_V3) {
        warnings.push('这张卡是 V3 格式（chara_card_v3），只会导入与 V2 兼容的字段，其余内容会忽略');
      }
    } else if (spec) {
      if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
        data = obj.data;
        warnings.push('未识别的角色卡版本「' + spec + '」，已按 V2 兼容模式解析');
      } else {
        return parseFail('不支持的角色卡版本「' + spec + '」，无法导入');
      }
    } else if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data) &&
      (str(obj.data.name) || str(obj.data.first_mes) || str(obj.data.description))) {
      data = obj.data;
      warnings.push('角色卡没有声明 spec 字段，已按 V2 兼容模式解析');
    }

    var legacyUsed = false;

    /* 角色名：name / char_name（旧版 TavernAI） */
    var name = clean(str(data.name) || str(obj.name));
    if (!name) {
      var legacyName = clean(str(data.char_name) || str(obj.char_name));
      if (legacyName) { name = legacyName; legacyUsed = true; }
    }
    if (!name) return parseFail('角色卡缺少角色名（name），无法导入');

    /* 简介 → 角色背景 */
    var description = pickField(data, ['description']);
    if (!description) {
      var legacyDesc = pickField(data, ['char_persona']);
      if (legacyDesc) { description = legacyDesc; legacyUsed = true; }
    }

    var personality = pickField(data, ['personality']);

    /* 场景 */
    var scenario = pickField(data, ['scenario']);
    if (!scenario) {
      var legacyScenario = pickField(data, ['world_scenario']);
      if (legacyScenario) { scenario = legacyScenario; legacyUsed = true; }
    }

    /* 第一句话 */
    var firstMessage = pickField(data, ['first_mes', 'first_message', 'firstMessage']);
    if (!firstMessage) {
      var legacyGreeting = pickField(data, ['char_greeting']);
      if (legacyGreeting) { firstMessage = legacyGreeting; legacyUsed = true; }
    }

    /* 备选问候语 */
    var altRaw = data.alternate_greetings;
    if (altRaw === null || altRaw === undefined) altRaw = data.alternateGreetings;
    var altList = [];
    if (altRaw !== null && altRaw !== undefined) {
      if (Array.isArray(altRaw)) {
        altList = strArr(altRaw);
      } else if (typeof altRaw === 'object') {
        warnings.push('备选问候语（alternate_greetings）格式不正确，已跳过');
      } else if (str(altRaw).replace(/\s/g, '')) {
        altList = [str(altRaw)];
      }
    }
    if (altList.length > MAX_ALT_GREETINGS) {
      warnings.push('备选问候语共有 ' + altList.length + ' 条，超过上限，只保留前 ' + MAX_ALT_GREETINGS + ' 条');
      altList = altList.slice(0, MAX_ALT_GREETINGS);
    }

    /* 示例对话 */
    var dialogues = [];
    var exRaw = data.mes_example;
    if (exRaw === null || exRaw === undefined) {
      exRaw = data.example_dialogue;
      if (exRaw !== null && exRaw !== undefined) legacyUsed = true;
    }
    if (exRaw === null || exRaw === undefined) exRaw = data.example_dialogues;
    if (Array.isArray(exRaw)) {
      dialogues = normalizeDialogues(exRaw);
    } else if (typeof exRaw === 'string') {
      if (exRaw.replace(/\s/g, '')) {
        dialogues = parseExampleDialogues(exRaw);
        if (!dialogues.length) warnings.push('示例对话（mes_example）格式无法识别，已跳过');
      }
    } else if (exRaw !== null && exRaw !== undefined) {
      warnings.push('示例对话（mes_example）不是文本内容，已跳过');
    }

    /* 原始扩展信息（导出时优先还原） */
    var tavern = {
      creator: pickField(data, ['creator']),
      characterVersion: pickField(data, ['character_version']),
      tags: tagsOf(data.tags),
      creatorNotes: pickField(data, ['creator_notes']),
      systemPrompt: pickField(data, ['system_prompt']),
      postHistoryInstructions: pickField(data, ['post_history_instructions'])
    };

    /* 不支持的内容，逐条中文提示 */
    var ext = data.extensions;
    if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
      var extKeys = [];
      for (var k in ext) {
        if (!Object.prototype.hasOwnProperty.call(ext, k)) continue;
        var ev = ext[k];
        if (ev === null || ev === undefined || ev === '') continue;
        if (typeof ev === 'object' && !Array.isArray(ev) && Object.keys(ev).length === 0) continue;
        extKeys.push(k);
      }
      if (extKeys.length) {
        warnings.push('这张卡带有扩展字段（extensions：' + extKeys.slice(0, 4).join('、') +
          (extKeys.length > 4 ? ' 等' : '') + '），App 不会导入，相关效果需要在编辑页手动补充');
      }
      if (ext.depth_prompt) warnings.push('不支持深度提示（extensions.depth_prompt），已跳过');
    }
    if (data.depth_prompt) warnings.push('不支持深度提示（depth_prompt），已跳过');
    if (data.character_book) warnings.push('不支持卡内世界书（character_book），已跳过；可以在「世界书」里手动建立');
    var groupOnly = data.group_only_greetings;
    if (groupOnly && (!Array.isArray(groupOnly) || groupOnly.length)) {
      warnings.push('不支持「仅群聊问候语」（group_only_greetings），已跳过');
    }
    if (Array.isArray(data.messages) && data.messages.length) {
      warnings.push('不支持卡内示例聊天记录（messages），已跳过');
    }
    if (data.assets && (!Array.isArray(data.assets) || data.assets.length)) {
      warnings.push('不支持卡内图片资源（assets），已跳过');
    }
    var avatarRaw = clean(str(data.avatar));
    if (avatarRaw && avatarRaw.toLowerCase() !== 'none' && !/^(https?:|data:)/i.test(avatarRaw)) {
      warnings.push('角色卡里的头像「' + truncateText(avatarRaw, 40) + '」不会导入，可以在编辑页重新设置头像');
    }
    if (!firstMessage) warnings.push('这张卡没有第一句话（first_mes），导入后建议在编辑页补一段开场白');
    if (!personality) warnings.push('这张卡没有单独的性格（personality）描述；陪聊角色需要补充一句性格才能保存修改');
    if (!description && !personality && !firstMessage) warnings.push('这张卡几乎没有可用的设定内容，导入后需要手动补充');
    if (legacyUsed) warnings.push('检测到旧版 TavernAI 字段（char_name / char_persona / world_scenario 等），已自动换算成新字段');

    var card = blankCard('companion');
    card.name = name;
    card.personality = personality;
    card.background = description;
    card.scenario = scenario;
    card.firstMessage = firstMessage;
    card.alternateGreetings = altList.slice();
    card.exampleDialogues = dialogues;
    card.gender = normalizeGender(data.gender) || normalizeGender(obj.gender) || inferGenderFromTags(data.tags);
    card.worldviewId = '';
    card.worldviewSnapshot = '';
    card.scenarios = scenario ? [scenario] : [];
    card.tavern = tavern;
    // 兼容镜像（App 内部仍以 firstMessage / alternateGreetings 为准）
    card.greetings = { primary: firstMessage, alternates: altList.slice() };

    return { ok: true, card: card, warnings: warnings, error: null };
  };

  /* ------------------------------------------------------------------ *
   *  toV2 —— 角色 → SillyTavern V2 JSON
   * ------------------------------------------------------------------ */

  T.toV2 = function (character) {
    var ch = (character && typeof character === 'object') ? character : {};
    var tv = normalizeTavern(ch.tavern);

    var data = {
      name: clean(ch.name) || '未命名角色',
      description: str(ch.background),
      personality: str(ch.personality),
      scenario: str(ch.scenario),
      first_mes: str(ch.firstMessage),
      alternate_greetings: strArr(ch.alternateGreetings).slice(0, MAX_ALT_GREETINGS),
      mes_example: buildMesExample(ch.exampleDialogues),
      system_prompt: tv.systemPrompt || str(ch.systemPrompt),
      post_history_instructions: tv.postHistoryInstructions,
      creator: tv.creator,
      character_version: tv.characterVersion || '1.0',
      tags: tv.tags,
      creator_notes: tv.creatorNotes,
      extensions: {}
    };

    return { spec: SPEC_V2, spec_version: SPEC_VERSION, data: data };
  };

  /* ------------------------------------------------------------------ *
   *  importCard —— 写库
   * ------------------------------------------------------------------ */

  T.importCard = async function (input) {
    var card = input;
    if (!card || typeof card !== 'object') throw new Error('角色卡内容为空，无法导入');
    var name = clean(card.name);
    if (!name) throw new Error('角色卡缺少角色名（name），无法导入');

    var DB = App.DB;
    if (!DB || typeof DB.put !== 'function') throw new Error('本地数据库未就绪，请稍后重试');

    var now = (App.Util && typeof App.Util.now === 'function') ? App.Util.now() : Date.now();
    var altList = strArr(card.alternateGreetings).slice(0, MAX_ALT_GREETINGS);
    var firstMessage = str(card.firstMessage);
    var scenario = str(card.scenario);

    var rec = {
      type: 'companion',
      name: name,
      avatar: '',
      worldviewId: '',
      worldviewSnapshot: '',
      personality: str(card.personality),
      habits: '',
      background: str(card.background),
      speechStyle: '',
      catchphrases: '',
      scenario: scenario,
      scenarios: scenario ? [scenario] : [],
      firstMessage: firstMessage,
      alternateGreetings: altList,
      greetings: { primary: firstMessage, alternates: altList.slice() },
      exampleDialogues: normalizeDialogues(card.exampleDialogues),
      systemPrompt: '',
      domain: '',
      specialty: [],
      duties: [],
      answerStyle: '',
      knowledgeBoundary: '',
      refusalPolicy: '',
      draft: {},
      fieldOrigin: {},
      gender: normalizeGender(card.gender),
      godMode: false,
      generatedAt: 0,
      generationProviderId: '',
      generationModel: '',
      tavern: normalizeTavern(card.tavern),
      createdAt: now,
      updatedAt: now
    };
    rec.systemPrompt = buildPrompt(rec);

    var saved;
    try {
      saved = await DB.put('characters', rec);
    } catch (err) {
      throw new Error('保存角色失败：' + errorText(err, '本地数据库写入异常'));
    }

    if (App.CharKit && typeof App.CharKit.notifyData === 'function') {
      try { App.CharKit.notifyData('characters'); } catch (e) {
        console.error('[tavern] 通知角色列表刷新失败', e);
      }
    }

    return saved || rec;
  };

  /* ------------------------------------------------------------------ *
   *  exportCard —— 走 App.Bridge 写文件
   * ------------------------------------------------------------------ */

  T.exportCard = async function (character) {
    if (!character || typeof character !== 'object') {
      return { ok: false, error: '没有可导出的角色' };
    }
    if (!App.Bridge || typeof App.Bridge.call !== 'function') {
      return { ok: false, error: '当前环境不支持文件导出' };
    }

    var json;
    try {
      json = JSON.stringify(T.toV2(character), null, 2);
    } catch (err) {
      return { ok: false, error: '生成角色卡 JSON 失败：' + errorText(err) };
    }

    var fileName = safeFileName(character.name) + '.json';
    try {
      var res = await App.Bridge.call('file.export', {
        name: fileName,
        mime: 'application/json',
        data: json
      });
      if (res && res.ok === false) {
        return { ok: false, error: errorText(res, '导出失败') };
      }
      return { ok: true, error: null, path: (res && res.path) || '' };
    } catch (err2) {
      console.error('[tavern] 导出角色卡失败', err2);
      return { ok: false, error: '导出失败：' + errorText(err2, '未知原因') };
    }
  };

  /* ------------------------------------------------------------------ *
   *  弹窗工具（App.UI.modal 统一封装，防止重复 resolve）
   * ------------------------------------------------------------------ */

  function openInfoModal(opts) {
    opts = opts || {};
    var UI = App.UI;
    if (!UI || typeof UI.modal !== 'function' || typeof UI.el !== 'function') {
      toast(opts.message || opts.title || '操作失败', 'error');
      return Promise.resolve(false);
    }
    return new Promise(function (resolve) {
      var settled = false;
      var handle = null;

      function finish(value) {
        if (settled) return;
        settled = true;
        try { if (handle && typeof handle.close === 'function') handle.close(); } catch (e) {}
        resolve(value);
      }

      var content;
      if (opts.content && typeof opts.content === 'object' && opts.content.nodeType) {
        content = opts.content;
      } else {
        content = UI.el('div', { class: 'tavern-dialog' });
        if (opts.message) content.appendChild(UI.el('div', { class: 'tavern-dialog-text', text: opts.message }));
        if (opts.hint) content.appendChild(UI.el('div', { class: 'tavern-dialog-hint', text: opts.hint }));
        if (opts.detail) content.appendChild(UI.el('div', { class: 'tavern-dialog-detail', text: opts.detail }));
      }

      var actions = [{ text: opts.cancelText || '关闭', onClick: function () { finish(false); } }];
      if (opts.okText) {
        actions.push({ text: opts.okText, class: 'primary', onClick: function () { finish(true); } });
      }

      handle = UI.modal({
        title: opts.title || '提示',
        content: content,
        alignLeft: true,
        dismissible: true,
        onClose: function () {
          if (settled) return;
          settled = true;
          resolve(false);
        },
        actions: actions
      });
    });
  }

  function showParseError(parsed, fileName) {
    var message = (parsed && parsed.error) || '无法识别这个角色卡文件';
    return openInfoModal({
      title: '无法导入角色卡',
      message: message,
      hint: '请选择 SillyTavern / TavernAI 导出的 V2 角色卡（.json 文件）。',
      detail: fileName ? '文件：' + fileName : '',
      cancelText: '关闭'
    });
  }

  function previewSection(label, text, maxLen) {
    var UI = App.UI;
    var sec = UI.el('div', { class: 'tavern-preview-section' });
    sec.appendChild(UI.el('div', { class: 'tavern-preview-label', text: label }));
    sec.appendChild(UI.el('div', { class: 'tavern-preview-text', text: truncateText(text, maxLen) }));
    return sec;
  }

  function buildWarnBox(warnings) {
    var UI = App.UI;
    var box = UI.el('div', { class: 'tavern-warn-box' });
    box.appendChild(UI.el('div', {
      class: 'tavern-warn-title',
      text: '⚠ 有 ' + warnings.length + ' 项内容不会完整导入'
    }));
    var list = UI.el('ul', { class: 'tavern-warn-list' });
    for (var i = 0; i < warnings.length; i++) {
      list.appendChild(UI.el('li', { class: 'tavern-warn-item', text: warnings[i] }));
    }
    box.appendChild(list);
    return box;
  }

  function buildPreview(card, warnings, fileName) {
    var UI = App.UI;
    var wrap = UI.el('div', { class: 'tavern-preview' });
    var name = clean(card.name) || '未命名角色';
    var tv = card.tavern || {};

    var head = UI.el('div', { class: 'tavern-preview-head' });
    if (typeof UI.avatar === 'function') {
      try {
        var av = UI.avatar(name, card.avatar || '', 'md');
        if (av) head.appendChild(av);
      } catch (e) {
        console.error('[tavern] 生成头像失败', e);
      }
    }

    var titleBox = UI.el('div', { class: 'tavern-preview-title' });
    titleBox.appendChild(UI.el('div', { class: 'tavern-preview-name', text: name }));

    var metas = [];
    if (tv.creator) metas.push('作者：' + tv.creator);
    if (tv.characterVersion) metas.push('版本：' + tv.characterVersion);
    if (tv.tags && tv.tags.length) metas.push('标签：' + tv.tags.slice(0, 6).join('、'));
    if (fileName) metas.push('文件：' + fileName);
    if (metas.length) {
      titleBox.appendChild(UI.el('div', { class: 'tavern-preview-meta', text: metas.join(' · ') }));
    }
    head.appendChild(titleBox);
    wrap.appendChild(head);

    var background = str(card.background);
    var personality = str(card.personality);
    if (background) {
      wrap.appendChild(previewSection('简介（会作为角色背景）', background, 240));
    } else if (personality) {
      wrap.appendChild(previewSection('性格（会作为角色性格）', personality, 240));
    }
    if (background && personality) {
      wrap.appendChild(previewSection('性格', personality, 120));
    }
    if (str(card.firstMessage)) {
      wrap.appendChild(previewSection('第一句话（开场白）', str(card.firstMessage), 160));
    }

    var altCount = Array.isArray(card.alternateGreetings) ? card.alternateGreetings.length : 0;
    var dlgCount = Array.isArray(card.exampleDialogues) ? card.exampleDialogues.length : 0;
    var counts = [];
    if (altCount) counts.push('备选问候语 ' + altCount + ' 条');
    if (dlgCount) counts.push('示例对话 ' + dlgCount + ' 条');
    if (counts.length) {
      wrap.appendChild(UI.el('div', { class: 'tavern-preview-count', text: '同时导入：' + counts.join(' · ') }));
    }

    if (!background && !personality && !str(card.firstMessage)) {
      wrap.appendChild(UI.el('div', {
        class: 'tavern-preview-empty',
        text: '这张卡几乎没有设定内容，导入后需要在编辑页手动补充。'
      }));
    }

    if (warnings && warnings.length) wrap.appendChild(buildWarnBox(warnings));
    return wrap;
  }

  function showPreview(card, warnings, fileName) {
    var UI = App.UI;
    if (!UI || typeof UI.modal !== 'function' || typeof UI.el !== 'function') {
      return Promise.resolve(true);
    }
    var content = buildPreview(card, warnings, fileName);
    return openInfoModal({
      title: '导入角色卡预览',
      content: content,
      okText: '确认导入',
      cancelText: '取消'
    });
  }

  /* ------------------------------------------------------------------ *
   *  openImport —— 选文件 → 解析 → 预览 → 落库 → 打开编辑页
   * ------------------------------------------------------------------ */

  T.openImport = async function () {
    if (importing) {
      toast('正在导入中，请稍候…');
      return null;
    }
    if (!App.Bridge || typeof App.Bridge.call !== 'function') {
      toast('当前环境不支持文件导入', 'error');
      return null;
    }

    importing = true;
    try {
      var file = await App.Bridge.call('file.import', {
        accept: '.json,application/json',
        maxBytes: MAX_IMPORT_BYTES
      }, { timeoutMs: IMPORT_TIMEOUT });

      if (!file) return null;

      var input = file.data;
      var isEmpty = (input === null || input === undefined) ||
        (typeof input === 'string' && !input.replace(/^\uFEFF/, '').replace(/^\s+|\s+$/g, ''));
      if (isEmpty) {
        var pickedName = clean(file.name);
        if (pickedName) toast('文件「' + truncateText(pickedName, 40) + '」是空的，没有可导入的内容', 'error');
        return null;
      }

      if (typeof input === 'string') {
        var size = byteLength(input);
        if (size > MAX_IMPORT_BYTES) {
          toast('角色卡文件过大（' + formatBytes(size) + '），请选择 ' + formatBytes(MAX_IMPORT_BYTES) + ' 以内的文件', 'error');
          return null;
        }
      }

      var parsed = T.parseV2(input);
      if (!parsed || !parsed.ok) {
        await showParseError(parsed, clean(file.name));
        return null;
      }

      var confirmed = await showPreview(parsed.card, parsed.warnings, clean(file.name));
      if (!confirmed) return null;

      var saved = await T.importCard(parsed.card);
      toast('已导入角色「' + ((saved && saved.name) || parsed.card.name) + '」', 'ok');

      if (App.Router && typeof App.Router.push === 'function' && saved && saved.id) {
        try {
          var nav = App.Router.push('characterEdit', { id: saved.id });
          if (nav && typeof nav.catch === 'function') {
            nav.catch(function (err) {
              console.error('[tavern] 打开角色编辑页失败', err);
              toast('已导入，但打开编辑页失败，请到角色列表查看', 'error');
            });
          }
        } catch (e) {
          console.error('[tavern] 打开角色编辑页异常', e);
          toast('已导入，但打开编辑页失败，请到角色列表查看', 'error');
        }
      }
      return saved;
    } catch (err2) {
      if (err2 && (err2.code === 'cancel' || err2.code === 'abort')) return null;
      console.error('[tavern] 导入角色卡失败', err2);
      toast('导入失败：' + errorText(err2, '未知错误'), 'error');
      return null;
    } finally {
      importing = false;
    }
  };

  /* ------------------------------------------------------------------ *
   *  openExport —— 确认 → 导出 → toast
   * ------------------------------------------------------------------ */

  T.openExport = async function (character) {
    if (!character || typeof character !== 'object') {
      toast('没有可导出的角色', 'error');
      return { ok: false, error: '没有可导出的角色' };
    }

    var name = clean(character.name) || '未命名角色';
    var confirmed = false;
    var UI = App.UI;
    if (UI && typeof UI.confirm === 'function') {
      try {
        confirmed = await UI.confirm({
          title: '导出角色卡',
          message: '将把「' + name + '」导出为 SillyTavern V2 格式的 JSON 角色卡（.json 文件），之后可以在 SillyTavern / TavernAI 等客户端导入。卡内头像、世界书和扩展功能不会包含在文件里。',
          okText: '导出',
          cancelText: '取消'
        });
      } catch (e) {
        console.error('[tavern] 导出确认弹窗失败', e);
        confirmed = false;
      }
    }
    if (!confirmed) return { ok: false, canceled: true, error: null };

    var res = await T.exportCard(character);
    if (res && res.ok) toast('已导出角色卡「' + name + '」', 'ok');
    else toast((res && res.error) || '导出失败', 'error');
    return res || { ok: false, error: '导出失败' };
  };

})();
