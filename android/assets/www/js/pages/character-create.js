/* ============================================================
 * pages/character-create.js —— 新建角色向导（二级页）
 *
 * 5 步：
 *   1. 选类型（陪聊 / 助手，助手再选领域 + 专业）
 *   2. 选世界观（7 个内置 + 自定义 + 无）
 *   3. 粗略填写（名称、性格必填；习惯、补充可空）
 *   4. 选择补全 API → AI 补全（分步进度，60s 超时，解析失败重试 1 次）
 *   5. 预览完整角色卡：字段可编辑、AI 字段打标、保存 / 让 AI 改 / 自己修改
 *
 * 约束：
 *   - 绝不自动保存：只有点「保存」才写 characters 表；
 *   - 草稿持久化在 settings.draft_character，杀进程后可恢复；
 *   - 补全走 App.Prompts.completeCharacter（内部负责重试与 JSON 校验）；
 *   - 「让 AI 改」固定使用引导 API，预览页不显示 API 选择器。
 * ============================================================ */
(function () {
  'use strict';

  var UI = App.UI;
  var U = App.Util;
  var DB = App.DB;
  var Kit = App.CharKit;
  var P = App.Prompts;

  var PAGE = 'characterCreate';
  var DRAFT_KEY = 'draft_character';

  var STEP_NAMES = ['选择类型', '选择世界观', '填写基本信息', 'AI 补全', '预览角色卡'];

  var TYPE_CARDS = (App.Data && App.Data.CHARACTER_TYPES) || [
    { id: 'companion', name: '陪聊角色', icon: 'user', desc: '有性格、习惯和开场白，像真人一样陪你聊天。' },
    { id: 'assistant', name: '领域助手', icon: 'bot', desc: '在某个领域里专业回答，不扮演、不说套话。' }
  ];

  var state = {
    root: null,
    page: null,
    destroyed: false,
    step: 1,
    totalSteps: 5,

    type: 'companion',
    domainId: '',
    domain: '',
    specialty: [],
    customSpecialties: [],

    selectedWvId: '',
    worldview: null,
    presets: [],
    userWvs: [],

    name: '',
    personality: '',
    habits: '',
    extra: '',

    providers: [],
    genProviderId: '',
    genModel: '',

    card: null,
    versions: [],
    versionIndex: -1,
    raw: '',
    meta: { providerId: '', model: '', at: 0 },

    busy: false,
    manual: false,
    genError: null,

    progress: null,
    progressSlot: null,
    errorSlot: null,
    stopAnim: null,
    scrollBox: null,
    saved: false,
    buildId: 0,

    // AI 补全进行中的实时状态（流式预览 / 计时 / 阶段）
    genStartAt: 0,
    genChars: 0,
    genPhase: 'idle',   // idle | connecting | streaming | parsing | retrying | done | stopped | error
    genAttempt: 1,
    genLive: '',
    genTimer: null,
    genRaf: null,
    genEls: null
  };

  /* ============================================================
   * 一、草稿持久化
   * ============================================================ */

  function draftData() {
    return {
      step: state.step,
      type: state.type,
      domainId: state.domainId,
      domain: state.domain,
      specialty: state.specialty.slice(),
      customSpecialties: state.customSpecialties.slice(),
      worldviewId: state.selectedWvId,
      name: state.name,
      personality: state.personality,
      habits: state.habits,
      extra: state.extra,
      card: state.card,
      versions: state.versions,
      versionIndex: state.versionIndex,
      raw: state.raw,
      genProviderId: state.genProviderId,
      genModel: state.genModel,
      generationProviderId: state.meta.providerId,
      generationModel: state.meta.model,
      generatedAt: state.meta.at,
      updatedAt: Date.now()
    };
  }

  var saveSoon = U.debounce(function () {
    if (state.destroyed || state.saved) return;
    Kit.saveDraft(DRAFT_KEY, draftData());
  }, 400);

  function saveDraftNow() {
    if (state.destroyed || state.saved) return Promise.resolve(null);
    return Kit.saveDraft(DRAFT_KEY, draftData());
  }

  function applyDraft(draft) {
    if (!draft || typeof draft !== 'object') return false;
    var d = draft;

    state.step = U.clamp(parseInt(d.step, 10) || 1, 1, 5);
    if (d.type === 'assistant' || d.type === 'companion') state.type = d.type;
    state.domainId = d.domainId || '';
    state.domain = d.domain || '';
    state.specialty = Array.isArray(d.specialty) ? d.specialty.slice() : [];
    state.customSpecialties = Array.isArray(d.customSpecialties) ? d.customSpecialties.slice() : [];
    state.selectedWvId = d.worldviewId || '';
    state.name = d.name || '';
    state.personality = d.personality || '';
    state.habits = d.habits || '';
    state.extra = d.extra || '';
    state.card = d.card || null;
    state.versions = Array.isArray(d.versions) ? d.versions : [];
    state.versionIndex = typeof d.versionIndex === 'number' ? d.versionIndex : state.versions.length - 1;
    state.raw = d.raw || '';
    state.genProviderId = d.genProviderId || '';
    state.genModel = d.genModel || '';
    state.meta = {
      providerId: d.generationProviderId || '',
      model: d.generationModel || '',
      at: d.generatedAt || 0
    };

    if (state.card && !state.versions.length) {
      state.versions = [{ card: state.card, at: state.meta.at, label: '上次生成' }];
      state.versionIndex = 0;
    }
    // 恢复到第 5 步但没有卡（异常退出）：兜底成手动卡
    if (state.step === 5 && !state.card) {
      state.card = buildManualCard();
      state.versions = [];
      state.versionIndex = -1;
    }
    return true;
  }

  /* ============================================================
   * 二、数据准备
   * ============================================================ */

  function currentDomain() {
    var list = (App.Data && App.Data.DOMAINS) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.domainId) return list[i];
    }
    return null;
  }

  function findWorldviewById(id) {
    if (!id) return null;
    if (id === 'wv-none') return null;
    var all = (state.presets || []).concat(state.userWvs || []);
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  function selectedWorldviewForPrompt() {
    if (!state.selectedWvId || state.selectedWvId === 'wv-none') return null;
    return state.worldview || findWorldviewById(state.selectedWvId);
  }

  /* ============================================================
   * 三、页面骨架与渲染
   * ============================================================ */

  function render() {
    if (!state.root || state.destroyed) return;
    var scrollTop = state.scrollBox ? state.scrollBox.scrollTop : 0;
    state.progressSlot = null;
    state.errorSlot = null;
    UI.clear(state.root);

    state.root.appendChild(renderHeader());
    state.scrollBox = renderBody();
    state.root.appendChild(state.scrollBox);
    state.root.appendChild(renderFooter());

    // 还原滚动位置（编辑字段后不跳回顶部）
    if (scrollTop) {
      try { state.scrollBox.scrollTop = scrollTop; } catch (e) { /* 忽略 */ }
    }
    updateGuide();
  }

  /* ---------- 顶部：步骤点 + 标题 ---------- */
  function renderHeader() {
    var head = UI.el('div', { class: 'ck-wizard-head' });
    head.appendChild(Kit.progressDots(STEP_NAMES, state.step - 1));

    var caption = UI.el('div', { class: 'ck-wizard-caption' },
      UI.el('span', { text: '第 ' + state.step + ' / ' + state.totalSteps + ' 步 · ' + STEP_NAMES[state.step - 1] })
    );

    if (state.step === 5) {
      var backLink = UI.el('button', { class: 'btn ghost small', type: 'button', text: '返回补全' });
      backLink.addEventListener('click', function () { goStep(4); });
      caption.appendChild(backLink);
    }
    head.appendChild(caption);
    return head;
  }

  function renderBody() {
    var box = UI.el('div', { class: 'ck-wizard-body' });
    if (state.step === 1) box.appendChild(step1Body());
    else if (state.step === 2) box.appendChild(step2Body());
    else if (state.step === 3) box.appendChild(step3Body());
    else if (state.step === 4) box.appendChild(step4Body());
    else box.appendChild(step5Body());
    return box;
  }

  /* ---------- 底部按钮 ---------- */
  function renderFooter() {
    var foot = UI.el('div', { class: 'ck-wizard-foot' });

    if (state.step === 5) {
      var rewriteBtn = UI.el('button', { class: 'btn ghost', type: 'button', text: '让 AI 改' });
      rewriteBtn.addEventListener('click', function () { askRewrite(); });
      var manualBtn = UI.el('button', { class: 'btn ghost', type: 'button', text: '自己修改' });
      manualBtn.addEventListener('click', function () { enterManual(); });
      var saveBtn = UI.el('button', { class: 'btn primary', type: 'button', text: state.busy ? '处理中…' : '保存' });
      saveBtn.addEventListener('click', function () { saveCharacter(); });
      if (state.busy) saveBtn.disabled = true;
      foot.appendChild(rewriteBtn);
      foot.appendChild(manualBtn);
      foot.appendChild(saveBtn);
      return foot;
    }

    if (state.step > 1 && !(state.step === 4 && state.busy)) {
      var prev = UI.el('button', { class: 'btn ghost', type: 'button', text: '上一步' });
      prev.addEventListener('click', function () { goStep(state.step - 1); });
      foot.appendChild(prev);
    }

    if (state.step === 1) {
      var next1 = UI.el('button', { class: 'btn primary', type: 'button', text: '下一步' });
      next1.addEventListener('click', function () { goStep(2); });
      foot.appendChild(next1);
    } else if (state.step === 2) {
      var next2 = UI.el('button', { class: 'btn primary', type: 'button', text: '下一步' });
      next2.addEventListener('click', function () { goStep(3); });
      foot.appendChild(next2);
    } else if (state.step === 3) {
      var aiBtn = UI.el('button', {
        class: 'btn primary',
        type: 'button',
        text: 'AI 补全',
        attrs: { 'data-guide-tap': 'ai-complete' }
      });
      aiBtn.addEventListener('click', function () { tryNextFromStep3(); });
      foot.appendChild(aiBtn);
    } else if (state.step === 4) {
      if (state.busy) {
        var stopBtn = UI.el('button', { class: 'btn danger', type: 'button', text: '停止生成' });
        stopBtn.addEventListener('click', function () { cancelGenerate(); });
        foot.appendChild(stopBtn);
        return foot;
      }
      if (state.genError) {
        var manual2 = UI.el('button', { class: 'btn ghost', type: 'button', text: '手动填写' });
        manual2.addEventListener('click', function () { skipAi(); });
        var retryBtn = UI.el('button', {
          class: 'btn primary',
          type: 'button',
          text: state.genError.code === 'cancel' ? '继续生成' : '重新生成'
        });
        retryBtn.addEventListener('click', function () { startGenerate(); });
        foot.appendChild(manual2);
        foot.appendChild(retryBtn);
        return foot;
      }
      if (state.card) {
        var regenBtn = UI.el('button', { class: 'btn ghost', type: 'button', text: '重新生成' });
        regenBtn.addEventListener('click', function () { startGenerate(); });
        var previewBtn = UI.el('button', { class: 'btn primary', type: 'button', text: '下一步：预览' });
        previewBtn.addEventListener('click', function () { goStep(5); });
        foot.appendChild(regenBtn);
        foot.appendChild(previewBtn);
        return foot;
      }
      var skipBtn = UI.el('button', { class: 'btn ghost', type: 'button', text: '跳过，手动填写' });
      skipBtn.addEventListener('click', function () { skipAi(); });
      var genBtn = UI.el('button', { class: 'btn primary', type: 'button', text: '开始 AI 补全' });
      genBtn.addEventListener('click', function () { startGenerate(); });
      foot.appendChild(skipBtn);
      foot.appendChild(genBtn);
      return foot;
    }
    return foot;
  }

  /* ---------- 悬浮气泡上下文 ---------- */
  function updateGuide() {
    if (!state.page || !state.page.guide || state.destroyed) return;
    var filled = {};
    var missing = [];
    if (state.name) filled.name = true; else missing.push('name');
    if (state.personality) filled.personality = true; else missing.push('personality');
    if (state.habits) filled.habits = true;
    if (state.extra) filled.extra = true;
    if (state.type === 'assistant') {
      if (state.domain) filled.domain = true; else if (state.step <= 1) missing.push('domain');
      if (state.specialty.length) filled.specialty = true;
    }
    if (state.selectedWvId) filled.worldview = true;

    state.page.guide({
      pageId: PAGE,
      title: '创建角色 · 第 ' + state.step + ' 步 ' + STEP_NAMES[state.step - 1],
      stage: STEP_NAMES[state.step - 1],
      totalSteps: state.totalSteps,
      filledFields: filled,
      missingFields: missing,
      error: state.genError ? Kit.guideError(state.genError) : null
    });
  }

  /* ============================================================
   * 四、Step 1 —— 选类型（+ 助手领域/专业）
   * ============================================================ */

  function step1Body() {
    var body = UI.el('div', {});

    body.appendChild(UI.el('div', { class: 'ck-step-head' },
      UI.el('div', { class: 'ck-step-title', text: '你想创建哪种角色？' }),
      UI.el('div', { class: 'ck-step-desc', text: '陪聊角色会扮演一个人物陪你聊天；领域助手会在专业问题上给你答案。' })
    ));

    var grid = UI.el('div', { class: 'ck-type-grid' });
    TYPE_CARDS.forEach(function (item) {
      var active = state.type === item.id;
      var card = UI.el('button', {
        class: 'ck-type-card' + (active ? ' active' : ''),
        type: 'button',
        attrs: { 'aria-pressed': active ? 'true' : 'false' }
      },
        UI.el('span', { class: 'ck-type-icon', html: UI.icon(item.icon || 'user', 22) }),
        UI.el('div', { class: 'ck-type-name', text: item.name }),
        UI.el('div', { class: 'ck-type-desc', text: item.desc || '' }),
        UI.el('span', { class: 'ck-type-check', html: UI.icon('check', 18) })
      );
      card.addEventListener('click', function () {
        if (state.type === item.id) return;
        state.type = item.id;
        if (state.type === 'companion') {
          // 切换到陪聊：领域信息保留但不再使用
        }
        saveSoon();
        render();
      });
      grid.appendChild(card);
    });
    body.appendChild(grid);

    if (state.type === 'assistant') {
      body.appendChild(assistantPickerBody());
    } else {
      body.appendChild(UI.el('div', { class: 'ck-info-box', text: '陪聊角色只需要名称和一句性格，剩下的交给 AI 补全。' }));
    }

    return body;
  }

  function assistantPickerBody() {
    var wrap = UI.el('div', { class: 'list section' });

    // 领域行
    var domainValue = state.domain || '请选择领域';
    var domainCell = UI.el('div', { class: 'cell', attrs: { role: 'button', tabindex: '0' } },
      UI.el('div', { class: 'main' },
        UI.el('div', { class: 'title', text: '领域' }),
        UI.el('div', { class: 'sub', text: domainValue })
      ),
      UI.el('span', { class: 'chev', html: UI.icon('chev', 17) })
    );
    if (!state.domain) domainCell.querySelector('.sub').classList.add('muted');
    domainCell.addEventListener('click', pickDomain);
    wrap.appendChild(domainCell);

    // 专业 chip
    var domain = currentDomain();
    var specialties = (domain && domain.specialties) || [];
    var chipWrap = UI.el('div', { class: 'field', attrs: { style: 'display:block' } });
    chipWrap.appendChild(UI.el('label', {}, UI.el('span', { text: '专业（可多选）' })));
    var chips = UI.el('div', { class: 'chip-row', attrs: { style: 'padding-top:6px' } });

    var allSpec = specialties.concat(state.customSpecialties.filter(function (s) {
      return specialties.indexOf(s) < 0;
    }));

    allSpec.forEach(function (spec) {
      var on = state.specialty.indexOf(spec) >= 0;
      var tag = UI.el('button', {
        class: 'tag' + (on ? ' active' : ''),
        type: 'button',
        text: spec,
        attrs: { 'aria-pressed': on ? 'true' : 'false' }
      });
      tag.addEventListener('click', function () {
        var idx = state.specialty.indexOf(spec);
        if (idx >= 0) state.specialty.splice(idx, 1);
        else state.specialty.push(spec);
        saveSoon();
        render();
      });
      chips.appendChild(tag);
    });

    var addChip = UI.el('button', { class: 'tag', type: 'button', text: '＋ 手填专业' });
    addChip.addEventListener('click', addCustomSpecialty);
    chips.appendChild(addChip);

    chipWrap.appendChild(chips);
    chipWrap.appendChild(UI.el('div', {
      class: 'hint',
      text: domain && domain.customizable ? '「其他」领域可以手填领域名称和任意专业。' : '不选专业也可以，AI 会根据领域自动推断。'
    }));
    wrap.appendChild(chipWrap);

    if (!state.domain) {
      wrap.appendChild(UI.el('div', { class: 'ck-note', text: '先选择领域才能继续。' }));
    }

    return wrap;
  }

  function pickDomain() {
    var list = (App.Data && App.Data.DOMAINS) || [];
    var items = list.map(function (d) {
      return {
        id: d.id,
        label: d.name + (d.id === 'other' ? '（可自定义）' : ''),
        desc: d.id === 'other' ? '手填领域名称与专业' : (d.specialties || []).slice(0, 3).join(' / '),
        icon: d.id === state.domainId ? 'check' : 'world'
      };
    });
    UI.sheet({ title: '选择领域', items: items, selected: state.domainId }).then(function (item) {
      if (!item) return null;
      var prevId = state.domainId;
      state.domainId = item.id;
      var d = currentDomain();
      state.domain = d ? d.name : item.label;
      // 换了领域：清空原来选的专业，避免把上一个领域的专业带过去
      if (prevId !== item.id) {
        state.specialty = [];
        state.customSpecialties = [];
      }
      if (state.domainId === 'other') {
        return Kit.prompt({
          title: '自定义领域名称',
          value: '',
          placeholder: '例如：心理学',
          okText: '确定'
        }).then(function (text) {
          var t = String(text || '').trim();
          if (t) state.domain = t;
          state.specialty = state.specialty.filter(function (s) {
            return state.customSpecialties.indexOf(s) >= 0;
          });
          state.customSpecialties = [];
          saveSoon();
          render();
          return null;
        });
      }
      saveSoon();
      render();
      return null;
    }).catch(function (err) {
      console.error('[characterCreate] 选择领域失败', err);
      UI.toast('选择领域失败', 'error');
    });
  }

  function addCustomSpecialty() {
    return Kit.prompt({
      title: '手填专业',
      message: '填写一个专业方向，例如「刑事辩护」',
      placeholder: '例如：刑事辩护',
      okText: '添加'
    }).then(function (text) {
      var t = String(text || '').trim();
      if (!t) return null;
      if (state.customSpecialties.indexOf(t) < 0) state.customSpecialties.push(t);
      if (state.specialty.indexOf(t) < 0) state.specialty.push(t);
      saveSoon();
      render();
      return null;
    }).catch(function (err) {
      console.error('[characterCreate] 添加专业失败', err);
      UI.toast('添加失败', 'error');
    });
  }

  /* ============================================================
   * 五、Step 2 —— 选世界观
   * ============================================================ */

  function step2Body() {
    var body = UI.el('div', {});

    body.appendChild(UI.el('div', { class: 'ck-step-head' },
      UI.el('div', { class: 'ck-step-title', text: '给角色挑一个世界观' }),
      UI.el('div', { class: 'ck-step-desc', text: '世界观决定角色的时代、规则和说话方式。之后修改世界观不会影响已经创建的角色。' })
    ));

    var listBox = UI.el('div', { class: 'ck-wv-list' });

    // 「无」+ 7 个内置 + 用户自定义
    var options = [];
    var none = null;
    var presets = state.presets || [];
    presets.forEach(function (wv) {
      if (wv.id === 'wv-none') none = wv;
    });
    if (!none) none = { id: 'wv-none', name: '无世界观', summary: '不绑定任何设定，按现代日常聊天。' };
    options.push(none);
    presets.forEach(function (wv) {
      if (wv.id !== 'wv-none') options.push(wv);
    });
    (state.userWvs || []).forEach(function (wv) { options.push(wv); });

    options.forEach(function (wv) {
      var active = state.selectedWvId === wv.id;
      var sourceLabel = wv.id === 'wv-none' ? '默认' : (wv.source === 'user' || wv.isBuiltin === false ? '自定义' : '内置');
      var card = UI.el('button', {
        class: 'ck-wv-card' + (active ? ' active' : ''),
        type: 'button',
        attrs: { 'aria-pressed': active ? 'true' : 'false' }
      },
        UI.el('div', { class: 'ck-wv-card-head' },
          UI.el('span', { class: 'ck-wv-name', text: wv.name || '未命名世界观' }),
          UI.el('span', { class: 'ck-wv-source' + (sourceLabel === '自定义' ? ' user' : ''), text: sourceLabel }),
          UI.el('span', { class: 'ck-wv-check', html: UI.icon('check', 18) })
        ),
        UI.el('div', { class: 'ck-wv-summary', text: wv.summary || '' })
      );
      card.addEventListener('click', function () {
        if (state.selectedWvId === wv.id) return;
        state.selectedWvId = wv.id;
        state.worldview = (wv.id === 'wv-none') ? null : wv;
        saveSoon();
        render();
      });
      listBox.appendChild(card);
    });

    body.appendChild(listBox);

    var createWv = UI.el('button', { class: 'btn ghost block', type: 'button', text: '＋ 新建自定义世界观' });
    createWv.addEventListener('click', function () {
      App.Router.push('worldviews', {}).catch(function (err) {
        console.error('[characterCreate] 打开世界观库失败', err);
      });
    });
    body.appendChild(UI.el('div', { class: 'ck-pad', attrs: { style: 'padding-top:4px;padding-bottom:8px' } }, createWv));

    // 摘要预览
    var wv = selectedWorldviewForPrompt();
    if (wv) {
      var preview = UI.el('div', { class: 'ck-wv-preview' },
        UI.el('div', { class: 'ck-wv-preview-title', text: '世界观摘要' }),
        UI.el('div', { text: P && P.worldviewText ? P.worldviewText(wv) : (wv.summary || '') })
      );
      body.appendChild(preview);
    } else {
      body.appendChild(UI.el('div', { class: 'ck-note', text: '当前不绑定世界观，角色会按现代日常语境补全。' }));
    }

    return body;
  }

  /* ============================================================
   * 六、Step 3 —— 粗略填写
   * ============================================================ */

  function lightField(opts) {
    var input;
    if (opts.multiline) {
      input = UI.el('textarea', {
        class: 'textarea',
        attrs: { placeholder: opts.placeholder || '', rows: 3, autocomplete: 'off' }
      });
    } else {
      input = UI.el('input', {
        class: 'input',
        attrs: { type: 'text', placeholder: opts.placeholder || '', autocomplete: 'off' }
      });
    }
    if (opts.focus) input.setAttribute('data-guide-focus', opts.focus);
    input.value = opts.value == null ? '' : String(opts.value);
    input.addEventListener('input', function () {
      opts.onInput(input.value);
      saveSoon();
    });

    return UI.el('div', { class: 'field' },
      UI.el('label', {},
        UI.el('span', { text: opts.label }),
        opts.required ? UI.el('span', { class: 'ck-required', text: '*' }) : null
      ),
      input,
      opts.hint ? UI.el('div', { class: 'hint', text: opts.hint }) : null
    );
  }

  function step3Body() {
    var body = UI.el('div', {});
    body.appendChild(UI.el('div', { class: 'ck-step-head' },
      UI.el('div', { class: 'ck-step-title', text: '随便写一点，剩下的交给 AI' }),
      UI.el('div', { class: 'ck-step-desc', text: '只有名称和一句性格是必填的，其他都可以空着。' })
    ));

    var form = UI.el('div', { class: 'form ck-light-form' });

    form.appendChild(lightField({
      label: '角色名称',
      required: true,
      focus: 'name',
      placeholder: '例如：林晚',
      value: state.name,
      onInput: function (v) { state.name = v; }
    }));

    form.appendChild(lightField({
      label: '一句话性格',
      required: true,
      focus: 'personality',
      placeholder: '例如：外冷内热，说话短，偶尔毒舌',
      value: state.personality,
      onInput: function (v) { state.personality = v; }
    }));

    form.appendChild(lightField({
      label: '习惯（可空）',
      focus: 'habits',
      placeholder: '例如：睡前一定要喝一杯热牛奶',
      value: state.habits,
      onInput: function (v) { state.habits = v; }
    }));

    form.appendChild(lightField({
      label: '其他补充（可空）',
      focus: 'extra',
      multiline: true,
      placeholder: '例如：她是开旧书店的，喜欢下雨天，讨厌被人打断说话',
      value: state.extra,
      onInput: function (v) { state.extra = v; }
    }));

    body.appendChild(form);

    // 跳过 AI 的通道
    var skip = UI.el('button', { class: 'btn ghost block', type: 'button', text: '跳过 AI 补全，手动填完整表单' });
    skip.addEventListener('click', function () {
      state.card = buildManualCard();
      state.versions = [];
      state.versionIndex = -1;
      state.step = 5;
      saveDraftNow();
      render();
    });
    body.appendChild(UI.el('div', { class: 'ck-pad', attrs: { style: 'padding-top:8px' } }, skip));

    if (state.type === 'assistant') {
      body.appendChild(UI.el('div', {
        class: 'ck-note',
        text: '领域：' + (state.domain || '未选') + (state.specialty.length ? ' · 专业：' + state.specialty.join(' / ') : '')
      }));
    }

    return body;
  }

  function validateStep3() {
    if (!String(state.name || '').trim()) {
      UI.toast('请先填写角色名称', 'error');
      return false;
    }
    if (!String(state.personality || '').trim()) {
      UI.toast('请写一句角色性格，AI 需要它来补全', 'error');
      return false;
    }
    return true;
  }

  function tryNextFromStep3() {
    if (!validateStep3()) return;
    if (state.type === 'assistant' && !state.domain) {
      UI.toast('请先回到第 1 步选择领域', 'error');
      return;
    }
    // 进入第 4 步选择补全 API，点「开始 AI 补全」才真正发起请求
    goStep(4);
  }

  /* ============================================================
   * 七、Step 4 —— API 选择 + AI 补全
   * ============================================================ */

  function genText() {
    var provider = Kit.findProvider(state.providers, state.genProviderId);
    var name = provider ? (provider.name || '未命名 API') : '未选择 API';
    var model = state.genModel || (provider && provider.defaultModel) || '未设置模型';
    return '补全使用：' + name + ' · ' + model;
  }

  function providerBar() {
    var bar = UI.el('div', { class: 'ck-provider-bar', attrs: { role: 'button', tabindex: '0' } },
      UI.el('div', { class: 'ck-provider-text' },
        UI.el('div', { class: 'ck-provider-label', text: '补全使用' }),
        UI.el('div', { class: 'ck-provider-name', text: genText().replace('补全使用：', '') })
      ),
      UI.el('span', { class: 'chev', html: UI.icon('chev', 17) })
    );
    bar.addEventListener('click', function () {
      if (state.busy) {
        UI.toast('正在补全中，请稍等');
        return;
      }
      chooseProvider();
    });
    return bar;
  }

  function chooseProvider() {
    return Kit.pickProviderModel({
      providers: state.providers,
      providerId: state.genProviderId,
      model: state.genModel,
      title: '选择补全使用的 API'
    }).then(function (picked) {
      if (!picked) return null;
      state.genProviderId = picked.providerId;
      state.genModel = picked.model;
      DB.settings.set('character_gen_provider_id', picked.providerId).catch(function (e) {
        console.warn('[characterCreate] 保存补全 API 选择失败', e);
      });
      DB.settings.set('character_gen_model', picked.model).catch(function (e) {
        console.warn('[characterCreate] 保存补全模型选择失败', e);
      });
      state.genError = null;
      saveSoon();
      render();
      return null;
    }).catch(function (err) {
      console.error('[characterCreate] 选择补全 API 失败', err);
      UI.toast('选择 API 失败', 'error');
      return null;
    });
  }

  function skipAi() {
    if (state.busy) return;
    state.card = buildManualCard();
    state.versions = [];
    state.versionIndex = -1;
    state.genError = null;
    state.step = 5;
    saveDraftNow();
    render();
  }

  function step4Body() {
    var body = UI.el('div', { class: 'ck-gen-page' });
    body.appendChild(UI.el('div', { class: 'ck-step-head' },
      UI.el('div', { class: 'ck-step-title', text: state.busy ? 'AI 正在补全' : 'AI 补全' }),
      UI.el('div', {
        class: 'ck-step-desc',
        text: state.busy
          ? '生成的内容会实时显示在下面，可以随时停止；完成后自动进入预览。'
          : 'AI 会把名称、性格和世界观扩写成完整角色卡，生成过程可以实时查看。'
      })
    ));

    body.appendChild(providerBar());

    if (state.busy) {
      body.appendChild(genLiveBox());
    } else if (state.genError) {
      body.appendChild(renderGenError());
    } else if (state.card) {
      body.appendChild(UI.el('div', { class: 'ck-gen-done' },
        UI.el('div', { class: 'ck-gen-done-title', text: '角色卡已生成' }),
        UI.el('div', {
          class: 'ck-gen-done-desc',
          text: '「' + (state.card.name || '未命名') + '」的设定已就绪，可以继续预览和修改。'
        })
      ));
    } else {
      body.appendChild(UI.el('div', { class: 'ck-gen-tip' },
        UI.el('div', { class: 'ck-gen-tip-title', text: '补全大约需要 10~40 秒' }),
        UI.el('div', {
          class: 'ck-gen-tip-desc',
          text: '点击下方「开始 AI 补全」。生成时会实时显示模型输出，也可以随时停止；不满意可以换个 API 重试，或直接手动填写。'
        })
      ));
    }
    return body;
  }

  /* ---------- 生成中：实时输出 + 真实计时 ---------- */

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
      state.genFollow = gap < 60;
    });
    box.appendChild(pre);

    box.appendChild(UI.el('div', { class: 'ck-gen-hint', text: '这里是模型原始输出，完成后自动整理成角色卡' }));

    state.genEls = {
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
    if (state.genTimer) { clearInterval(state.genTimer); state.genTimer = null; }
    if (state.genRaf) {
      try { cancelAnimationFrame(state.genRaf); } catch (e) { /* 忽略 */ }
      state.genRaf = null;
    }
  }

  function startGenLoop() {
    stopGenLoop();
    state.genTimer = setInterval(updateGenView, 200);
  }

  function scheduleGenUpdate() {
    if (state.genRaf) return;
    state.genRaf = U.raf(function () {
      state.genRaf = null;
      updateGenView();
    });
  }

  function updateGenView() {
    var e = state.genEls;
    if (!e) return;
    var ms = state.genStartAt ? (Date.now() - state.genStartAt) : 0;
    e.elapsed.textContent = (ms / 1000).toFixed(1) + 's';
    e.chars.textContent = '已接收 ' + state.genChars + ' 字';
    e.attempt.textContent = '第 ' + (state.genAttempt || 1) + ' 次尝试';
    var phases = {
      connecting: '正在连接 API…',
      streaming: '正在生成…',
      parsing: '正在解析角色卡…',
      retrying: '正在重试…',
      stopping: '正在停止…',
      done: '生成完成',
      stopped: '已停止',
      error: '生成失败'
    };
    e.status.textContent = phases[state.genPhase] || '正在生成…';
    if (state.genLive && e.text.textContent !== state.genLive) {
      e.text.textContent = state.genLive;
      e.pre.classList.add('has-text');
    }
    if (state.genFollow !== false) {
      try { e.pre.scrollTop = e.pre.scrollHeight; } catch (err) { /* 忽略 */ }
    }
  }

  function cancelGenerate() {
    if (!state.busy) return;
    state.genPhase = 'stopping';
    try { P.cancelCompletion(); } catch (e) { /* 忽略 */ }
    updateGenView();
    // 兜底：原生取消没有回调时也要收尾
    setTimeout(function () {
      if (!state.busy) return;
      finishStopped();
    }, 900);
  }

  function finishStopped() {
    if (state.destroyed) return;
    state.busy = false;
    state.genError = { code: 'cancel', message: '已停止生成' };
    state.raw = state.genLive || state.raw || '';
    stopGenLoop();
    saveDraftNow();
    render();
  }

  function renderGenError() {
    var err = state.genError || {};
    var info = Kit.errorInfo(err);
    var parseFailed = !!(err.parseFailed || err.code === 'parse');
    var cancelled = err.code === 'cancel';
    var title;
    if (cancelled) title = '已停止生成';
    else if (parseFailed) title = 'AI 补全没有返回完整角色卡';
    else if (err.code === 'noprovider') title = '没有可用的补全 API';
    else title = info.title || 'AI 补全失败';

    var hint;
    if (cancelled) hint = '已经生成的内容保留在下方。可以重新生成，或手动填写后继续。';
    else if (parseFailed) hint = '模型输出没有通过格式校验（常见于小模型或网络中断）。可以重试、换一个 API，或手动填写。';
    else if (err.code === 'noprovider') hint = err.message || '请先到「API 管理」添加一个可用的 API。';
    else hint = info.hint || '请检查网络与 API 配置后重试。';

    var wrap = UI.el('div', { class: 'ck-gen-error' });
    var head = UI.el('div', { class: 'ck-gen-error-head' });
    head.appendChild(UI.el('span', { class: 'ck-gen-error-icon', html: UI.icon('warning', 18) }));
    head.appendChild(UI.el('div', { class: 'ck-gen-error-text' },
      UI.el('div', { class: 'ck-gen-error-title', text: title }),
      UI.el('div', { class: 'ck-gen-error-hint', text: hint })
    ));
    wrap.appendChild(head);

    if (state.raw) {
      var open = cancelled;
      var toggle = UI.el('button', { class: 'ck-gen-raw-toggle', type: 'button', text: open ? '收起模型原始输出' : '查看模型原始输出' });
      var rawBox = UI.el('pre', { class: 'ck-gen-raw', text: state.raw });
      var panel = UI.el('div', { class: 'ck-gen-raw-panel' }, rawBox);
      panel.style.display = open ? 'block' : 'none';
      toggle.addEventListener('click', function () {
        open = !open;
        panel.style.display = open ? 'block' : 'none';
        toggle.textContent = open ? '收起模型原始输出' : '查看模型原始输出';
      });
      wrap.appendChild(toggle);
      wrap.appendChild(panel);
    }

    var swap = UI.el('button', { class: 'ck-gen-link', type: 'button', text: '换个 API 再试' });
    swap.addEventListener('click', function () { chooseProvider(); });
    wrap.appendChild(swap);
    return wrap;
  }

  function startGenerate() {
    if (state.busy || state.destroyed) return Promise.resolve(null);
    if (!validateStep3()) return Promise.resolve(null);

    var gen = Kit.resolveGen(state.providers, state.genProviderId, state.genModel);
    if (!gen.ok) {
      state.genError = { code: 'noprovider', message: gen.reason || '没有可用的 API' };
      state.busy = false;
      render();
      return Promise.resolve(null);
    }

    state.genProviderId = gen.provider.id;
    state.genModel = gen.model;
    state.busy = true;
    state.genError = null;
    state.raw = '';
    state.genLive = '';
    state.genChars = 0;
    state.genPhase = 'connecting';
    state.genAttempt = 1;
    state.genStartAt = Date.now();
    state.genFollow = true;
    state.genEls = null;

    DB.settings.set('character_gen_provider_id', gen.provider.id).catch(function (e) {
      console.warn('[characterCreate] 保存补全 API 失败', e);
    });
    DB.settings.set('character_gen_model', gen.model).catch(function (e) {
      console.warn('[characterCreate] 保存补全模型失败', e);
    });

    render();
    startGenLoop();

    var ctx = {
      type: state.type,
      domain: state.domain,
      specialty: state.specialty.slice(),
      worldview: selectedWorldviewForPrompt(),
      draft: {
        name: String(state.name || '').trim(),
        personality: String(state.personality || '').trim(),
        habits: String(state.habits || '').trim(),
        extra: String(state.extra || '').trim()
      },
      provider: gen.provider,
      model: gen.model,
      timeoutMs: P && P.TIMEOUT_MS ? P.TIMEOUT_MS : 60000,
      stream: true,
      onDelta: function (acc) {
        if (state.destroyed || !state.busy) return;
        if (typeof acc !== 'string') return;
        state.genLive = acc;
        state.genChars = acc.length;
        if (state.genPhase !== 'streaming') state.genPhase = 'streaming';
        scheduleGenUpdate();
      },
      onAttempt: function (n) {
        if (state.destroyed || !state.busy) return;
        state.genAttempt = n || 1;
        state.genPhase = state.genAttempt > 1 ? 'retrying' : 'connecting';
        state.genLive = '';
        state.genChars = 0;
        scheduleGenUpdate();
      }
    };

    return P.completeCharacter(ctx).then(function (res) {
      stopGenLoop();
      if (state.destroyed) return null;

      if (res && res.ok && res.card) {
        var card = res.card;
        state.busy = false;
        state.genPhase = 'done';
        state.card = card;
        state.raw = res.raw || '';
        state.genError = null;
        state.meta = { providerId: gen.provider.id, model: gen.model, at: Date.now() };
        state.versions = [{
          card: Kit.clone(card),
          at: state.meta.at,
          label: '首次补全',
          providerId: gen.provider.id,
          model: gen.model
        }];
        state.versionIndex = 0;
        saveDraftNow();
        render();
        Kit.notifyData('characters');
        // 稍作停留让用户看到完成状态，再进预览
        setTimeout(function () {
          if (state.destroyed || state.step !== 4) return;
          state.step = 5;
          saveDraftNow();
          render();
        }, 520);
        return card;
      }

      // 失败 / 已停止：保留已收到的文本，供手动兜底
      var err = (res && res.error) || { code: 'unknown', message: 'AI 补全失败' };
      state.busy = false;
      if (err.code === 'cancel') {
        state.genError = { code: 'cancel', message: '已停止生成' };
        state.genPhase = 'stopped';
      } else {
        state.genError = err;
        state.genPhase = 'error';
      }
      state.raw = (res && res.raw) || state.genLive || '';
      saveDraftNow();
      render();
      return null;
    }).catch(function (err) {
      stopGenLoop();
      if (state.destroyed) return null;
      console.error('[characterCreate] AI 补全异常', err);
      state.busy = false;
      state.genError = Kit.errorInfo(err);
      state.genPhase = 'error';
      state.raw = state.raw || state.genLive || '';
      saveDraftNow();
      render();
      return null;
    });
  }

  /* ============================================================
   * 八、Step 5 —— 预览 / 编辑 / 改稿 / 保存
   * ============================================================ */

  function buildManualCard() {
    var card = (App.Data && App.Data.blankCharacter)
      ? App.Data.blankCharacter(state.type)
      : { type: state.type, exampleDialogues: [], specialty: [], duties: [], fieldOrigin: {}, draft: {} };

    card.type = state.type;
    card.name = String(state.name || '').trim();
    card.personality = String(state.personality || '').trim();
    card.habits = String(state.habits || '').trim();
    card.background = '';
    if (state.type === 'assistant') {
      card.domain = state.domain || '';
      card.specialty = state.specialty.slice();
      card.duties = [];
      card.answerStyle = '';
      card.knowledgeBoundary = '';
      card.refusalPolicy = '';
      card.firstMessage = '';
    }
    var wv = selectedWorldviewForPrompt();
    card.worldviewId = wv ? wv.id : '';
    card.worldviewSnapshot = wv && P && P.worldviewSnapshotText ? P.worldviewSnapshotText(wv) : '';
    card.fieldOrigin = {};
    if (state.name) card.fieldOrigin.name = 'user';
    if (state.personality) card.fieldOrigin.personality = 'user';
    if (state.habits) card.fieldOrigin.habits = 'user';
    if (state.extra) card.fieldOrigin.draft = 'user';
    card.draft = { extra: String(state.extra || '') };
    card.systemPrompt = '';
    card.createdAt = Kit.now();
    card.updatedAt = card.createdAt;
    return card;
  }

  function ensureCard() {
    if (!state.card) {
      state.card = buildManualCard();
      state.versions = [];
      state.versionIndex = -1;
    }
    return state.card;
  }

  function originOf(card, key) {
    var fo = (card && card.fieldOrigin) || {};
    return fo[key] || '';
  }

  function currentVersionCard() {
    if (state.versions.length && state.versionIndex >= 0 && state.versions[state.versionIndex] && state.versions[state.versionIndex].card) {
      return state.versions[state.versionIndex].card;
    }
    return state.card;
  }

  function step5Body() {
    var body = UI.el('div', {});
    var card = ensureCard();
    state.progressSlot = UI.el('div', { class: 'ck-progress-slot' });

    // 版本切换（改稿后保留上一版，可回滚）
    if (state.versions.length > 1) {
      var versionsBox = UI.el('div', { class: 'ck-versions' }, UI.el('span', { text: '版本：' }));
      state.versions.forEach(function (ver, i) {
        var chip = UI.el('button', {
          class: 'ck-version-chip' + (i === state.versionIndex ? ' active' : ''),
          type: 'button',
          text: ver.label || ('第 ' + (i + 1) + ' 版')
        });
        chip.addEventListener('click', function () {
          state.versionIndex = i;
          // 用克隆回滚，避免之后的编辑改坏已保存的旧版本
          state.card = Kit.clone(ver.card);
          state.meta = { providerId: ver.providerId || '', model: ver.model || '', at: ver.at || 0 };
          saveSoon();
          render();
        });
        versionsBox.appendChild(chip);
      });
      body.appendChild(versionsBox);
    }

    // 卡头
    var head = UI.el('div', { class: 'ck-preview-head' },
      UI.avatar(card.name || '角', card.avatar, 'lg'),
      UI.el('div', { class: 'ck-preview-main' },
        UI.el('div', { class: 'ck-preview-name', text: card.name || '未命名角色' }),
        UI.el('div', { class: 'ck-preview-sub' },
          UI.el('span', { class: 'badge ' + (card.type === 'assistant' ? 'blue' : 'green'), text: Kit.typeName(card.type) }),
          card.domain ? UI.el('span', { text: card.domain }) : null,
          card.worldviewSnapshot ? UI.el('span', { class: 'ck-wv-mini', text: Kit.snapshotName(card.worldviewSnapshot) || '' }) : null
        )
      )
    );
    body.appendChild(head);

    // 生成信息
    if (state.meta.at) {
      var provider = Kit.findProvider(state.providers, state.meta.providerId);
      var metaText = '生成于 ' + U.fmtTime(state.meta.at) +
        (provider ? ' · ' + provider.name : '') +
        (state.meta.model ? ' · ' + state.meta.model : '');
      body.appendChild(UI.el('div', { class: 'ck-note', attrs: { style: 'padding:6px 16px' }, text: metaText }));
    }
    if (state.manual) {
      body.appendChild(UI.el('div', { class: 'ck-info-box', text: '手动编辑模式：点任意字段直接修改，改完记得点「保存」。' }));
    }

    // 世界观贴合度（AI 生成时才有）
    var draft = card.draft || {};
    if (draft.worldviewFit) {
      body.appendChild(UI.el('div', { class: 'ck-info-box' },
        UI.el('div', { class: 'small muted', text: '世界观贴合度' }),
        UI.el('div', { text: String(draft.worldviewFit) })
      ));
    }

    // 字段列表
    var list = UI.el('div', { class: 'ck-field-list' });
    previewFieldDefs(card).forEach(function (def) {
      list.appendChild(previewFieldRow(card, def));
    });
    body.appendChild(list);

    body.appendChild(state.progressSlot);
    if (state.busy) {
      body.appendChild(UI.el('div', { class: 'ck-loading-inline', html: UI.icon('spark', 18) + '<span>AI 正在按你的意见修改…</span>' }));
    }

    return body;
  }

  function previewFieldDefs(card) {
    var defs = [
      { key: 'name', label: '名称', multiline: false, required: true }
    ];
    if (card.type === 'assistant') {
      defs = defs.concat([
        { key: 'domain', label: '领域', multiline: false },
        { key: 'specialty', label: '专业', list: true },
        { key: 'duties', label: '职责', list: true, multiline: true },
        { key: 'answerStyle', label: '回答风格', multiline: true },
        { key: 'knowledgeBoundary', label: '知识边界', multiline: true },
        { key: 'refusalPolicy', label: '拒答策略', multiline: true },
        { key: 'firstMessage', label: '开场白', multiline: true }
      ]);
    } else {
      defs = defs.concat([
        { key: 'personality', label: '性格', multiline: true },
        { key: 'habits', label: '习惯', multiline: true },
        { key: 'background', label: '背景', multiline: true },
        { key: 'speechStyle', label: '说话风格', multiline: true },
        { key: 'catchphrases', label: '口头禅', multiline: true },
        { key: 'scenario', label: '场景', multiline: true },
        { key: 'firstMessage', label: '开场白', multiline: true },
        { key: 'exampleDialogues', label: '示例对话', dialogs: true }
      ]);
    }
    defs.push({ key: 'systemPrompt', label: 'System Prompt', multiline: true, big: true });
    return defs;
  }

  function fieldValueText(card, def) {
    var v = card[def.key];
    if (def.list) {
      return (Array.isArray(v) ? v : []).filter(Boolean).join(' / ');
    }
    if (def.dialogs) {
      return (Array.isArray(v) ? v : []).map(function (d) {
        return '用户：' + (d && d.user ? d.user : '') + '\n角色：' + (d && d.char ? d.char : '');
      }).join('\n\n');
    }
    return v == null ? '' : String(v);
  }

  function previewFieldRow(card, def) {
    var value = fieldValueText(card, def);
    var fo = originOf(card, def.key);
    var row = Kit.fieldRow({
      label: def.label,
      value: value,
      empty: !String(value || '').trim(),
      placeholder: '未填写，点此补充',
      ai: fo === 'ai',
      user: fo === 'user',
      onClick: function () { editCardField(def); }
    });
    return row;
  }

  function editCardField(def) {
    var card = ensureCard();
    if (def.dialogs) {
      Kit.editDialogs(card.exampleDialogues).then(function (list) {
        if (list === null) return null;
        card.exampleDialogues = list;
        markUser(card, def.key);
        return null;
      }).catch(function (err) {
        console.error('[characterCreate] 编辑示例对话失败', err);
      });
      return;
    }
    if (def.list) {
      Kit.editList({ label: def.label, values: card[def.key] }).then(function (list) {
        if (list === null) return null;
        card[def.key] = list;
        markUser(card, def.key);
        return null;
      }).catch(function (err) {
        console.error('[characterCreate] 编辑列表失败', err);
      });
      return;
    }
    Kit.editField({
      label: def.label,
      value: card[def.key] == null ? '' : String(card[def.key]),
      multiline: !!def.multiline,
      placeholder: def.placeholder || ''
    }).then(function (text) {
      if (text === null) return null;
      if (def.required && !String(text || '').trim()) {
        UI.toast('「' + def.label + '」不能为空', 'error');
        return null;
      }
      card[def.key] = text;
      markUser(card, def.key);
      return null;
    }).catch(function (err) {
      console.error('[characterCreate] 编辑字段失败', err);
    });
  }

  function markUser(card, key) {
    if (!card.fieldOrigin) card.fieldOrigin = {};
    card.fieldOrigin[key] = 'user';
    card.updatedAt = Kit.now();
    saveDraftNow();
    render();
  }

  /* ---------- 让 AI 改：固定用引导 API ---------- */

  function askRewrite() {
    if (state.busy) return;
    var card = ensureCard();
    var guide = Kit.findGuide(state.providers);
    if (!guide) {
      UI.toast('需要先在「API 管理」里配置引导 API', 'error');
      return;
    }
    var model = guide.defaultModel || (guide.models && guide.models[0]) || '';
    if (!model) {
      UI.toast('引导 API 还没有设置模型，请先到「API 管理」补全', 'error');
      return;
    }
    UI.prompt({
      title: '让 AI 修改角色',
      message: '写一句修改意见，例如「再高冷一点」「别用网络流行语」。',
      placeholder: '再高冷一点',
      multiline: true,
      okText: '开始修改'
    }).then(function (text) {
      var instruction = String(text || '').trim();
      if (!instruction) return null;
      runRewrite(guide, model, instruction);
      return null;
    }).catch(function (err) {
      console.error('[characterCreate] 输入修改意见失败', err);
    });
  }

  function runRewrite(guide, model, instruction) {
    if (state.busy) return;
    state.busy = true;
    render();

    var progress = Kit.aiProgress(['理解修改意见', '重写角色卡']);
    if (state.progressSlot) state.progressSlot.appendChild(progress.node);
    state.progress = progress;
    progress.setActive(0);

    var card = ensureCard();
    var ctx = {
      card: Kit.clone(card),
      instruction: instruction,
      type: card.type || state.type,
      provider: guide,
      model: model,
      timeoutMs: P && P.TIMEOUT_MS ? P.TIMEOUT_MS : 60000
    };

    P.rewriteCharacter(ctx).then(function (res) {
      state.busy = false;
      if (state.destroyed) return;
      progress.done();
      if (!res || !res.ok || !res.card) {
        var err = (res && res.error) || { code: 'unknown', message: 'AI 修改失败' };
        UI.toast(Kit.errorInfo(err).title || 'AI 修改失败', 'error');
        if (res && res.raw) state.raw = res.raw;
        state.genError = err;
        render();
        return;
      }
      var newCard = res.card;
      state.card = newCard;
      state.meta = { providerId: guide.id, model: model, at: Date.now() };
      state.versions.push({
        card: Kit.clone(newCard),
        at: state.meta.at,
        label: '第 ' + (state.versions.length + 1) + ' 版',
        providerId: guide.id,
        model: model,
        instruction: instruction
      });
      state.versionIndex = state.versions.length - 1;
      state.genError = null;
      saveDraftNow();
      render();
      UI.toast('已按意见修改，可切换上方版本回滚', 'ok');
    }).catch(function (err) {
      state.busy = false;
      progress.fail();
      console.error('[characterCreate] AI 修改失败', err);
      state.genError = Kit.errorInfo(err);
      render();
      UI.toast('AI 修改失败：' + ((err && err.message) || '未知错误'), 'error');
    });
  }

  /* ---------- 自己修改 ---------- */

  function enterManual() {
    state.manual = true;
    render();
    UI.toast('现在可以直接点任意字段修改', 'ok');
  }

  /* ---------- 保存 ---------- */

  function buildRecord() {
    var card = ensureCard();
    var now = Kit.now();
    var fo = card.fieldOrigin ? Kit.clone(card.fieldOrigin) : {};

    var record = {
      id: U.uid('char'),
      type: card.type || state.type,
      name: String(card.name || state.name || '').trim(),
      avatar: card.avatar || '',
      worldviewId: card.worldviewId || (selectedWorldviewForPrompt() ? selectedWorldviewForPrompt().id : ''),
      worldviewSnapshot: card.worldviewSnapshot || (selectedWorldviewForPrompt() && P.worldviewSnapshotText
        ? P.worldviewSnapshotText(selectedWorldviewForPrompt())
        : ''),
      personality: card.personality || '',
      habits: card.habits || '',
      background: card.background || '',
      speechStyle: card.speechStyle || '',
      catchphrases: card.catchphrases || '',
      scenario: card.scenario || '',
      firstMessage: card.firstMessage || '',
      exampleDialogues: Array.isArray(card.exampleDialogues) ? card.exampleDialogues : [],
      systemPrompt: card.systemPrompt || '',
      domain: card.domain || (state.type === 'assistant' ? state.domain : ''),
      specialty: Array.isArray(card.specialty) ? card.specialty : (state.type === 'assistant' ? state.specialty.slice() : []),
      duties: Array.isArray(card.duties) ? card.duties : [],
      answerStyle: card.answerStyle || '',
      knowledgeBoundary: card.knowledgeBoundary || '',
      refusalPolicy: card.refusalPolicy || '',
      draft: card.draft || {},
      fieldOrigin: fo,
      generatedAt: state.meta.at || 0,
      generationProviderId: state.meta.providerId || '',
      generationModel: state.meta.model || '',
      createdAt: now,
      updatedAt: now
    };

    // 用户手改过 systemPrompt 就保留；否则按字段重建
    if (fo.systemPrompt !== 'user' || !record.systemPrompt) {
      record.systemPrompt = Kit.rebuildSystemPrompt(record) || record.systemPrompt;
    }
    return record;
  }

  function validateBeforeSave(record) {
    if (!record.name) {
      UI.toast('请先填写角色名称', 'error');
      return false;
    }
    if (record.type === 'assistant') {
      if (!record.domain) {
        UI.toast('领域助手需要填写领域', 'error');
        return false;
      }
      if (!record.specialty.length) {
        UI.toast('请至少填写一个专业方向', 'error');
        return false;
      }
    } else if (!String(record.personality || '').trim()) {
      UI.toast('请至少写一句角色性格', 'error');
      return false;
    }
    return true;
  }

  function saveCharacter() {
    if (state.busy) return Promise.resolve(null);
    var record = buildRecord();
    if (!validateBeforeSave(record)) return Promise.resolve(null);

    state.busy = true;
    render();

    return DB.put('characters', record).then(function (saved) {
      state.busy = false;
      state.saved = true;
      return Kit.clearDraft(DRAFT_KEY).then(function () {
        Kit.notifyData('characters');
        UI.toast('角色已保存', 'ok');
        var hasChat = false;
        try { hasChat = !!(App.Router.has && App.Router.has('chat')); } catch (e) { hasChat = false; }
        try { App.Router.pop(); } catch (e) { /* 忽略 */ }
        if (hasChat) {
          setTimeout(function () {
            Kit.startChat(saved).catch(function (err) {
              console.error('[characterCreate] 保存后开聊失败', err);
            });
          }, 120);
        }
        return saved;
      });
    }).catch(function (err) {
      state.busy = false;
      console.error('[characterCreate] 保存角色失败', err);
      UI.toast('保存失败：' + ((err && err.message) || '未知错误'), 'error');
      render();
      return null;
    });
  }

  /* ============================================================
   * 九、步骤切换
   * ============================================================ */

  function goStep(n) {
    var next = U.clamp(n, 1, state.totalSteps);
    if (next === state.step) return;
    if (state.busy) {
      UI.toast('正在生成，请先点「停止生成」', 'info');
      return;
    }
    // 第 1 步 → 第 2 步：助手必须选领域
    if (state.step === 1 && next === 2 && state.type === 'assistant' && !state.domain) {
      UI.toast('请先选择领域', 'error');
      return;
    }
    if (state.step === 3 && next === 4 && !validateStep3()) return;

    state.step = next;
    state.busy = false;
    state.genError = null;
    saveDraftNow();
    render();
  }

  /* ============================================================
   * 十、加载与页面注册
   * ============================================================ */

  function applyGenDefaults(settings) {
    var providers = state.providers || [];
    var gen = Kit.resolveGen(providers, settings.providerId || '', settings.model || '');
    if (gen.provider) {
      state.genProviderId = gen.provider.id;
      state.genModel = gen.model || (gen.provider.defaultModel || '');
    }
  }

  App.Router.register(PAGE, {
    title: '新建角色',
    build: function (root, params, page) {
      state.root = root;
      state.page = page;
      state.destroyed = false;
      state.buildId = (state.buildId || 0) + 1;
      var myBuild = state.buildId;
      state.saved = false;
      state.manual = false;
      state.step = 1;
      state.busy = false;
      state.progress = null;
      state.genLive = '';
      state.genChars = 0;
      state.genPhase = 'idle';
      state.genAttempt = 1;
      state.genStartAt = 0;
      state.genEls = null;
      stopGenLoop();

      // 每次进入向导都从干净状态开始（草稿会在下面恢复）
      state.type = 'companion';
      state.domainId = '';
      state.domain = '';
      state.specialty = [];
      state.customSpecialties = [];
      state.selectedWvId = '';
      state.worldview = null;
      state.name = '';
      state.personality = '';
      state.habits = '';
      state.extra = '';
      state.genProviderId = '';
      state.genModel = '';
      state.card = null;
      state.versions = [];
      state.versionIndex = -1;
      state.raw = '';
      state.meta = { providerId: '', model: '', at: 0 };
      state.genError = null;
      state.stopAnim = null;

      if (params && (params.type === 'assistant' || params.type === 'companion')) {
        state.type = params.type;
      }

      page.setTitle('新建角色');

      var pProviders = Kit.loadProviders().then(function (list) {
        state.providers = list || [];
        return null;
      });

      var pWorldviews = Kit.loadWorldviews().then(function (res) {
        state.presets = (res && res.presets) || [];
        state.userWvs = (res && res.users) || [];
        return null;
      });

      var pDraft = Kit.loadDraft(DRAFT_KEY).catch(function () { return null; });

      var pSettings = Promise.all([
        DB.settings.get('character_gen_provider_id', '').catch(function () { return ''; }),
        DB.settings.get('character_gen_model', '').catch(function () { return ''; })
      ]).then(function (arr) {
        return { providerId: arr[0] || '', model: arr[1] || '' };
      });

      return Promise.all([pProviders, pWorldviews, pDraft, pSettings]).then(function (arr) {
        if (state.destroyed) return;
        var draft = arr[2];
        var settings = arr[3];

        applyGenDefaults(settings);

        if (applyDraft(draft)) {
          // 恢复草稿时，用草稿里保存的 API 选择覆盖默认值
          if (state.genProviderId) {
            var found = Kit.findProvider(state.providers, state.genProviderId);
            if (!found) state.genProviderId = '';
            else if (!state.genModel) state.genModel = found.defaultModel || '';
          }
          state.worldview = findWorldviewById(state.selectedWvId);
          // 草稿里选中的自定义世界观可能已被删除：退回「无」
          if (state.selectedWvId && state.selectedWvId !== 'wv-none' && !state.worldview) {
            state.selectedWvId = 'wv-none';
          }
        }

        // 还没选过世界观时，默认「无」
        if (!state.selectedWvId) {
          state.selectedWvId = 'wv-none';
          state.worldview = null;
        }

        render();

        page.setActions([
          { icon: 'close', label: '关闭', onClick: function () { App.Router.pop(); } }
        ]);

        // 从世界观库返回时刷新世界观列表（新自定义世界观可立刻选中）
        var offRouter = null;
        if (App.Router.onChange) {
          offRouter = App.Router.onChange(function (cur) {
            if (state.destroyed || state.buildId !== myBuild || !cur || cur.name !== PAGE) return;
            Kit.loadWorldviews().then(function (res) {
              if (state.destroyed) return;
              state.presets = (res && res.presets) || [];
              state.userWvs = (res && res.users) || [];
              state.worldview = findWorldviewById(state.selectedWvId);
              if (state.step === 2) render();
            }).catch(function (e) {
              console.warn('[characterCreate] 刷新世界观失败', e);
            });
          });
        }

        // 离开页面（含被系统返回键 pop）时保留草稿
        page.onDestroy(function () {
          if (!state.saved) saveDraftNow();
          try { P.cancelCompletion(); } catch (e) { /* 忽略 */ }
          stopGenLoop();
          state.destroyed = true;
          state.busy = false;
          if (typeof offRouter === 'function') offRouter();
        });
      }).catch(function (err) {
        console.error('[characterCreate] 初始化失败', err);
        if (state.destroyed) return;
        UI.clear(root);
        root.appendChild(UI.errorState({
          title: '页面加载失败',
          desc: (err && err.message) || '初始化创建向导时出错，请重试。',
          actionText: '重试',
          onAction: function () { App.Router.replace(PAGE, params || {}); }
        }));
      });
    }
  });
})();
