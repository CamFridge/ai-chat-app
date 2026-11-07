#!/usr/bin/env node
/**
 * v1.4.0 静态冒烟（不启动浏览器/模拟器）
 *
 * 校验六项新增功能是否真的接进了工程：
 *   ① 世界书 Lorebook  ② 群聊  ③ TavernAI/SillyTavern V2 角色卡  ④ 多 persona
 *   ⑥ 从消息分支对话   ⑦ 预设 mode='text'
 *
 * 做法：读源码做断言（文件存在、全局 API 签名、页面注册名、DB 表/索引、
 * index.html 接线、chat.js 钩子）。这是「接线检查」，不等于运行时 E2E。
 *
 * 用法：node scripts/e2e-v140.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'android', 'assets', 'www');
const read = (p) => fs.readFileSync(path.join(WWW, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(WWW, p));

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); return true; }
  fails.push(name + (extra ? '（' + extra + '）' : ''));
  console.log('  ✗ ' + name + (extra ? '（' + extra + '）' : ''));
  return false;
}
function section(t) { console.log('\n' + t); }

const index = read('index.html');
const db = read('js/db.js');
const chat = read('js/pages/chat.js');
const chatList = read('js/pages/chat-list.js');
const presetEdit = read('js/pages/preset-edit.js');

section('0. 文件与接线');
['js/lorebook.js', 'js/group.js', 'js/persona.js', 'js/tavern.js',
  'css/pages-lorebook.css', 'css/pages-group.css', 'css/pages-persona.css', 'css/pages-tavern.css',
  'js/pages/lorebook.js', 'js/pages/lorebook-edit.js', 'js/pages/lorebook-gen.js',
  'js/pages/group-create.js', 'js/pages/group-manage.js',
  'js/pages/personas.js', 'js/pages/persona-edit.js'].forEach((f) => {
  ok('存在 ' + f, exists(f));
});
['js/lorebook.js', 'js/group.js', 'js/persona.js', 'js/tavern.js'].forEach((f) => {
  ok('index.html 引入 ' + f, index.indexOf(f) >= 0);
});
['css/pages-lorebook.css', 'css/pages-group.css', 'css/pages-persona.css', 'css/pages-tavern.css'].forEach((f) => {
  ok('index.html 引入 ' + f, index.indexOf(f) >= 0);
});
['js/pages/lorebook.js', 'js/pages/lorebook-edit.js', 'js/pages/lorebook-gen.js',
  'js/pages/group-create.js', 'js/pages/group-manage.js',
  'js/pages/personas.js', 'js/pages/persona-edit.js'].forEach((f) => {
  ok('index.html 引入 ' + f, index.indexOf(f) >= 0);
});

section('1. 数据库 v4（世界书 / 群聊 / 多 persona）');
ok('DB_VERSION >= 4', /DB_VERSION\s*=\s*([4-9]|\d\d+)/.test(db));
['lorebooks', 'loreEntries', 'groups'].forEach((s) => {
  ok("STORES 含 '" + s + "'", db.indexOf("'" + s + "'") >= 0);
});
ok('lorebooks.characterId 索引', /lorebooks[\s\S]{0,200}characterId/.test(db));
ok('loreEntries.lorebookId 索引', /loreEntries[\s\S]{0,200}lorebookId/.test(db));
ok('sessions 支持 kind/characterIds/groupId', /kind|characterIds|groupId/.test(chat + chatList));

section('2. 世界书 Lorebook（App.Lorebook）');
const lore = exists('js/lorebook.js') ? read('js/lorebook.js') : '';
['App.Lorebook', 'buildInjection', 'ensureForCharacter', 'listForCharacter', 'generateEntries'].forEach((k) => {
  ok('lorebook.js 含 ' + k, lore.indexOf(k) >= 0);
});
ok('触发词匹配 keys/secondaryKeys', /keys/.test(lore) && /secondaryKeys/.test(lore));
ok('alwaysOn 常驻', /alwaysOn/.test(lore));
ok('tokenBudget 预算', /tokenBudget|token_budget/.test(lore));
ok('世界书页面注册 lorebook', /register\(\s*'lorebook'/.test(read('js/pages/lorebook.js')));
ok('世界书编辑页注册 lorebookEdit', /register\(\s*'lorebookEdit'/.test(read('js/pages/lorebook-edit.js')));
ok('世界书生成页注册 lorebookGen', /register\(\s*'lorebookGen'/.test(read('js/pages/lorebook-gen.js')));
ok('chat.js 注入世界书', /Lorebook/.test(chat) && /buildInjection/.test(chat));
ok('会话菜单有世界书入口', /openLorebook|'lorebook'/.test(chat));

section('3. 群聊（App.Group）');
const group = exists('js/group.js') ? read('js/group.js') : '';
['App.Group', 'membersOf', 'buildContext', 'decideSpeaker', 'parseSpeakerReply', 'create', 'addMembers', 'removeMember'].forEach((k) => {
  ok('group.js 含 ' + k, group.indexOf(k) >= 0);
});
ok('decideSpeaker 用 API.chatOnce', /chatOnce/.test(group));
ok('群聊页面注册 groupCreate', /groupCreate/.test(read('js/pages/group-create.js') || ''));
ok('群聊页面注册 groupManage', /groupManage/.test(read('js/pages/group-manage.js') || ''));
ok('chat-list 有新建群聊入口', /群聊|group/i.test(chatList));
ok('chat.js 识别群聊会话', /isGroup/.test(chat));
ok('chat.js 渲染发言人名字', /msg-speaker|speakerName/.test(chat));
ok('chat.js 群聊走 Group.buildContext', /Group\b[\s\S]{0,400}buildContext|buildContext/.test(chat));
ok('chat.js 收尾解析发言人', /parseSpeakerReply/.test(chat));

section('4. 多 persona（App.Persona）');
const persona = exists('js/persona.js') ? read('js/persona.js') : '';
['App.Persona', 'list', 'getDefaultId', 'setDefault', 'ensureDefault', 'resolve', 'promptLine', 'pickForSession'].forEach((k) => {
  ok('persona.js 含 ' + k, persona.indexOf(k) >= 0);
});
ok('personas 页面注册 personas', /'personas'/.test(read('js/pages/personas.js') || ''));
ok('persona 编辑页注册 personaEdit', /'personaEdit'/.test(read('js/pages/persona-edit.js') || ''));
ok('chat.js 会话菜单有我的身份', /pickPersona|我的身份/.test(chat));
ok('settings 有我的身份入口', /personas|我的身份/.test(read('js/pages/settings.js')));

section('5. TavernAI / SillyTavern V2 角色卡（App.Tavern）');
const tavern = exists('js/tavern.js') ? read('js/tavern.js') : '';
['App.Tavern', 'parseV2', 'toV2', 'importCard', 'exportCard', 'openImport', 'openExport'].forEach((k) => {
  ok('tavern.js 含 ' + k, tavern.indexOf(k) >= 0);
});
ok('spec 字段 v2', /spec/.test(tavern) && /chara_card_v2|v2/.test(tavern));
ok('导出走 native file.export', /file\.export/.test(tavern));
ok('characters 页有导入/导出入口', /Tavern/.test(read('js/pages/characters.js')));
ok('character-create 有导入入口', /Tavern/.test(read('js/pages/character-create.js')));

section('6. 从某条消息分支对话');
ok('chat.js 有 branchFrom', /function\s+branchFrom/.test(chat));
ok('消息菜单有「从这里分支」', /从这里分支|branchFrom/.test(chat));
ok('分支复制历史消息', /bulkPut[\s\S]{0,200}messages|messages/.test(chat) && /sessionId/.test(chat));

section('7. 预设 mode=\'text\' 真正生效');
ok('preset-edit 模式说明已更新', /文本：按纯文本补全渲染|纯文本补全/.test(presetEdit));
ok('chat.js 读取 preset.mode', /mode\s*===\s*'text'/.test(chat));
ok('chat.js 文本模式渲染', /textMode/.test(chat));
ok('pages-chat.css 有 text-mode 样式', /\.text-mode/.test(read('css/pages-chat.css')));

section('8. 构建与文档');
const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build.ps1'), 'utf8');
ok('build.ps1 VersionName=1.4.0', /\$VersionName\s*=\s*'1\.4\.0'/.test(build));
ok('build.ps1 VersionCode 递增', /\$VersionCode\s*=\s*'1[3-9]'/.test(build));

console.log('\n================ v1.4.0 静态冒烟结果 ================');
console.log('  通过: ' + pass + '   失败: ' + fails.length);
if (fails.length) {
  console.log('  失败项:');
  fails.forEach((f) => console.log('   - ' + f));
  process.exit(1);
}
console.log('  全部通过（注意：这是接线检查，不代表真机运行结果）');
