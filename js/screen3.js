/* AI 内容工厂：文案 → 图片 → 视频分镜 → 发布素材，回答「这个商品的营销内容怎么产出」。
   口径：
   - 商品字段只从 data/app.db 读（DB.products），平台与内容规格只从 data/content.json 读；
   - 文案有三个引擎可选（左栏「文案引擎」）：本地规则拼装 / Dify 工作流 / 本机 Ollama 大模型，
     后两个由网关探活、真调模型，模型输出里带档案外数字的会被当场剔除；图片把商品库真主图合成到 canvas，
     分镜是按商品参数排出来的时间线；
   - 视频渲染与平台发布还没接入：界面直接标「未接入」并写清原因，不演「已生成」。
   版式按设计稿 1:1 复刻（见 css/screen3.css 顶部注释），稿子里的「已生成 / 下载视频」
   这类字样在没有真视频时一律换成诚实状态，其余视觉元素照搬。 */
(function () {
  'use strict';

  const DB = window.DB, DS = window.DS, SHOP = window.SHOP, SHELL = window.SHELL, API = window.API;
  /* ?live=1 必须在这里也切一次：不切则页面写着「模型实时输出」、实际永远走本地规则（与 screen4.js 同一口径）。
     部署版没有网关，这一位带上也只能读到一个不存在的接口，所以忽略它。 */
  if (!window.DB.hosted && new URLSearchParams(location.search).has('live')) API.setProvider('http', { base: location.origin });
  const $ = id => document.getElementById(id);
  const VIEW = '3b';
  /* Tab 的顺序与合法性只有一个出处：data/content.json 的 caps（hero 卡与 Tab 条都按它渲染） */
  const hasTab = id => ((state.spec || {}).caps || []).some(c => c.id === id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  /* ---------- 1920x1080 等比缩放（与前两屏同一口径） ---------- */
  function fitStage() {
    /* 优先按宽度铺满：外壳左栏挤掉的宽度不该由正文两侧裁掉。但窗口比 16:9 矮时只按宽度算，
       舞台会上下各顶出屏幕一截，而 html,body 是 overflow:hidden——那几十像素永远滚不回来，
       顶栏和底部那一排按钮看着就像"没了"。所以高度不够时改按高度缩，代价只是两侧留同色带。 */
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    $('stage').style.transform = `scale(${s})`;
  }
  addEventListener('resize', fitStage);
  fitStage();

  /* ---------- 图标：稿子里每个入口都带一枚线框图标，用内联 SVG 免得再引一套字体 ---------- */
  const ico = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    copy: ico('<path d="M4 20l4.2-1.1L19 8.1 14.9 4 3.9 15 4 20z"/><path d="M13.5 5.4 18.6 10.5"/>'),
    video: ico('<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 11 21 7.5v9L15.5 13z"/>'),
    image: ico('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.8"/><path d="M21 16l-5.2-5.2L7 19.5"/>'),
    publish: ico('<circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="M8.4 10.7 15.7 6.8M8.4 13.3l7.3 3.9"/>'),
    play: ico('<path d="M8 5.5 18.5 12 8 18.5z" fill="currentColor" stroke="none"/>'),
    pause: ico('<rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none"/>'),
    dl: ico('<path d="M12 3.5v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4 18.5h16"/>'),
    cpy: ico('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 5.5h-9a2 2 0 0 0-2 2v9"/>'),
    refresh: ico('<path d="M20 11a8 8 0 1 0-2.3 6.2"/><path d="M20 5.5V11h-5.5"/>'),
    trans: ico('<path d="M3.5 5.5h8"/><path d="M7.5 3.5v2"/><path d="M10 5.5c0 4-3 7.5-6.5 9"/><path d="M6 9.5c1.4 2.2 3.4 3.8 5.5 4.6"/><path d="M12.5 20.5l4-9.5 4 9.5"/><path d="M14 17.2h5"/>'),
    cc: ico('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M9.5 10.5a2.5 2.5 0 1 0 0 3M17 10.5a2.5 2.5 0 1 0 0 3"/>'),
    fs: ico('<path d="M4 9V4h5M20 15v5h-5M20 9V4h-5M4 15v5h5"/>'),
    check: ico('<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>'),
    spark: ico('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
    swap: ico('<path d="M4 8.5h13l-3.2-3.2M20 15.5H7l3.2 3.2"/>'),
    /* 平台标识：只画可辨识的几何轮廓，不引第三方字体或图片 */
    tiktok: '<svg viewBox="0 0 24 24"><path d="M16.2 3h-2.6v12.1a2.55 2.55 0 1 1-2.55-2.55c.26 0 .5.04.74.11V10a5.4 5.4 0 0 0-.74-.05A5.15 5.15 0 1 0 16.2 15.1V8.6a6.1 6.1 0 0 0 3.5 1.1V7.1A3.6 3.6 0 0 1 16.2 3z" fill="#eaf4ff"/></svg>',
    instagram: '<svg viewBox="0 0 24 24"><defs><linearGradient id="ig" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#fccc63"/><stop offset=".35" stop-color="#fb503b"/><stop offset=".7" stop-color="#c4367c"/><stop offset="1" stop-color="#5b51a5"/></linearGradient></defs><rect x="3" y="3" width="18" height="18" rx="5" fill="url(#ig)"/><circle cx="12" cy="12" r="4.1" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="17.2" cy="6.9" r="1.3" fill="#fff"/></svg>',
    youtube: '<svg viewBox="0 0 24 24"><rect x="2" y="5.5" width="20" height="13" rx="3.6" fill="#ff3b30"/><path d="M10.2 9.2 15.4 12l-5.2 2.8z" fill="#fff"/></svg>',
    facebook: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.4" fill="#1877f2"/><path d="M14.7 12.4h-1.9v6.1h-2.6v-6.1H8.6v-2.2h1.6V8.6a2.9 2.9 0 0 1 3.2-3.2h2v2.3h-1.4c-.7 0-1 .3-1 1v1.2h2.4z" fill="#fff"/></svg>',
    shopify: '<svg viewBox="0 0 24 24"><path d="M15.4 4.6s-.9.6-2.2.9l-2.5 12 5.6 1.1 1.9-11.5c-1.4-.9-2.7-2.4-2.8-2.5z" fill="#95bf47"/><path d="M15.4 4.6c-.2-.1-2.1-.4-4.7.3L6.2 7l-.5 7.7 5.4 1.9s-3.7-8.9 4.3-12z" fill="#5e8e37"/></svg>',
    amazon: '<svg viewBox="0 0 24 24"><path d="M3.5 15.6c2.4 1.7 5.4 2.6 8.5 2.6 3 0 5.9-.9 8.3-2.5" stroke="#ff9900" stroke-width="1.9" fill="none" stroke-linecap="round"/><path d="M19.6 15.1c.6.5 1.3.6 1.7.3.4-.4.2-1.2-.5-2-.6-.8-1.7-1.6-2.4-1.9" stroke="#ff9900" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M6 7.2c1.4-.7 3.2-1 4.6-1 2.6 0 4.2 1.2 4.2 3.1v4.2" stroke="#eaf4ff" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>',
    woocommerce: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="#7f54b3" stroke-width="1.9"/><path d="M6.6 9.4 8.9 15l2.2-4.2L13.3 15l2.3-5.6" stroke="#7f54b3" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  const BRAND = { tiktok: ICON.tiktok, instagram: ICON.instagram, youtube: ICON.youtube, facebook: ICON.facebook, shopify: ICON.shopify, amazon: ICON.amazon, woocommerce: ICON.woocommerce };
  const VTYPE_IC = { show: ICON.video, scene: ICON.image, unbox: ICON.cpy, ad: ICON.spark };

  const STEPS = [{ id: 'pick', t: '选择商品' }, { id: 'style', t: '选择风格' }, { id: 'gen', t: '生成内容' }, { id: 'out', t: '预览下载' }];
  /* 第 3 步的名字跟着 Tab 走：稿子里视频页写的就是「生成视频」 */
  const STEP3 = { copy: '生成文案', image: '生成图片', video: '生成视频', publish: '生成素材包' };
  const GEN_LABEL = { copy: '开始生成文案', image: '开始生成图片', video: '开始生成视频', publish: '开始生成素材包' };
  const GEN_KEY = { copy: 'copy', image: 'image', video: 'video', publish: 'pkg' };
  const GEN_NAME = { copy: '文案', image: '图片', video: '分镜', publish: '素材包' };
  /* 一键跑全套的顺序：文案在第一个，后面三项的字段口径都拿它当底。
     最后一项叫「素材包」不叫「发布」——平台全是未连接，跑出的是导出件，不是发出去的东西。 */
  const ALL_STEPS = [{ k: 'copy', t: '文案' }, { k: 'image', t: '主图' }, { k: 'video', t: '分镜' }, { k: 'publish', t: '素材包' }];
  const ALL_ST = { wait: '·', run: '…', ok: '✓', no: '✗', skip: '—' };
  /* 历史条目说的是「这一类产物生成没生成」：视频只排过分镜，就不能说视频已生成 */
  const HIST_PILL = { copy: '已生成', image: '已生成', video: '分镜已排', publish: '已打包' };

  const state = {
    spec: null, prods: [], plats: [], prodId: null, tab: 'copy', ready: false,
    lang: 'en', chan: 'tiktok', imgSize: 'sq', vType: 'show', vStyle: 'tech', dur: 30,
    selPlat: [], pickOpen: false, busy: false, toast: null, histAll: false, cc: true,
    /* 文案引擎：local = 把商品字段拼成句子（不调模型）；dify / ollama = 真让模型写一版。
       默认 local，因为回归遍历与截图都要求可复现；点左栏那颗芯片才会切过去。 */
    engine: 'local', engines: [],
    /* 视频渲染引擎与每一镜的作业：来自 /api/video/status 与 /api/video/jobs，页面不自己编状态。
       note 在没探测成功时就是给用户看的原因，不能留空。 */
    veng: { on: false, model: '', note: '尚未探测' }, vjobs: {}, vbusy: false,
    /* 文生图与视频同构：ieng 是探活结果，ijobs 按视觉风格索引（一种风格一张底图），ibusy 只撑着按钮那一格 */
    ieng: { on: false, model: '', note: '尚未探测' }, ijobs: {}, ibusy: false,
    gen: { copy: null, image: null, video: null, pkg: null },
    /* 一键跑全套的运行态：busy 期间左栏的「开始生成」和换设置全部让路，
       steps 跑完不清空——它撑着顶部那一行「文案 ✓ 主图 ✓ …」的结论。 */
    allRun: { busy: false, abort: false, steps: [], line: '', seq: 0 },
    hist: [], shot: 0, play: { on: false, at: 0 }
  };

  const cap = id => (state.spec.caps.filter(c => c.id === id)[0] || {});
  const chan = k => state.spec.channels.filter(c => c.key === k)[0] || state.spec.channels[0];
  const vType = k => state.spec.videoTypes.filter(t => t.key === k)[0] || state.spec.videoTypes[0];
  const vStyle = k => state.spec.videoStyles.filter(s => s.key === k)[0] || state.spec.videoStyles[0];
  /* 不传参就是「当前选中的尺寸」：漏了参数会退回首项，下载文件名与回执会说错尺寸 */
  const imgSize = k => { const key = k === undefined ? state.imgSize : k; return state.spec.imageSizes.filter(s => s.key === key)[0] || state.spec.imageSizes[0]; };
  const prod = () => state.prods.filter(p => p.id === state.prodId)[0] || null;
  const langName = k => (state.spec.langs.filter(l => l.key === k)[0] || { t: k }).t;
  /* 按字形判一段文本是哪种语种：模型现在会按页面语种回中文 SEO/FAQ，不能再假设"非英文一律英文口径" */
  const scriptOf = s => (/[\u3040-\u30ff]/.test(s) ? 'ja' : /[\u4e00-\u9fff]/.test(s) ? 'zh'
    : /[A-Za-z]{3}/.test(s) ? 'lat' : 'none');
  const scriptName = { ja: '日文', zh: '中文', lat: '英文', none: '空白' };
  const wantScript = k => (k === 'zh' ? 'zh' : k === 'ja' ? 'ja' : 'lat');
  const capName = k => (state.spec.caps.filter(c => c.id === k)[0] || { t: k }).t;
  const copyGen = () => state.gen.copy;
  /* 生成结果的来源以 evidence 里有没有 live 行为准，不看界面自己怎么说 */
  const isLive = g => !!(g && g.c && (g.c.evidence || []).some(e => e.src === 'live'));
  /* 底图只有一个口径：这一件商品、这一种视觉风格跑成了 AI 图就用它，否则回落到商品库那张占位 SVG。
     两种都不是实拍，画面上那行说明跟着换，不能因为换了来源就把「非实拍」丢掉。 */
  const aiImg = p => { const j = p && state.ijobs[state.vStyle]; return j && j.file ? j : null; };
  const imgOf = p => (p ? ((aiImg(p) || {}).file || p.image || 'data/img/' + p.id + '.svg') : '');
  const imgSrcNote = p => { const j = aiImg(p);
    return j ? 'AI 文生图 · ' + (j.model || state.ieng.model) + ' · 非实拍' : '商品库占位图 · 非实拍'; };

  /* ---------- 小工具 ---------- */
  function evHtml(list, title) {
    if (!list || !list.length) return '';
    return `<div class="ai-ev"><div class="ai-ev-t">${esc(title || '依据 · 指标 / 数值 / 来源')}</div>`
      + list.map(e => `<div class="r"><b>${esc(e.label)}</b><s>${esc(e.value)}</s><em>${esc(e.src)}</em></div>`).join('')
      + '</div>';
  }
  const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  const stamp = s => String(s || '').slice(5, 16);
  /* 网关可能已经把 output 解成对象了，别对对象再 JSON.parse 一次 */
  const jparse = (s, dft) => {
    if (s && typeof s === 'object') return s;
    try { return JSON.parse(s || null) || dft; } catch (e) { return dft; }
  };

  function dl(name, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function copyText(txt, btn) {
    const done = () => { const t = btn.innerHTML; btn.innerHTML = ICON.check + '<span>已复制</span>'; setTimeout(() => { btn.innerHTML = t; }, 1400); };
    const area = document.createElement('textarea');
    area.value = txt; area.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(area); area.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* 交给 clipboard API 兜底 */ }
    document.body.removeChild(area);
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, () => {});
  }
  /* 回执条就地更新：下载 / 导出这类动作不会触发整屏 render，等 render 才看不见 */
  function toast(msg) {
    state.toast = msg;
    const mid = $('cfMid'); if (!mid) return;
    let el = $('cfToast');
    if (!el) {
      el = document.createElement('div'); el.id = 'cfToast'; el.className = 'ai-note ok';
      mid.insertBefore(el, mid.firstChild);
    }
    el.textContent = msg;
  }

  /* ---------- 加载 ---------- */
  function loadSpec() {
    return fetch('data/content.json?v=2').then(r => {
      if (!r.ok) throw new Error('内容规范 data/content.json 加载失败 HTTP ' + r.status);
      return r.json();
    });
  }
  /* 引擎探活由网关做（浏览器去连 Ollama/Dify 都会被 CORS 拦）：这里只摆它给出的三个选项，
     连不上的那个直接写明原因，不假装可选。 */
  function loadEngines() {
    return DB.raw('/api/ai/engines').then(j => {
      state.engines = ((j || {}).data || {}).items || [];
      const q = new URLSearchParams(location.search).get('engine');
      /* 默认就选真能写作的模型：点「开始生成文案」要的是模型写，不是把档案字段拼一遍。
         只有显式 ?engine=local、或本机一个模型都没起来时，才回到本地拼装。 */
      const hit = q ? state.engines.filter(e => e.key === q && e.on)[0]
        : state.engines.filter(e => e.on && e.key !== 'local')[0];
      if (hit) useEngine(hit.key);
    }, () => { state.engines = []; });
  }
  const engineOf = k => state.engines.filter(e => e.key === k)[0] || { key: 'local', t: '本地规则引擎', on: true };
  function useEngine(k) {
    state.engine = k;
    /* 只有走网关才可能调到模型：本地规则留在 mock provider，页面行为与回归口径都不变。
       部署版根本没有网关，切过去只会读到一个不存在的接口，所以那一版永远留在本地拼装。 */
    if (k !== 'local' && !DB.hosted) API.setProvider('http', { base: location.origin });
  }
  function loadProds() {
    return DB.products({ limit: 200 }).then(d => {
      state.prods = d.items || [];
      if (!state.prods.some(p => p.id === state.prodId)) state.prodId = (state.prods[0] || {}).id || null;
    });
  }
  function loadPlats() {
    return DB.platforms().then(d => {
      state.plats = d.items || [];
      state.selPlat = state.selPlat.filter(k => state.plats.some(p => p.key === k));
      if (!state.selPlat.length) state.selPlat = state.plats.slice(0, 2).map(p => p.key);
    });
  }
  function loadHist() {
    return DB.aiOps({ kind: 'content', limit: 8 }).then(d => { state.hist = d.items || []; }, () => { state.hist = []; });
  }
  /* 每次生成落一条 ai_ops：这是「最近生成」能点开回看的前提 */
  function logGen(out, evidence) {
    return DB.logOp({
      kind: 'content', entity: 'products', entity_id: state.prodId,
      input: { prod: state.prodId, tab: out.tab }, output: out, evidence: evidence || [],
      model: out.model || (out.live ? '模型' : '本地规则'), live: !!out.live, applied: false
    }).then(loadHist, () => {});
  }

  /* ---------- 产物是否跟得上当前设置 ---------- */
  function sig(tab) {
    const p = prod() || {};
    const head = p.id + '|' + (p.updated_at || '');
    if (tab === 'copy') return head + '|' + state.lang + state.chan + state.engine;
    if (tab === 'image') return head + '|' + state.vStyle + state.lang;
    if (tab === 'video') return head + '|' + state.vType + state.vStyle + state.chan + state.dur + state.lang;
    return head + '|' + state.selPlat.join(',') + state.lang;
  }
  const genOf = tab => state.gen[GEN_KEY[tab]];
  const stale = tab => !!genOf(tab) && genOf(tab).sig !== sig(tab);

  /* ---------- 文案 ---------- */
  function makeCopy(note) {
    const p = prod();
    if (!p) return Promise.resolve(null);
    /* 「重新生成」「翻译」「先文案再出图」都不经过 cfGen 那颗禁用键：连点两下就是两次按 token 计钱的调用，
       后一稿还会顶掉前一稿——先把重复提交挡在入口 */
    if (state.busy) { toast('这一稿还在模型里写 · 等它出来再看，连点会重复提交、多算一次钱'); return Promise.resolve(null); }
    state.busy = true; render();
    const ch = chan(state.chan);
    return SHOP.optimize(p.id, p.target_country, {
      engine: state.engine, lang: state.lang, channel: ch.name,
      titleMax: ch.titleMax, tagMax: ch.tagMax, descMax: ch.descMax
    }).then(r => {
      state.busy = false;
      /* API.ai.invoke 的返回带传输包装 {data, meta}，这里先剥壳再看引擎说了什么 */
      const c = r && r.data !== undefined ? r.data : r;
      const m = (r && r.meta) || null;
      if (!c || c.error) { toast('文案生成失败：' + esc(c && c.error || '引擎无返回')); render(); return null; }
      if (!c.title) { toast('文案生成失败：引擎返回里没有标题字段'); render(); return null; }
      const live = (m && m.src === 'live') || !!(c.evidence || []).some(e => e.src === 'live');
      /* 徽标要说人话：ollama:qwen3:latest 这种内部标识摆在标题位上，用户读不出这是谁写的 */
      const model = live ? '模型实时输出 · ' + String((m && m.model) || c.engine || '模型').replace(/^(ollama|dify):/i, '') : '本地规则拼装';
      state.gen.copy = { sig: sig('copy'), at: Date.now(), c: c, live: live, model: model, prodId: p.id };
      /* 选了模型却没跑成，必须当面说：悄悄退回模板拼出来的东西顶着「AI 生成」的名字最伤人 */
      const fell = m && m.fallback;
      toast(note || (fell && state.engine !== 'local'
        ? engineOf(state.engine).t + '没有跑成 · 这一版仍是本地拼装：' + fell
        : '已生成「' + p.name + '」· ' + langName(state.lang) + ' 版 · ' + model));
      return logGen({ tab: 'copy', lang: state.lang, chan: state.chan, live: live, model: model, copy: c }, c.evidence).then(() => { render(); return state.gen.copy; });
    }, err => {
      state.busy = false; toast('文案生成失败：' + (err && err.message || err)); render(); return null;
    });
  }

  /* ---------- 分镜：字幕全部落在商品档案的真实字段上，缺的就写【待填】 ---------- */
  function segCaptions(p) {
    const a = p.attrs || {};
    const facts = Object.keys(a).map(k => k + '：' + a[k]);
    const kw = p.keywords || [];
    const price = p.price ? 'US$' + p.price : '【待填：售价】';
    const moq = a.moq || '【待填：起订量】';
    const lead = a.lead || '【待填：发货时效】';
    return {
      '产品外观': p.name + ' · ' + (p.category || ''),
      '细节特写': facts[0] || '【待填：细节参数】',
      '核心参数': facts.slice(0, 3).join(' ｜ ') || '【待填：核心参数】',
      '功能演示': facts[1] || '【待填：主打功能】',
      '对比场景': facts[2] || '与同价位对比：见商品库 attrs 字段',
      '场景引入': p.audience || '【待填：目标人群】',
      '痛点镜头': '使用场景关键词：' + (kw[0] || p.category || '【待填】'),
      '产品出场': p.name,
      '使用过程': facts.slice(0, 2).join(' ｜ ') || '【待填：使用方式】',
      '效果反馈': facts[3] || '【待填：实测结果】',
      '包裹开箱': '外包装 + 配件（' + moq + '）',
      '配件清单': '【待填：包装清单】',
      '上手第一感': facts[0] || '【待填：主观体验】',
      '关键参数实测': facts.slice(0, 3).join(' ｜ ') || '【待填：实测数据】',
      '优缺点小结': '优点：' + (facts[0] || '【待填】') + '｜待确认：' + ((p.issues || [])[0] || '无登记缺口'),
      '3 秒钩子': (p.category || '新品') + ' · ' + (facts[0] || '【待填：钩子卖点】'),
      '卖点连击': facts.slice(0, 3).join(' + ') || '【待填：卖点】',
      '价格与活动': price + ' · ' + moq,
      '信任背书': lead + '｜数据源：' + (p.source || '商品库'),
      '限时提示': '库存 ' + (p.stock == null ? '【待填】' : p.stock) + ' 件（商品库字段）',
      '结尾 CTA': chan(state.chan).name + ' 搜 ' + (kw[0] || p.id) + ' · ' + price
    };
  }
  function segList(p) {
    const t = vType(state.vType), per = state.dur / t.segs.length, capMap = segCaptions(p);
    const shots = ['全景推进', '微距平移', '图文叠层', '手持特写', '分屏对比', '字幕收口'];
    return t.segs.map((name, i) => ({
      name: name, from: +(per * i).toFixed(1), to: +(per * (i + 1)).toFixed(1),
      cap: capMap[name] || '【待填：本镜文案】', shot: shots[i % shots.length]
    }));
  }
  function segEvidence(p) {
    const s = videoStat();
    return [
      { label: '分镜条数与时长', value: vType(state.vType).segs.length + ' 镜均分 ' + state.dur + 's', src: 'struct' },
      { label: '字幕里的参数', value: 'products.' + p.id + ' 的 attrs / keywords / price / stock', src: 'db' },
      { label: '平台比例与规范', value: chan(state.chan).name + ' · ' + chan(state.chan).ratio.join(':') + ' · data/content.json', src: 'struct' },
      /* 这一行只报探测与作业的真实结果：网关没起来、没配 key、跑了几镜，都从这里读 */
      state.veng.on
        ? { label: '视频渲染', value: state.veng.model + ' 可用 · 已出片 ' + s.ok + '/' + s.all + ' 镜'
            + (s.run ? ' · 在跑 ' + s.run : '') + (s.fail ? ' · 失败 ' + s.fail : '') + '（' + state.veng.note + '）', src: 'live' }
        : { label: '视频渲染', value: '未接入 · ' + (state.veng.note || '未探测'), src: 'gap' }
    ];
  }
  function makeVideo(note, tips) {
    const p = prod();
    if (!p) return Promise.resolve(null);
    state.gen.video = { sig: sig('video'), at: Date.now(), segs: segList(p), tips: tips || null, prodId: p.id };
    state.shot = 0; state.play = { on: false, at: 0 }; stop(); stopPoll();
    /* 重排分镜不重跑渲染：作业按「商品号 + 镜名」存，同名那一镜上一轮出的片子还在就继续算 */
    return Promise.all([logGen({ tab: 'video', vType: state.vType, vStyle: state.vStyle, chan: state.chan, dur: state.dur, lang: state.lang, segs: state.gen.video.segs }, segEvidence(p)), loadVideoJobs()])
      .then(() => {
        const s = videoStat();
        toast(note || ('已排出 ' + s.all + ' 镜分镜 · ' + state.dur + 's · '
          + (state.veng.on ? '模型可用，逐镜点「渲染这一镜」出真片' : '渲染未接入：' + state.veng.note))
          + (s.ok ? ' · 已有 ' + s.ok + ' 镜出片' : ''));
        render();
        if (s.run) pollJobs(true);
        return state.gen.video;
      });
  }
  /* 「一键优化」不装饰：读商品档案里登记的缺口，逐条落到具体某一镜 */
  function applyVideoTips() {
    const p = prod(); if (!p) return;
    const issues = (p.issues || []).slice(0, 3);
    if (!issues.length) { toast('商品档案里没有登记的内容缺口 · 无需优化'); render(); return; }
    if (/场景/.test(issues.join(' '))) state.vType = 'scene';
    const tips = issues.map((s, i) => {
      const n = (i + 1) % 6 + 1;
      return { issue: s, seg: n, action: '第 ' + n + ' 镜字幕补：' + s };
    });
    makeVideo('已按 ' + issues.length + ' 条商品缺口重排分镜 · 类型「' + vType(state.vType).t + '」', tips);
  }

  /* ---------- 真渲染：通义万相文生视频（走网关 /api/video/*，百炼密钥只在 tools/video.env） ----------
     页面只报三件事：模型接没接、每一镜跑到哪一步、跑成的片子在本地哪个文件。
     探不到就是探不到，把原因写在按钮旁边，绝不演一段假进度。 */
  function vpost(url, body) {
    /* 契约不变：永远 resolve 成一个可能带 error 的 body，调用方照着摆原因。
       部署版的 reject 就是那句「只读快照没有后端可写」，得转成同一个形状。 */
    return DB.rawPost(url, body).catch(e => ({
      error: e.status ? DB.downMessage(e) : '请求 ' + url + ' 失败：网关没起来？'
    }));
  }
  function loadVideoEngine(force) {
    return DB.raw('/api/video/status', force ? { force: 1 } : null).then(j => {
      const d = (j || {}).data;
      state.veng = d && d.engine === 'video' ? d : { on: false, model: '', note: '/api/video/status 没有返回 · 这个网关版本还没有视频接缝' };
    }, e => { state.veng = { on: false, model: '', note: DB.hosted ? DB.offNote : '连不上 /api/video/status（网关未启动或版本过旧）' }; });
  }
  /* 作业按镜名索引：分镜重排后同一镜名仍对应同一条作业（jobId = 商品号 + 镜名散列） */
  function loadVideoJobs() {
    if (!state.prodId) { state.vjobs = {}; return Promise.resolve(); }
    return DB.raw('/api/video/jobs', { product_id: state.prodId }).then(j => {
      const m = {};
      (((j || {}).data || {}).items || []).forEach(x => { m[x.seg] = x; });
      state.vjobs = m;
    }, () => { state.vjobs = {}; });
  }
  const loadVideo = () => Promise.all([loadVideoEngine(), loadVideoJobs()]);
  const jobOf = seg => (seg && state.vjobs[seg.name]) || null;
  /* 有本地文件才算"这一镜有片子了"：SUCCEEDED 但没取回文件仍然不能播，note 会写为什么 */
  const clipOf = seg => { const j = jobOf(seg); return j && j.file ? j : null; };
  function videoStat() {
    const g = state.gen.video, s = { run: 0, ok: 0, fail: 0, all: g ? g.segs.length : 0 };
    if (g) g.segs.forEach(x => {
      const j = jobOf(x); if (!j) return;
      if (j.file) s.ok++;
      else if (j.status === 'FAILED') s.fail++;
      else if (j.task_id) s.run++;
    });
    return s;
  }
  let vtimer = 0;
  function stopPoll() { if (vtimer) { clearTimeout(vtimer); vtimer = 0; } }
  /* 提交之后每 5 秒查一次任务，跑完或失败就停手；切走 Tab / 换商品也要停 */
  function pollJobs(quiet) {
    stopPoll();
    const run = videoStat().run;
    if (!run) { if (!quiet) toast('没有正在渲染的镜头 · 按上面「渲染这一镜」才会提交任务'); return Promise.resolve(); }
    return vpost('/api/video/refresh', { id: state.prodId }).then(r => {
      if (r.error) { toast('查询渲染进度失败：' + r.error); return; }
      /* 这里不能 force 重探：force 等于"用户说处理好了"，会把刚记下的额度墙清掉，界面跟着来回翻 */
      if (r.meta && r.meta.fallback) { toast(r.meta.fallback); return loadVideoEngine().then(render); }
      const pend = ((r.data || {}).pending || 0);
      return loadVideoJobs().then(() => {
        render();
        const s = videoStat();
        if (pend) {
          /* 切走 Tab 就停手：任务还在百炼那边跑，回来时 loadVideo 会重新读到状态，不必在后台空转轮询 */
          vtimer = setTimeout(() => { if (state.tab === 'video' && genOf('video')) pollJobs(true); }, 5000);
          if (!quiet) toast('还在渲染 ' + pend + ' 镜 · 每 5 秒查一次百炼任务');
        }
        else toast('渲染回来了 ' + s.ok + '/' + s.all + ' 镜（本地文件在 data/video/）' + (s.fail ? ' · ' + s.fail + ' 镜失败，原因写在画面下面那行' : ''));
      });
    });
  }
  /* 一镜一提交：同一镜已有在跑或已跑成的作业，网关会直接回那一条，不会重复花钱 */
  function renderShot(i) {
    const g = state.gen.video;
    if (!g) return noVideo();
    const seg = g.segs[i];
    if (!seg) return;
    if (!state.veng.on) {
      toast('视频渲染未接入 · ' + (state.veng.note || '原因未返回') + ' · 配好 key 要重启网关（node tools/proxy.mjs）');
      return;
    }
    state.vbusy = i; render();
    vpost('/api/video/submit', { id: state.prodId, seg: seg, ratio: chan(state.chan).ratio.join(':') }).then(r => {
      state.vbusy = false;
      if (r.error) { toast('任务没提交出去：' + r.error); render(); return; }
      /* 这里不能 force 重探：force 等于"用户说处理好了"，会把刚记下的额度墙清掉，界面跟着来回翻 */
      if (r.meta && r.meta.fallback) { toast(r.meta.fallback); return loadVideoEngine().then(render); }
      return loadVideoJobs().then(() => {
        const j = (r.data || {}).job || {};
        toast((r.data || {}).reuse || ('第 ' + (i + 1) + ' 镜「' + seg.name + '」已交给 ' + state.veng.model
          + ' · ' + j.duration + 's · ' + j.ratio + ' · ' + (j.status || 'PENDING') + '，每 5 秒查一次进度'));
        render();
        pollJobs(true);
      });
    });
  }

  /* ---------- 真底图：通义万相文生图（走网关 /api/image/*，key 同样只在 tools/video.env） ----------
     一张图 = 一件商品的一种视觉风格；跑成的图落在 data/img/ai/，三种版式都从这一张方图裁。
     这一步按张计钱，所以只有用户当面按「生成真底图」才提交：进页面、换商品、换风格都不自动跑。 */
  function loadImageEngine(force) {
    return DB.raw('/api/image/status', force ? { force: 1 } : null).then(j => {
      const d = (j || {}).data;
      state.ieng = d && d.engine === 'image' ? d : { on: false, model: '', note: '/api/image/status 没有返回 · 这个网关版本还没有文生图接缝' };
    }, e => { state.ieng = { on: false, model: '', note: DB.hosted ? DB.offNote : '连不上 /api/image/status（网关未启动或版本过旧）' }; });
  }
  /* 作业按视觉风格索引：一种风格一张底图，换风格看到的是另一张，不是同一张换个色 */
  function loadImageJobs() {
    if (!state.prodId) { state.ijobs = {}; return Promise.resolve(); }
    return DB.raw('/api/image/jobs', { product_id: state.prodId }).then(j => {
      const m = {};
      (((j || {}).data || {}).items || []).forEach(x => { m[x.style] = x; });
      state.ijobs = m;
    }, () => { state.ijobs = {}; });
  }
  const loadImage = () => Promise.all([loadImageEngine(), loadImageJobs()]);
  let itimer = 0;
  function stopImgPoll() { if (itimer) { clearTimeout(itimer); itimer = 0; } }
  const imgJob = () => state.ijobs[state.vStyle] || null;
  function pollImages(quiet) {
    stopImgPoll();
    const j = imgJob();
    if (!j || !j.task_id || j.file || j.status === 'FAILED') {
      if (!quiet) toast('这一风格没有正在跑的作业 · 按「生成真底图」才会提交任务');
      return Promise.resolve();
    }
    return vpost('/api/image/refresh', { id: state.prodId }).then(r => {
      if (r.error) { toast('查询生图进度失败：' + r.error); return; }
      /* 这里不能 force 重探：force 等于"用户说处理好了"，会把刚记下的额度墙清掉，界面跟着来回翻 */
      if (r.meta && r.meta.fallback) { toast(r.meta.fallback); return loadImageEngine().then(render); }
      return loadImageJobs().then(() => {
        render();
        const n = imgJob() || {};
        if (n.file) { toast('底图回来了：' + n.file + '（' + Math.round((n.bytes || 0) / 1024) + ' KB · ' + (n.model || '') + '）· 海报已经换成它'); return; }
        if (n.status === 'FAILED') { toast('这张图没跑成：' + (n.note || '百炼返回 FAILED')); return; }
        /* 切走 Tab 就停手：任务还在百炼那边跑，回来时 loadImage 会重新读到状态，不必在后台空转轮询 */
        itimer = setTimeout(() => { if (state.tab === 'image') pollImages(true); }, 5000);
        if (!quiet) toast('还在跑（' + (n.status || 'PENDING') + '）· 每 5 秒查一次百炼任务');
      });
    });
  }
  function genImage() {
    if (!state.ieng.on) {
      toast('文生图未接入 · ' + (state.ieng.note || '原因未返回') + ' · 配好 key 要重启网关（node tools/proxy.mjs）');
      return;
    }
    const st = vStyle(state.vStyle);
    state.ibusy = true; render();
    vpost('/api/image/submit', { id: state.prodId, style: state.vStyle }).then(r => {
      state.ibusy = false;
      if (r.error) { toast('任务没提交出去：' + r.error); render(); return; }
      if (r.meta && r.meta.fallback) { toast(r.meta.fallback); return loadImageEngine().then(render); }
      return loadImageJobs().then(() => {
        const j = (r.data || {}).job || {};
        toast((r.data || {}).reuse || ('「' + st.t + '」的一张底图已交给 ' + state.ieng.model
          + ' · ' + (j.px || '1024*1024') + ' · ' + (j.status || 'PENDING') + '，每 5 秒查一次进度'));
        render();
        pollImages(true);
      });
    });
  }

  /* ---------- 图片：真主图 + 真文案合成 ---------- */
  const imgCache = {};
  function imgFor(src) {
    if (!imgCache[src]) { const im = new Image(); im.src = src; imgCache[src] = im; }
    return imgCache[src];
  }
  function wrap(ctx, text, maxW) {
    const chars = String(text || '').split(''); const lines = []; let cur = '';
    chars.forEach(ch => {
      if (cur && ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; } else cur += ch;
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function posterText() {
    const p = prod() || {}, g = copyGen();
    const c = g && g.c;
    /* 海报上的卖点跟着中栏走：模型写过一版之后，画面上不该还是拼装那五条 */
    const bullets = c ? ((c.modelBullets || []).length ? c.modelBullets
      : (c.bullets || []).map(b => b[state.lang] || b.en).filter(Boolean))
      : Object.keys(p.attrs || {}).slice(0, 3).map(k => k + '：' + p.attrs[k]);
    const T = (c && c.title) || {};
    return {
      title: (c ? (T[state.lang] || T.en) : '') || p.name_en || p.name || '',
      bullets: bullets.slice(0, 3),
      tags: ((c && c.tags) || p.tags || []).slice(0, 5),
      from: c ? (g.live ? '模型文案' : '本地规则文案') : '商品库字段'
    };
  }
  function drawPoster(cv, sizeKey) {
    const p = prod(); if (!p || !cv) return;
    const s = imgSize(sizeKey), st = vStyle(state.vStyle), tx = posterText();
    const W = cv.width = s.w, H = cv.height = s.h, r = W / 1080;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, st.bg[0]); g.addColorStop(1, st.bg[1]);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(125,180,255,.35)'; c.lineWidth = 2 * r;
    c.strokeRect(28 * r, 28 * r, W - 56 * r, H - 56 * r);
    const hd = s.key === 'hd';
    const box = Math.min(W, H) * (hd ? .74 : .46);
    const bx = hd ? 60 * r : (W - box) / 2, by = hd ? (H - box) / 2 : 90 * r;
    const ty = hd ? by + box + 24 * r : by + box + 34 * r;
    const im = imgFor(imgOf(p));
    const body = () => {
      if (im.complete && im.naturalWidth) {
        c.globalAlpha = .95; c.drawImage(im, bx, by, box, box); c.globalAlpha = 1;
      }
      c.textBaseline = 'top';
      c.fillStyle = '#ffffff'; c.font = '700 ' + Math.round(44 * r) + 'px system-ui, sans-serif';
      clipWrap(c, tx.title, W - 120 * r, 2).forEach((ln, i) => c.fillText(ln, 60 * r, ty + i * 56 * r));
      c.fillStyle = st.fg; c.font = '400 ' + Math.round(28 * r) + 'px system-ui, sans-serif';
      tx.bullets.forEach((b, i) => c.fillText('· ' + b, 60 * r, ty + 122 * r + i * 42 * r));
      c.fillStyle = st.accent; c.font = '600 ' + Math.round(26 * r) + 'px system-ui, sans-serif';
      c.fillText(tx.tags.map(x => '#' + x).join(' ').slice(0, 72), 60 * r, H - 108 * r);
      c.fillStyle = 'rgba(160,195,240,.62)'; c.font = '400 ' + Math.round(22 * r) + 'px system-ui, sans-serif';
      c.fillText(imgSrcNote(p) + '（' + imgOf(p) + '）', 60 * r, H - 66 * r);
    };
    if (im.complete) body(); else { im.onload = body; im.onerror = body; }
  }
  function makeImage(note) {
    const p = prod(); if (!p) return Promise.resolve(null);
    state.gen.image = { sig: sig('image'), at: Date.now(), prodId: p.id };
    const ev = [
      { label: '底图素材', value: imgSrcNote(p) + ' · ' + imgOf(p), src: aiImg(p) ? 'live' : 'db' },
      { label: '画面文字', value: posterText().from + ' · 标题 + 3 条卖点', src: copyGen() ? 'live' : 'db' },
      { label: '版式', value: imgSize().t + ' ' + imgSize().w + '×' + imgSize().h + ' · 风格「' + vStyle(state.vStyle).t + '」', src: 'struct' }
    ];
    return logGen({ tab: 'image', size: state.imgSize, style: state.vStyle, lang: state.lang, live: isLive(copyGen()) }, ev)
      .then(() => { toast(note || ('已合成 ' + imgSize().t + ' · ' + imgSrcNote(p))); render(); return state.gen.image; });
  }

  /* ---------- 素材包 ---------- */
  const FIELD_MAP = {
    shopify: { 标题: 'title', 描述: 'body_html', 关键词: 'tags', 图片: 'image.src', 库存: 'inventory_quantity' },
    amazon: { 标题: 'item_name', 描述: 'product_description', 关键词: 'generic_keyword', 图片: 'main_product_image_locator', 库存: 'quantity' },
    tiktok: { 标题: 'title', 描述: 'description', 关键词: 'tags', 图片: 'main_images', 库存: 'inventory_info' },
    woocommerce: { 标题: 'name', 描述: 'description', 关键词: 'tags', 图片: 'images[0].src', 库存: 'stock_quantity' }
  };
  function fieldValue(p, k) {
    const g = copyGen(), c = g && g.c, L = state.lang;
    if (k === '标题') return c ? ((c.title || {})[L] || (c.title || {}).en) : (p.name_en || p.name);
    if (k === '描述') return c ? ((c.description || {})[L] || (c.description || {}).en) : p.description;
    if (k === '关键词') return c ? ((c.seo || {}).added || []).join(', ') : (p.keywords || []).join(', ');
    if (k === '图片') return imgOf(p);
    if (k === '库存') return String(p.stock);
    return '';
  }
  function pkgFor(pl) {
    const p = prod() || {}, map = FIELD_MAP[pl.key] || { 标题: 'title', 描述: 'description' };
    return {
      key: pl.key, name: pl.name, auth: pl.auth, caps: pl.capabilities || [], configured: !!pl.configured,
      rows: Object.keys(map).map(k => ({ f: map[k], v: String(fieldValue(p, k) || ''), src: '商品库' }))
        .concat([{ f: 'connected', v: 'false · 未向 ' + pl.name + ' 发出任何请求', src: '未接入' }])
    };
  }
  function makePkg() {
    const p = prod(); if (!p) return Promise.resolve(null);
    if (!state.selPlat.length) { toast('还没有勾选平台 · 左栏至少选一个'); render(); return Promise.resolve(null); }
    const items = state.plats.filter(pl => state.selPlat.indexOf(pl.key) >= 0).map(pkgFor);
    state.gen.pkg = { sig: sig('publish'), at: Date.now(), prodId: p.id, items: items };
    return logGen({ tab: 'publish', plats: state.selPlat, lang: state.lang, live: isLive(copyGen()) }, [
      { label: '素材来源', value: (copyGen() ? '已生成文案 + ' : '') + '商品库字段', src: 'db' },
      { label: '平台状态', value: items.map(i => i.name + (i.configured ? '（已配置）' : '（未连接）')).join('、'), src: 'gap' }
    ]).then(() => {
      toast('已打包 ' + items.length + ' 个平台的素材 · 全部未连接，导出不会同步到平台'); render(); return state.gen.pkg;
    });
  }

  /* ---------- 渲染：左（设置）/ 中（产物）/ 右（播放器与检查）/ 底（最近生成） ---------- */
  function chip(act, o, on, icon) {
    return `<button type="button" class="cf-chip ${on ? 'on' : ''}" data-act="${act}" data-v="${esc(o.key)}">`
      + (icon || '') + '<span>' + esc(o.t || o.name) + '</span></button>';
  }
  function chipRow(label, list, act, onVal, icons, fit) {
    return `<label class="cf-sec">${esc(label)}</label><div class="cf-chips${fit ? ' fit' : ''}">`
      + list.map((o, i) => chip(act, o, o.key === onVal, icons ? (icons[o.key] || '') : '')).join('') + '</div>';
  }
  /* 风格与语言按稿子来：风格是四张画面缩略图，语言是一个下拉框 */
  function tileRow(label, act) {
    return `<label class="cf-sec">${esc(label)}</label><div class="cf-tiles">`
      + state.spec.videoStyles.map(s => `<button type="button" class="cf-tile ${s.key === state.vStyle ? 'on' : ''}" data-act="${act}" data-v="${s.key}">
          <canvas data-style="${s.key}"></canvas><s>${esc(s.t)}</s></button>`).join('') + '</div>';
  }
  function langRow(label) {
    return `<label class="cf-sec">${esc(label)}</label><div class="cf-selwrap">
      <select class="cf-sel" data-act="lang">${state.spec.langs.map(l =>
        `<option value="${esc(l.key)}" ${l.key === state.lang ? 'selected' : ''}>${esc(l.t)}（${esc(l.key.toUpperCase())}）</option>`).join('')}</select></div>`;
  }

  function prodRow() {
    const p = prod();
    if (!p) return `<label class="cf-sec">选择商品</label>
      <div class="ai-err">本地商品库里没有商品：先去「AI 商品与客服」建档再生成内容。</div>`;
    /* 稿子里商品名下面那行卖点，我们直接用档案里的真参数，不另写一句广告话 */
    const sell = Object.keys(p.attrs || {}).slice(0, 3).map(k => p.attrs[k]).join(' · ');
    return `<label class="cf-sec">选择商品 · 共 ${state.prods.length} 个 SKU（${DB.hosted ? '发布时烘好的只读快照' : 'data/app.db'}）</label>
      <div class="cf-prod" id="cfProdCard">
        <img src="${esc(imgOf(p))}" alt="${esc(p.name + ' 主图 · ' + imgSrcNote(p))}">
        <div class="cf-prod-t"><b>${esc(p.name)}</b>
          <span title="${esc(sell)}">${esc(sell || (p.category || '未分类'))}</span>
          <span>US$${esc(p.price)} · ${esc(p.status_cn || p.status)} · 目标市场 ${esc(DS.name(p.target_country) || p.target_country || '【待填】')} · 库存 ${esc(p.stock)}</span></div>
        <button class="ai-btn" type="button" data-act="pick">${state.pickOpen ? '收起' : '更换商品'}</button>
      </div>
      ${state.pickOpen ? `<div class="cf-pick">${state.prods.map(x => `
        <button type="button" data-act="pickone" data-id="${esc(x.id)}" class="${x.id === state.prodId ? 'on' : ''}">
          <img src="${esc(imgOf(x))}" alt=""><span><s>${esc(x.name)}</s>
          <u>${esc(x.category || '未分类')} · ${esc(x.status_cn || x.status)}</u></span></button>`).join('')}</div>` : ''}`;
  }
  /* 引擎三选一摆在最上面：「本地规则」只是把档案字段拼成句子，用户要点的是另外两颗。
     探活失败的引擎照实摆出来并标不可用，比藏掉诚实。 */
  function engineRow() {
    const list = state.engines.length ? state.engines : [{ key: 'local', t: '本地规则引擎', on: true, model: '引擎探活没回来' }];
    return `<label class="cf-sec">文案引擎（换完要重新生成才生效）</label><div class="cf-eng">`
      + list.map(e => `<button type="button" class="cf-eng-b ${e.key === state.engine ? 'on' : ''}" data-act="engine" data-v="${esc(e.key)}"${e.on ? '' : ' disabled'}>
          <b>${e.on ? (e.key === 'local' ? '▤' : '◉') : '✕'}</b><span>${esc(e.t)}</span>
          <i>${esc(e.on ? e.model : '不可用 · ' + (e.note || ''))}</i></button>`).join('')
      + '</div>';
  }
  function settingsCard() {
    const t = state.tab;
    /* 一键跑全套时这一栏的单项生成本就在跑，按钮要跟着变灰，不能让人以为还能再按一次 */
    const running = state.busy || state.allRun.busy;
    let rows;
    if (t === 'copy') {
      rows = engineRow() + langRow('输出语言') + chipRow('投放平台', state.spec.channels, 'chan', state.chan, BRAND, 1)
        + `<div class="cf-note" style="margin-top:12px">目标市场取自商品档案：<b>${esc(DS.name((prod() || {}).target_country) || '【待填】')}</b>。
           平台上限（标题 ${esc(chan(state.chan).titleMax)} 字符 / 标签 ${esc(chan(state.chan).tagMax)} 个）来自 data/content.json。</div>`;
    } else if (t === 'image') {
      rows = tileRow('视觉风格', 'style') + langRow('文案语言')
        + `<label class="cf-sec">尺寸（导出即此比例）</label><div class="cf-chips fit">`
        + state.spec.imageSizes.map(s => chip('size', s, s.key === state.imgSize)).join('') + '</div>';
    } else if (t === 'video') {
      rows = chipRow('视频类型', state.spec.videoTypes, 'vtype', state.vType, VTYPE_IC, 1)
        + tileRow('视频风格', 'style')
        + chipRow('目标平台', state.spec.channels, 'chan', state.chan, BRAND, 1)
        + langRow('语言')
        + chipRow('视频时长', chan(state.chan).durations.map(d => ({ key: d, t: d + 's' })), 'dur', state.dur, null, 1);
    } else {
      rows = `<label class="cf-sec">发布平台（/api/db/platforms 实时）</label><div class="cf-chips">`
        + state.plats.map(pl => `<button type="button" data-act="plat" data-v="${esc(pl.key)}"
            class="cf-chip ${state.selPlat.indexOf(pl.key) >= 0 ? 'on' : 'off'}">${BRAND[pl.key] || ''}
            <span>${esc(pl.name)}</span>${pl.configured ? '' : '<i style="font-style:normal;font-size:13px;opacity:.75">· 未连接</i>'}</button>`).join('')
        + '</div>' + langRow('文案语言')
        + `<div class="cf-note warn" style="margin-top:12px">勾选只决定打包哪些平台的字段口径；
           未连接的平台不会收到任何东西。</div>`;
    }
    return `<section class="cf-card" id="cfSetCard">
      <div class="cf-h"><span>${esc(t === 'video' ? '视频生成设置' : t === 'image' ? '图片生成设置' : t === 'publish' ? '发布设置' : '文案生成设置')}</span>
        <em>${esc(cap(t).t || '')}</em></div>
      <div class="cf-form">${prodRow()}${rows}</div>
      <button class="cf-run" id="cfGen" type="button" data-act="run"${running ? ' disabled' : ''}>${running ? ICON.refresh + '<span>' + (t === 'copy' && state.engine !== 'local' ? '模型写作中 · 本机模型约 15~40 秒' : '生成中…') + '</span>' : ICON.play + '<span>' + esc(GEN_LABEL[t]) + '</span>'}</button>
      ${stale(t) ? `<div class="cf-note warn" style="margin-top:9px;flex:none">设置或商品已改动 · 产物还是上一次生成的，按上面这个按钮才会重跑。</div>` : ''}
      ${allBtn()}
    </section>`;
  }

  /* 缺口清单与依据收进同一个滚动区：它们排在文案外面会把复制/下载那一排按钮挤出画面，
     入口看不见等于没有入口。 */
  function copyCard() {
    const g = copyGen();
    /* 非文案栏挂着这一栏，但左栏那颗按钮是别的名字：喊「点左栏」等于指一个画面里没有的入口 */
    if (!g) {
      const here = state.tab === 'copy';
      return `<section class="cf-card grow"><div class="cf-h"><span>AI 生成的文案</span>
        <span class="cf-copy-h">${here ? `<em>${esc(GEN_LABEL.copy)}</em>`
          : `<button class="cf-link" type="button" data-act="tab" data-v="copy">${ICON.play}<span>${esc(GEN_LABEL.copy)}</span></button>`}</span></div>
        <div class="ai-loading">${here ? `点左栏「${esc(GEN_LABEL.copy)}」开始 · 当前引擎：${esc(engineOf(state.engine).t)}`
          : `这段文案是${esc(GEN_NAME[state.tab])}的底稿 · 左栏那颗按钮是「${esc(GEN_LABEL[state.tab])}」，不写文案 · 按上面这个切过去才生成`}</div></section>`;
    }
    const c = g.c || {}, L = state.lang;
    /* 引擎偶尔会给回一个没有标题的对象（字段对不上），这种情况必须显示出来而不是抛异常 */
    if (!c.title) return `<section class="cf-card grow" id="cfCopy"><div class="cf-h"><span>AI 生成的文案</span>
      <span class="cf-copy-h"><span class="cf-pill warn">字段缺失</span>
        <button class="cf-link" type="button" data-act="fixcopy">${ICON.refresh}<span>重新生成</span></button></span></div>
      <div class="cf-note warn">引擎这次没有返回标题字段。按上面「重新生成」重试；
      持续出现说明 AI 出口（Dify W02 或本地规则）的字段口径变了，不是页面问题。</div></section>`;
    const title = c.title[L] || c.title.en || '【待填】';
    const desc = c.description[L] || c.description.en || '【待填】';
    /* 模型写的卖点直接顶替本地拼装那五条：并排摆两份只会让人分不清哪份才是这次生成的 */
    const mb = (c.modelBullets || []).filter(Boolean);
    const bl = mb.length ? mb.map(t => ({ t: t, m: true }))
      : (c.bullets || []).map(b => b[L] || b.en).filter(Boolean).map(t => ({ t: t }));
    const mt = (c.modelTags || []).filter(Boolean);
    const tags = mt.length ? mt : (c.tags || []);
    const miss = (c.notices || []).concat(c.todo || []);
    const main = `<h4>${esc(title)}</h4>
        <p>${esc(desc).replace(/\n/g, '<br>')}</p>
        ${bl.map(x => `<div class="pt"><b>✓</b><span>${esc(x.t)}</span>${x.m ? '<i class="cf-m">模型写</i>' : ''}</div>`).join('')}
        <div class="cf-tags">${esc(tags.map(x => '#' + x).join(' '))}${mt.length ? '<i class="cf-m">模型给的标签</i>' : ''}</div>`;
    /* 哪一段真的没跟上语种，看显示出来的内容，不看页面自己怎么说 */
    const seoTxt = ((c.seo || {}).added || []).join(' ');
    const faqTxt = (((c.faq || [])[0] || {}).q || '');
    const off = [['SEO 关键词', seoTxt], ['FAQ', faqTxt]]
      .filter(x => x[1] && scriptOf(x[1]) !== wantScript(L))
      .map(x => x[0] + '是' + scriptName[scriptOf(x[1])] + '口径');
    const extra = `${off.length ? `<div class="cf-note warn" style="margin-top:9px">${esc(off.join('、'))}，
        模型这次没有给出${esc(langName(L))}版；上面标题 / 正文 / 卖点是${esc(langName(L))}版。</div>` : ''}
      ${miss.length ? `<div class="cf-miss">引擎自己标出的缺口：<br>${miss.map(m => '· ' + esc(m)).join('<br>')}</div>` : ''}
      ${evHtml(c.evidence, '这段文案用到了什么')}`;
    return `<section class="cf-card grow" id="cfCopy">
      <div class="cf-h"><span>AI 生成的文案</span>
        <span class="cf-copy-h"><span class="cf-pill ${g.live ? 'ok' : 'warn'}">${esc(g.model || (g.live ? '模型实时输出' : '本地规则拼装'))} · ${esc(langName(L))}</span>
        <button class="cf-link" type="button" data-act="fixcopy">${ICON.refresh}<span>重新生成</span></button></span></div>
      <div class="cf-copy">${main}${extra}</div>
      <div class="cf-acts">
        <button class="ai-btn" type="button" data-act="cpy">${ICON.cpy}<span>复制</span></button>
        <button class="ai-btn" type="button" data-act="dlcopy">${ICON.dl}<span>下载文案</span></button>
        <button class="ai-btn" type="button" data-act="translate">${ICON.trans}<span>翻译</span></button>
        <button class="ai-btn pri" type="button" data-act="apply">应用到商品库</button>
      </div>
    </section>`;
  }
  /* 封面候选：取分镜前 5 镜的首帧，点一张就把那一镜设为封面 */
  function coverCard() {
    const g = state.gen.video;
    if (!g) return `<section class="cf-card"><div class="cf-h"><span>视频封面</span><em>生成后按分镜首帧排出来</em></div>
      <div class="ai-loading">点左栏「${esc(GEN_LABEL.video)}」· 先出时间线与封面，渲染等接口</div></section>`;
    return `<section class="cf-card" id="cfCover">
      <div class="cf-h"><span>视频封面</span><em>取前 5 镜首帧 · 非实拍</em>
        <span class="cf-copy-h"><button class="cf-link" type="button" data-act="cover">${ICON.swap}<span>更换封面</span></button></span></div>
      <div class="cf-strip">${g.segs.slice(0, 5).map((s, i) => `
        <button type="button" data-act="shot" data-i="${i}" class="${i === state.shot ? 'on' : ''}">
          <canvas data-cover="${i}"></canvas><s>${esc(fmt(s.from))} ${esc(s.name)}</s></button>`).join('')}</div>
    </section>`;
  }
  function imageCard() {
    if (!state.gen.image) return `<section class="cf-card grow"><div class="cf-h"><span>AI 生成的图片</span></div>
      <div class="ai-loading">点左栏「${esc(GEN_LABEL.image)}」· 底图用商品库里的真主图，文字用真文案</div></section>`;
    const s = imgSize(), p = prod() || {}, ai = aiImg(p), j = imgJob(), st = vStyle(state.vStyle);
    /* 这一行只说实话：有没有 AI 底图、是谁生成的、多大、落在哪个文件；没接入就把原因摊开 */
    const lock = !state.ieng.on ? '文生图未接入 · ' + (state.ieng.note || '原因未返回') + ' · 现在这张海报的底图是商品库占位图'
      : ai ? '「' + st.t + '」底图已由 ' + (j.model || state.ieng.model) + ' 跑成 · ' + Math.round((ai.bytes || 0) / 1024) + ' KB · 本地文件 ' + ai.file
      : j && j.status === 'FAILED' ? '上一张图没跑成：' + (j.note || '百炼未给出原因') + ' · 可重试'
      : j && j.task_id ? '这一风格正在百炼排队：' + j.status + ' · ' + (j.note || '') + ' · 每 5 秒自动查一次'
      : '模型可用（' + state.ieng.model + '）· 按张计钱 · 实测约 10 秒一张 · 按「生成真底图」才提交';
    return `<section class="cf-card grow" id="cfImg">
      <div class="cf-h"><span>AI 生成的图片</span><em>${esc(s.t)} · ${s.w}×${s.h}</em></div>
      <div class="cf-view" style="aspect-ratio:${s.w}/${s.h};max-height:300px;max-width:${Math.round(300 * s.w / s.h)}px;margin:0 auto">
        <canvas id="cfPoster"></canvas></div>
      <div class="cf-lockrow"><span class="cf-lock">${esc(lock)}</span>
        <button class="cf-link" type="button" data-act="igen" style="margin-left:auto">
          ${state.ibusy ? ICON.refresh : ICON.spark}<span>${state.ibusy ? '提交中…' : '生成真底图 · ' + esc(st.t)}</span></button>
        <button class="cf-link" type="button" data-act="ipoll">${ICON.refresh}<span>查进度</span></button>
        <button class="cf-link" type="button" data-act="iprobe">${ICON.swap}<span>重新探测</span></button></div>
      <div class="cf-strip" style="margin-top:11px">${state.spec.imageSizes.map(x => `
        <button type="button" data-act="size" data-v="${x.key}" class="${x.key === state.imgSize ? 'on' : ''}">
          <canvas data-thumb="${x.key}"></canvas><s>${esc(x.t)}</s></button>`).join('')}</div>
      <div class="cf-acts">
        <button class="ai-btn pri" type="button" data-act="dlpng">下载 PNG</button>
        <button class="ai-btn" type="button" data-act="cpyimg">${ICON.cpy}<span>复制画面文字</span></button>
      </div>
    </section>`;
  }
  function pkgCard() {
    const g = state.gen.pkg;
    if (!g) return `<section class="cf-card grow"><div class="cf-h"><span>发布素材包</span></div>
      <div class="ai-loading">点左栏「${esc(GEN_LABEL.publish)}」· 按各平台字段口径打包，不向平台发请求</div></section>`;
    return `<section class="cf-card grow" id="cfPkg">
      <div class="cf-h"><span>发布素材包</span><em>${g.items.length} 个平台 · 商品 ${esc((prod() || {}).id)}</em></div>
      ${g.items.map(it => `<div class="ai-sub" style="margin:12px 0 6px">${esc(it.name)}
          <span class="cf-pill ${it.configured ? 'ok' : 'warn'}">${it.configured ? '凭据已配置' : '未连接'}</span>
          <span style="font-weight:400;font-size:14px;color:rgba(150,185,230,.6)">${esc((it.caps || []).join('、'))}</span></div>
        <table class="cf-rows"><thead><tr><th>平台字段</th><th>取值</th><th>来源</th></tr></thead><tbody>
        ${it.rows.map(r => `<tr><td>${esc(r.f)}</td><td class="${r.src === '未接入' ? 'no' : ''}">${esc(r.v)}</td><td>${esc(r.src)}</td></tr>`).join('')}
        </tbody></table>
        <div class="cf-acts"><button class="ai-btn" type="button" data-act="dlpkg" data-k="${esc(it.key)}">下载该包</button>
          <button class="ai-btn" type="button" data-act="cpypkg" data-k="${esc(it.key)}">复制字段清单</button></div>`).join('')}
    </section>`;
  }
  /* 最近生成：稿子里是横跨中右两栏的底部条，每条都能点开回看那一次的产物 */
  function histCard() {
    const list = state.histAll ? state.hist : state.hist.slice(0, 5);
    return `<section class="cf-card grow" id="cfHist">
      <div class="cf-h"><span>最近生成</span><em>ai_ops · kind=content · 点开回看，不重调模型</em>
        <span class="cf-copy-h"><button class="cf-link" type="button" data-act="histAll"><span>${state.histAll ? '只看最近 5 条' : '查看全部 ' + state.hist.length + ' 条'}</span></button></span></div>
      ${list.length ? `<div class="cf-hist">${list.map(o => {
        const out = jparse(o.output, {});
        const pr = state.prods.filter(x => x.id === o.entity_id)[0] || {};
        const meta = out.tab === 'video' ? [chan(out.chan || state.chan).name, (out.dur || state.dur) + 's'].join(' · ')
          : out.tab === 'publish' ? [(out.plats || []).length + ' 个平台', langName(out.lang || state.lang)].join(' · ')
          : out.tab === 'image' ? [imgSize(out.size).t, vStyle(out.style || state.vStyle).t].join(' · ')
          : [chan(out.chan || state.chan).name, langName(out.lang || state.lang)].join(' · ');
        return `<button type="button" data-act="hist" data-id="${o.id}">
          <img src="${esc(imgOf(pr))}" alt=""><span><b>${esc(pr.name || o.entity_id || '记录')}</b>
          <i>${esc(meta)} · ${esc(stamp(o.created_at))}</i></span>
          <em class="cf-pill ${GEN_KEY[out.tab] ? 'ok' : 'warn'}">${esc(HIST_PILL[out.tab] || '记录')}</em></button>`;
      }).join('')}</div>` : '<div class="ai-hint">还没有生成记录 · 每生成一次都会落一条 ai_ops</div>'}
    </section>`;
  }

  /* 正文下限：模型那一版按 700~1400 字符写（中文实测 550~670），本地拼装只有 140 字上下。
     下限写在行里，回归遍历直接读回来比对，不在两处各写一个常量。 */
  const DESC_MIN = 500;
  function checkCard() {
    const p = prod() || {}, ch = chan(state.chan), g = copyGen();
    const c = (g && g.c) || null;
    const T = (c && c.title) || {}, D = (c && c.description) || {};
    const title = c ? (T[state.lang] || T.en) : (p.name_en || p.name || '');
    const desc = c ? (D[state.lang] || D.en) : (p.description || '');
    /* 检查表要对着画面中栏真正显示的那一组标签数，否则会出现「数到 6、只摆 5 个」 */
    const tags = c ? ((c.modelTags || []).length ? c.modelTags : (c.tags || [])) : (p.tags || []);
    const faqQ = (((c || {}).faq || [])[0] || {}).q || '';
    const faqS = scriptOf(faqQ);
    const faqT = scriptName[faqS];
    const faqOk = !!c && faqS === wantScript(state.lang);
    const rows = [
      ['标题长度', title.length + ' / ' + ch.titleMax + ' 字符', title.length <= ch.titleMax],
      /* 只判"没超上限"会把 48 个字的正文判成合格——用户看到的正是这种"通过"却根本不能用的稿子 */
      ['正文长度', desc.length + ' / ' + ch.descMax + ' 字符 · 目标 ≥' + DESC_MIN
        + (desc.length < DESC_MIN ? ' · 偏短' : ''),
        desc.length >= DESC_MIN && desc.length <= ch.descMax],
      ['Hashtag 数', tags.length + ' / ' + ch.tagMax, tags.length <= ch.tagMax],
      /* FAQ 的语种要按画面显示的那条判断，不能假设"英文才算已翻译"：模型现在也会给中文版 FAQ */
      ['FAQ 口径', c ? (faqOk ? '与输出语言一致'
        : '当前这条是' + faqT + '口径，模型没有给出' + langName(state.lang) + '版') : '未生成文案', faqOk],
      ['主图素材', imgSrcNote(p) + ' · ' + imgOf(p), false],
      ['档案缺口', (p.issues || []).length ? p.issues.length + ' 条已登记' : '无登记', !(p.issues || []).length]
    ];
    return `<section class="cf-card grow" id="cfCheck">
      <div class="cf-h"><span>发布前检查</span><em>${esc(ch.name)} 口径</em></div>
      <table class="cf-rows"><thead><tr><th>检查项</th><th>结果</th><th>结论</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td class="${r[2] ? 'ok' : 'no'}">${r[2] ? '✓ 通过' : '⚠ 待处理'}</td></tr>`).join('')}
      </tbody></table>
      <div class="cf-note" style="margin-top:10px">${esc(ch.tip)} · 上限出处：${esc(state.spec.meta.source)}，${esc(state.spec.meta.note)}</div>
      ${c ? `<div class="cf-tips" style="margin-top:10px"><ul>${(c.notices || []).concat(c.todo || []).map(s => `<li class="no"><b>⚠</b><span>${esc(s)}</span></li>`).join('')}</ul></div>` : ''}
      <div class="cf-acts"><button class="ai-btn pri" type="button" data-act="fixcopy">按当前设置重新生成</button>
        <button class="ai-btn" type="button" data-act="jump4a">去改商品档案</button></div>
    </section>`;
  }
  function imageRight() {
    const p = prod() || {}, tx = posterText();
    return `<section class="cf-card grow" id="cfImgSrc">
      <div class="cf-h"><span>画面构成</span><em>canvas 合成 · 素材可回溯</em></div>
      <div class="cf-tips"><ul>
        <li><b>底图</b><span>${esc(imgOf(p))} · ${esc(imgSrcNote(p))}</span></li>
        <li><b>标题</b><span>${esc(tx.title)}</span></li>
        <li><b>要点</b><span>${esc(tx.bullets.join(' ｜ ') || '【待填】')}（来源：${esc(tx.from)}）</span></li>
        <li><b>标签</b><span>${esc(tx.tags.map(x => '#' + x).join(' ') || '无')}</span></li>
      </ul></div>
      <div class="cf-note warn">${aiImg(p) ? '底图已由文生图跑成真图，但它是模型画出来的，不是这件商品的实拍照片：版式与文字是真的，' : '底图是仓库里的占位 SVG，不是实拍照片：版式与文字是真的，'}
        素材要换实拍图才投放得出去。</div>
      <label class="cf-sec" style="margin-top:12px">各平台画面口径 · data/content.json · 本页导出 ${esc(imgSize().t)} ${imgSize().w}×${imgSize().h}</label>
      <table class="cf-rows"><thead><tr><th>平台</th><th>画面比例</th><th>标题上限</th><th>标签上限</th></tr></thead><tbody>
        ${state.spec.channels.map(ch => `<tr><td>${esc(ch.name)}</td>
          <td>${ch.ratio.join(':')}</td>
          <td>${esc(ch.titleMax)} 字符</td><td>${esc(ch.tagMax)} 个</td></tr>`).join('')}
      </tbody></table>
      <div class="cf-acts"><button class="ai-btn" type="button" data-act="genCopyFromImg">先生成文案再合成</button>
        <button class="ai-btn" type="button" data-act="jump4a">去传真实主图</button></div>
    </section>`;
  }
  /* 播放器：没渲染的镜用真 canvas 预演（底图与字幕都来自商品档案），跑成的镜换成 <video> 播本地 mp4。
     两种画面都必须当场说清是哪一种——模型生成的画面不是这件商品的实拍。 */
  function playerCard() {
    const g = state.gen.video, p = prod() || {}, on = !!state.veng.on, s = videoStat();
    const cur = g ? (g.segs[Math.min(state.shot, g.segs.length - 1)] || null) : null;
    const job = jobOf(cur), clip = clipOf(cur);
    const pill = !on ? '<span class="cf-pill warn">渲染未接入</span>'
      : s.run ? '<span class="cf-pill warn">正在渲染 ' + s.run + ' 镜</span>'
      : s.ok ? '<span class="cf-pill ok">已出片 ' + s.ok + '/' + s.all + ' 镜</span>'
      : '<span class="cf-pill warn">' + esc(state.veng.model) + ' 可用 · 还没跑</span>';
    const lock = !on ? '视频渲染未接入 · ' + (state.veng.note || '原因未返回') + ' · 这一屏是本地分镜预演，没有视频文件可下载'
      : clip ? '第 ' + (state.shot + 1) + ' 镜已由 ' + (job.model || state.veng.model) + ' 渲染 · '
          + Math.round((job.bytes || 0) / 1024) + ' KB · 本地文件 ' + job.file
      : job && job.status === 'FAILED' ? '第 ' + (state.shot + 1) + ' 镜上一轮渲染失败：' + (job.note || '百炼未给出原因') + ' · 可重试'
      : job && job.task_id ? '第 ' + (state.shot + 1) + ' 镜正在百炼排队：' + job.status + ' · ' + (job.note || '') + ' · 每 5 秒自动查一次'
      : '模型可用（' + state.veng.model + '）· 这一镜还没提交，按「渲染这一镜」就会排队';
    return `<section class="cf-card" id="cfPlayer">
      <div class="cf-h"><span>${clip ? '模型生成的视频 · 第 ' + (state.shot + 1) + ' 镜' : g ? '分镜预演 · 画面' : '生成的视频'}</span>
        <span class="cf-copy-h">${pill}
        <em>${esc(vType(state.vType).t)} · ${esc(chan(state.chan).name)} · ${esc(vStyle(state.vStyle).t)}${g ? ' · ' + g.segs.length + ' 镜' : ' · 未生成'}</em></span></div>
      <div class="cf-view" id="cfStageBox" style="aspect-ratio:1200/396">
        ${clip ? `<video id="cfVideo" src="${esc(clip.file)}" controls playsinline preload="metadata"></video>` : `
        <canvas id="cfStage"></canvas>
        <button class="cf-playbtn" type="button" data-act="play" ${g ? '' : 'disabled'}>${state.play.on ? ICON.pause : ICON.play}</button>
        <div class="cf-ctrl">
          <button class="cf-pp" type="button" data-act="play" ${g ? '' : 'disabled'}>${state.play.on ? ICON.pause : ICON.play}</button>
          <span class="cf-time" id="cfTime">${fmt(state.play.at)} / ${fmt(state.dur)}</span>
          <div class="cf-bar"><i id="cfProg" style="width:${g ? Math.min(100, state.play.at / state.dur * 100) : 0}%"></i></div>
          <button class="cf-ico" type="button" data-act="cc" title="字幕开关">${ICON.cc}</button>
          <button class="cf-ico" type="button" data-act="fs" title="播放器全屏">${ICON.fs}</button>
        </div>`}
      </div>
      <div class="cf-lockrow"><span class="cf-lock">${esc(lock)}</span>
        <button class="cf-link" type="button" data-act="vrender" data-i="${state.shot}" style="margin-left:auto">
          ${state.vbusy === state.shot ? ICON.refresh : ICON.spark}<span>${state.vbusy === state.shot ? '提交中…' : '渲染这一镜'}</span></button>
        <button class="cf-link" type="button" data-act="vpoll">${ICON.refresh}<span>查进度</span></button>
        <button class="cf-link" type="button" data-act="vprobe">${ICON.swap}<span>重新探测</span></button>
        <button class="cf-link" type="button" data-act="dlscript"${g ? '' : ' disabled'}>${ICON.dl}<span>下载分镜脚本</span></button></div>
      <div class="cf-locksrc">${clip ? '这一镜的画面由 ' + esc(job.model || state.veng.model) + ' 依 products.' + esc(p.id)
            + ' 的名称与品类生成 · 非本产品实拍 · 提示词禁止画面出现文字，所以字幕没烧进片子里（' + esc(job.file) + '）'
          : '画面合成：底图 ' + esc(g ? imgOf(p) : '（选商品后显示）') + '（' + esc(imgSrcNote(p)) + '）＋ 分镜字幕取自商品档案真字段'}</div>
      ${g ? `<div class="cf-board">${g.segs.map((x, i) => {
        const j = jobOf(x);
        /* 标记写在镜名前面：缩略图那一格只有约 7 个汉字宽，后缀会被省略号吃掉 */
        const mk = !j ? '' : j.file ? '✓ ' : j.status === 'FAILED' ? '✗ ' : j.status === 'RUNNING' ? '… ' : '○ ';
        return `<button class="cf-shot ${i === state.shot ? 'on' : ''}" type="button" data-act="shot" data-i="${i}">
          <canvas data-shot="${i}"></canvas><s>${esc(fmt(x.from))}–${esc(fmt(x.to))}</s><u>${esc(mk + x.name)}</u>
        </button>`; }).join('')}</div>` : '<div class="ai-loading">点左栏「' + esc(GEN_LABEL.video) + '」排出时间线，这里就会出现分镜</div>'}
    </section>`;
  }
  function tipsCard() {
    const g = state.gen.video;
    return `<section class="cf-card grow" id="cfTips">
      <div class="cf-h"><span>AI 优化建议</span><em>逐条来自商品档案缺口</em></div>
      <div class="cf-tips"><ul>${((prod() || {}).issues || []).map((s, i) => {
        const done = g && g.tips && g.tips[i];
        return `<li class="${done ? '' : 'no'}"><b>${done ? '✓' : '⚠'}</b><span>${esc(s)}${done ? ' → ' + esc(done.action) : ''}</span></li>`;
      }).join('') || '<li><b>✓</b><span>商品档案里没有登记的内容缺口</span></li>'}</ul></div>
      <div class="cf-acts" style="justify-content:flex-end"><button class="ai-btn pri" type="button" data-act="optvideo">${ICON.spark}<span>一键优化</span></button></div>
    </section>`;
  }
  function publishRight() {
    return `<section class="cf-card grow" id="cfPlatState">
      <div class="cf-h"><span>平台连接状态</span><em>/api/db/platforms · 实时读取</em></div>
      <table class="cf-rows"><thead><tr><th>平台</th><th>鉴权方式</th><th>能做什么</th><th>缺什么</th><th>状态</th></tr></thead><tbody>
        ${state.plats.map(pl => `<tr><td>${esc(pl.name)}</td><td class="why">${esc(pl.auth)}</td>
          <td>${esc((pl.capabilities || []).join('、'))}</td>
          <td class="why">${esc((pl.missing || []).map(m => m.env).join('、') || '—')}</td>
          <td class="${pl.configured ? 'ok' : 'no'}">${pl.configured ? '已配置' : '未连接'}</td></tr>`).join('')}
      </tbody></table>
      <div class="cf-note warn">${esc((state.plats[0] || {}).note || '尚未连接电商平台')}
        凭据只放在 tools/platforms.env 或环境变量，接口只回字段名、不回明文。</div>
      <div class="cf-acts"><button class="ai-btn" type="button" data-act="reloadPlat">重新读取平台状态</button>
        <button class="ai-btn" type="button" data-act="jump4a">去商品页看上架状态</button></div>
    </section>`;
  }

  /* 视频页的中栏按稿子放「文案 + 封面」，分镜行在右栏播放器下面 */
  const midOf = () => state.tab === 'copy' ? copyCard() : state.tab === 'image' ? imageCard()
    : state.tab === 'video' ? copyCard() + coverCard() : pkgCard();
  const rightOf = () => state.tab === 'copy' ? checkCard() : state.tab === 'image' ? imageRight()
    : state.tab === 'video' ? playerCard() + tipsCard() : publishRight();

  function render() {
    if (!state.spec) return;
    /* 横幅那排能力卡只做展示（当前 Tab 高亮），切换只认面板上方的 .cf-tab：
       两排同功能的切换器等于把同一件事摆两次，用户会先点上面那张再怀疑下面那排。 */
    $('cfCaps').innerHTML = state.spec.caps.map(c => `<div class="cf-cap ${c.id === state.tab ? 'on' : ''}">
      <s>${ICON[c.id] || ''}</s><span><u>${esc(c.t)}</u><em>${esc(c.d)}</em></span></div>`).join('');
    $('cfTabs').innerHTML = state.spec.caps.map(c => `<button type="button" data-act="tab" data-v="${c.id}" class="cf-tab ${c.id === state.tab ? 'on' : ''}">
      ${ICON[c.id] || ''}<span>${esc(c.t)}</span></button>`).join('');
    $('cfSteps').innerHTML = STEPS.map((s, i) => {
      const has = !!genOf(state.tab);
      const done = (s.id === 'pick' && state.prodId) || ((s.id === 'gen' || s.id === 'out') && has);
      const on = (s.id === 'style') || (s.id === 'gen' && !has);
      const t = s.id === 'gen' ? STEP3[state.tab] : s.t;
      return `<button class="cf-step ${on ? 'on' : ''} ${done ? 'done' : ''}" type="button" data-act="step" data-v="${s.id}">
        <b>${done && !on ? '✓' : i + 1}</b><span>${esc(t)}</span></button>`
        + (i < STEPS.length - 1 ? `<div class="cf-line ${done ? 'done' : ''}"></div>` : '');
    }).join('') + `<em>${allRunNote()}</em>`;
    $('cfSide').innerHTML = settingsCard();
    $('cfMid').innerHTML = (state.toast ? `<div class="ai-note ok" id="cfToast">${esc(state.toast)}</div>` : '') + midOf();
    $('cfRight').innerHTML = rightOf();
    $('cfHistRow').innerHTML = histCard();
    drawCanvases();
    updateHero();
  }
  function updateHero() {
    const live = state.plats.filter(p => p.configured).length;
    const eng = engineOf(state.engine);
    const s = videoStat();
    const vid = state.veng.on ? esc(state.veng.model) + ' · 出片 <b>' + s.ok + '/' + s.all + '</b>' + (s.run ? ' · 在跑 ' + s.run : '')
      : '未接入';
    $('cfState').innerHTML = `商品库 <b>${state.prods.length}</b> 个 SKU · 文案引擎 <b>${esc(eng.t)}${eng.key === 'local' ? '' : ' · ' + esc(eng.model)}</b><br>
      电商平台 <i>${live ? live + ' 个已配置' : '未连接'}</i> · 视频渲染 <i>${vid}</i>`;
    $('cfProvider').textContent = '内容 ' + (isLive(copyGen()) ? '模型实时' : '本地引擎') + ' · 商品 ' + (DB.hosted ? '只读快照' : 'data/app.db');
  }

  /* canvas 每次渲染后重画，否则换商品后缩略图还是上一个的 */
  function drawCanvases() {
    const p = prod(); if (!p) return;
    drawPoster($('cfPoster'), state.imgSize);
    Array.prototype.forEach.call(document.querySelectorAll('[data-thumb]'), cv => drawPoster(cv, cv.dataset.thumb));
    Array.prototype.forEach.call(document.querySelectorAll('[data-style]'), cv => drawStyleThumb(cv, cv.dataset.style));
    const g = state.gen.video;
    if (!g) return;
    drawStage($('cfStage'), g.segs[state.shot]);
    Array.prototype.forEach.call(document.querySelectorAll('[data-shot]'), cv => drawStage(cv, g.segs[+cv.dataset.shot], true));
    Array.prototype.forEach.call(document.querySelectorAll('[data-cover]'), cv => drawStage(cv, g.segs[+cv.dataset.cover], true));
  }
  /* 风格缩略图：同一张商品占位图，套上该风格的配色，点一张画面真的按这套色重画。
     画布比例要贴着 CSS 的 100x54 框，否则 object-fit:cover 会把两侧的文字裁掉。 */
  function drawStyleThumb(cv, key) {
    const p = prod(); if (!cv || !p) return;
    const st = vStyle(key), W = cv.width = 224, H = cv.height = 124, r = W / 260;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, st.bg[0]); g.addColorStop(1, st.bg[1]);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const im = imgFor(imgOf(p));
    const body = () => {
      if (im.complete && im.naturalWidth) { c.globalAlpha = .9; c.drawImage(im, W - 116, 12, 100, 100); c.globalAlpha = 1; }
      c.strokeStyle = st.accent; c.lineWidth = 2 * r; c.globalAlpha = .5;
      c.beginPath(); c.moveTo(14, H - 26); c.lineTo(120, H - 26); c.stroke(); c.globalAlpha = 1;
      c.fillStyle = st.fg; c.font = '600 22px system-ui, sans-serif'; c.textBaseline = 'top';
      c.fillText(st.t, 14, 18);
    };
    if (im.complete) body(); else { im.onload = body; im.onerror = body; }
  }
  /* 画布上截断的行要带省略号：一行停在「commutin」看起来像渲染坏了，不像还有下文 */
  function clipWrap(c, text, maxW, n) {
    const lines = wrap(c, text, maxW);
    if (lines.length <= n) return lines;
    return lines.slice(0, n - 1).concat([lines[n - 1].replace(/.{1,2}$/, '…')]);
  }
  function drawStage(cv, seg, small) {
    const p = prod();
    if (!cv || !seg || !p) return;
    const st = vStyle(state.vStyle), W = cv.width = small ? 260 : 1200, H = cv.height = small ? 124 : 396, r = W / 1200;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, st.bg[0]); g.addColorStop(1, st.bg[1]);
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    /* 右侧留给主图，左侧是文字栏；播放按钮压在中央 520~680 这条带上，文字不能进去 */
    const box = small ? W * .62 : 240, bx = small ? (W - box) / 2 : W - 56 - box, by = small ? (H - box) / 2 : 40;
    const im = imgFor(imgOf(p));
    const tx = posterText();
    const body = () => {
      if (im.complete && im.naturalWidth) { c.globalAlpha = .92; c.drawImage(im, bx, by, box, box); c.globalAlpha = 1; }
      c.textBaseline = 'top';
      if (small) {
        c.fillStyle = st.accent; c.font = '600 ' + Math.round(28 * r) + 'px system-ui, sans-serif';
        c.fillText(fmt(seg.from) + '–' + fmt(seg.to), 26, 12);
        c.fillStyle = '#eaf4ff'; c.font = '400 ' + Math.round(26 * r) + 'px system-ui, sans-serif';
        c.fillText(seg.name, 26, H - 42);
        return;
      }
      /* 播放器画面：顶栏说「第几镜 / 什么镜头」，左栏是商品名与文案标题，底部是这一镜字幕。
         最下面 60px 是 HTML 播控条盖着的位置，字幕一律排在它上面。 */
      c.fillStyle = 'rgba(6,14,30,.4)'; c.fillRect(0, H - 104, W, 104);
      c.fillStyle = st.accent; c.font = '600 ' + Math.round(30 * r) + 'px system-ui, sans-serif';
      c.fillText(fmt(seg.from) + '–' + fmt(seg.to) + '  ' + seg.name + ' · ' + seg.shot, 56 * r, 24 * r);
      c.textAlign = 'right';
      c.fillStyle = 'rgba(160,195,240,.62)'; c.font = '400 ' + Math.round(22 * r) + 'px system-ui, sans-serif';
      c.fillText(state.veng.on ? '分镜预演 · 非实拍 · 这一镜还没提交渲染' : '分镜预演 · 非实拍 · 视频渲染未接入', W - 56 * r, 28 * r);
      c.textAlign = 'left';
      c.fillStyle = '#ffffff'; c.font = '700 ' + Math.round(46 * r) + 'px system-ui, sans-serif';
      clipWrap(c, p.name || p.id, 470 * r, 2).forEach((ln, i) => c.fillText(ln, 56 * r, 84 * r + i * 56 * r));
      c.fillStyle = st.fg; c.font = '400 ' + Math.round(28 * r) + 'px system-ui, sans-serif';
      clipWrap(c, tx.title, 470 * r, 2).forEach((ln, i) => c.fillText(ln, 56 * r, 208 * r + i * 34 * r));
      if (state.cc) {
        c.fillStyle = '#eaf4ff'; c.font = '400 ' + Math.round(30 * r) + 'px system-ui, sans-serif';
        clipWrap(c, seg.cap, W - 112 * r, 1).forEach(ln => c.fillText(ln, 56 * r, H - 88 * r));
      }
    };
    if (im.complete) body(); else { im.onload = body; im.onerror = body; }
  }

  const shotOn = i => Array.prototype.forEach.call(document.querySelectorAll('.cf-shot, .cf-strip [data-act="shot"]'),
    el => el.classList.toggle('on', +el.dataset.i === i));
  /* ---------- 分镜播放：只动 canvas 与进度条，不重排整页 ---------- */
  let timer = 0;
  function step() {
    const g = state.gen.video;
    if (!g) return stop();
    state.play.at = +(state.play.at + .1).toFixed(1);
    const per = state.dur / g.segs.length;
    const idx = Math.min(g.segs.length - 1, Math.floor(state.play.at / per));
    if (idx !== state.shot) {
      state.shot = idx; shotOn(idx);
      /* 预演走到已经出片的那一镜就交回真播放器：继续用 canvas 画一镜"有片子的画面"是假画面 */
      if (clipOf(g.segs[idx])) { stop(); render(); toast('播到第 ' + (idx + 1) + ' 镜 · 这一镜已经是模型生成的 .mp4，用画面里的进度条看'); return; }
    }
    drawStage($('cfStage'), g.segs[idx]);
    const bar = $('cfProg'); if (bar) bar.style.width = Math.min(100, state.play.at / state.dur * 100) + '%';
    const tm = $('cfTime'); if (tm) tm.textContent = fmt(Math.min(state.play.at, state.dur)) + ' / ' + fmt(state.dur);
    if (state.play.at >= state.dur) {
      const s = videoStat();
      stop();
      toast('分镜预演播完一轮 · ' + g.segs.length + ' 镜 / ' + state.dur + 's（其中 ' + s.ok + ' 镜已有 .mp4 文件）');
    }
  }
  function setPP() {
    Array.prototype.forEach.call(document.querySelectorAll('#cfPlayer [data-act="play"]'),
      b => { b.innerHTML = state.play.on ? ICON.pause : ICON.play; });
  }
  function play() {
    if (!state.gen.video) return;
    if (state.play.at >= state.dur) state.play.at = 0;
    state.play.on = true; clearInterval(timer); timer = setInterval(step, 100);
    setPP();
  }
  function stop() {
    state.play.on = false; clearInterval(timer); timer = 0;
    setPP();
  }

  /* ---------- 导出内容 ---------- */
  function copyBundle() {
    const g = copyGen(); if (!g) return '';
    const c = g.c, L = state.lang, p = prod() || {};
    return [`# ${p.name} · ${langName(L)} 文案（${chan(state.chan).name}）`, '',
      '标题：' + (c.title[L] || c.title.en), '', c.description[L] || c.description.en, '',
      /* 模型写的卖点/标签顶替拼装版：下载的 .md 必须和中栏显示的是同一份 */
      ...((c.modelBullets || []).length ? c.modelBullets : (c.bullets || []).map(b => b[L] || b.en)).map(t => '- ' + t), '',
      '标签：' + ((c.modelTags || []).length ? c.modelTags : (c.tags || [])).map(x => '#' + x).join(' '), '',
      'SEO 关键词：' + (c.seo.added || []).join(', '), '', 'FAQ：',
      ...(c.faq || []).map(f => 'Q: ' + f.q + '\nA: ' + f.a), '', '—',
      '来源：' + (g.model || (g.live ? '模型实时输出' : '本地规则拼装')) + ' · 平台上限出处 data/content.json'
    ].join('\n');
  }
  function scriptMd() {
    const g = state.gen.video, p = prod() || {}, s = videoStat();
    return [`# ${p.name} · ${vType(state.vType).t}分镜脚本`, '',
      `类型 ${vType(state.vType).t} ｜ 风格 ${vStyle(state.vStyle).t} ｜ 平台 ${chan(state.chan).name} ｜ 时长 ${state.dur}s`,
      '渲染：' + (state.veng.on ? state.veng.model + ' 已出片 ' + s.ok + '/' + s.all + ' 镜（本地文件见每行最后一列）'
        : '未接入 · ' + (state.veng.note || '原因未返回')) + '。字幕一律后期叠加：提示词里禁止画面出现文字。', '',
      '| 镜号 | 时间 | 段落 | 镜头 | 字幕 | 渲染 |', '| --- | --- | --- | --- | --- | --- |',
      ...g.segs.map((x, i) => {
        const j = jobOf(x);
        const r = !j ? '未提交' : j.file ? '✓ ' + j.file : j.status === 'FAILED' ? '✗ ' + (j.note || '失败') : j.status;
        return `| ${i + 1} | ${fmt(x.from)}–${fmt(x.to)} | ${x.name} | ${x.shot} | ${x.cap} | ${r} |`;
      })
    ].join('\n');
  }

  /* ---------- 交互：一个委托吃下全页按钮 ---------- */
  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'SELECT') return;
    const d = el.dataset, a = d.act, t = state.tab;
    const set = (k, v) => { state[k] = v; render(); };
    if (a === 'tab') {
      /* 点已经站着的 Tab 也要有回应：说清产物在哪、什么时候才需要重跑 */
      if (d.v === state.tab) { toast('已经在「' + capName(d.v) + '」· 产物就在中间这一栏，改完左栏设置再按下面的「' + GEN_LABEL[d.v] + '」才会重跑'); render(); return; }
      return goTab(d.v);
    }
    if (a === 'pick') { state.pickOpen = !state.pickOpen; render(); return; }
    if (a === 'pickone') {
      /* 换商品只换上下文，不替用户按下生成：调模型是花钱且慢的动作，得他自己点 */
      state.prodId = d.id; state.pickOpen = false;
      state.gen = { copy: null, image: null, video: null, pkg: null };
      stop(); stopPoll(); stopImgPoll(); state.vjobs = {}; state.ijobs = {};
      return Promise.all([loadHist(), loadVideoJobs(), loadImageJobs()]).then(() => {
        render();
        toast('已切到「' + ((prod() || {}).name || d.id) + '」· 设置确认后按「' + GEN_LABEL[state.tab] + '」才会'
          + (state.engine === 'local' ? '按本地规则出稿' : '调用 ' + engineOf(state.engine).t + ' 生成'));
      });
    }
    if (a === 'chan') {
      /* 点已经选中的平台同样要给一句实话，别让人以为按钮坏了 */
      if (d.v === state.chan) { toast('投放平台已经是「' + chan(d.v).t + '」· 换平台才会按它的字数与话题规则重排'); render(); return; }
      if (chan(d.v).durations.indexOf(state.dur) < 0) state.dur = chan(d.v).durations[0];
      return set('chan', d.v);
    }
    if (a === 'engine') {
      const e = state.engines.filter(x => x.key === d.v)[0] || { key: 'local', t: '本地规则引擎', on: true };
      if (d.v === state.engine) { toast('引擎已经是「' + e.t + '」· 换完要按下面的生成才会重跑'); render(); return; }
      useEngine(d.v);
      state.gen.copy = null;
      toast(d.v === 'local' ? '已切回本地规则拼装 · 不会调用任何模型'
        : '已切到 ' + e.t + '（' + e.model + '）· 按「' + GEN_LABEL.copy + '」就会真调模型，产物里的每个数字仍要能在商品档案里找到');
      render(); return;
    }
    if (a === 'style') {
      if (d.v === state.vStyle) { toast('画面风格已经是「' + vStyle(state.vStyle).t + '」· 换一套只会按新配色重画'); render(); return; }
      return set('vStyle', d.v);
    }
    if (a === 'vtype') {
      /* 与 style / size 同一口径：点的就是当前项时给一句实话，别让人以为按钮坏了 */
      if (d.v === state.vType) { toast('视频类型已经是「' + vType(d.v).t + '」· 换一类才会按新的叙事重排分镜'); render(); return; }
      return set('vType', d.v);
    }
    if (a === 'dur') {
      if (+d.v === state.dur) { toast('时长已经是 ' + state.dur + 's · 换一档才会按新的秒数重排分镜'); render(); return; }
      return set('dur', +d.v);
    }
    if (a === 'size') {
      /* 同上：点已经选中的尺寸要给一句实话，别让人以为按钮坏了 */
      if (d.v === state.imgSize) { toast('海报已经是「' + imgSize().t + ' · ' + imgSize().w + '×' + imgSize().h + '」· 换尺寸只会重画这一张'); render(); return; }
      return set('imgSize', d.v);
    }
    if (a === 'plat') {
      const i = state.selPlat.indexOf(d.v);
      if (i >= 0) state.selPlat.splice(i, 1); else state.selPlat.push(d.v);
      render(); return;
    }
    if (a === 'runall') return runAll();
    /* 一键跑全套期间改设置、换商品、再按单项生成，都会让刚跑出来的产物变成半套：
       先让它跑完或按「停下」。切 Tab 看产物不拦——那正是这一轮要给你看的东西。 */
    if (state.allRun.busy && ['run', 'pick', 'pickone', 'engine', 'plat', 'lang', 'chan', 'style', 'size', 'vtype', 'dur'].indexOf(a) >= 0) {
      toast('一键生成进行中 · ' + (state.allRun.line || '') + ' · 要改设置先按「停下」'); render(); return;
    }
    if (a === 'run') return runTab(t);
    if (a === 'step') {
      if (d.v === 'gen') return runTab(t);
      if (d.v === 'pick') { state.pickOpen = true; toast('已在左栏展开商品清单 · 共 ' + state.prods.length + ' 个 SKU'); render(); return; }
      /* 先画回执再高亮：render 会重建节点，flash 必须排在它后面 */
      if (d.v === 'style') { toast('第 2 步就是左栏这组设置：改完要重新生成才会生效'); render(); flash('cfSetCard'); return; }
      if (!genOf(t)) { toast('还没有产物可下载 · 先走第 3 步生成'); render(); return; }
      toast('第 4 步：产物就在中栏与右栏，按钮可复制 / 下载' + (DB.hosted ? '（这一版是只读快照，写库会被当场拒绝）' : ' / 写库')); render();
      flash(t === 'video' ? 'cfPlayer' : t === 'image' ? 'cfImg' : t === 'publish' ? 'cfPkg' : 'cfCopy');
      return;
    }
    if (a === 'cpy') { if (!copyGen()) return noCopy(); return copyText(copyBundle(), el); }
    if (a === 'dlcopy') {
      if (!copyGen()) return noCopy();
      dl(((prod() || {}).id || 'x') + '-' + state.lang + '-' + state.chan + '-copy.md', copyBundle(), 'text/markdown;charset=utf-8');
      toast('已下载文案 .md · 内容与页面显示的一致'); return;
    }
    if (a === 'translate') {
      const L = state.spec.langs, i = L.map(x => x.key).indexOf(state.lang);
      state.lang = L[(i + 1) % L.length].key;
      render();
      return makeCopy('已切到 ' + langName(state.lang) + ' 并重跑文案 · 引擎按当前商品档案出稿');
    }
    if (a === 'cpyimg') { const tx = posterText(); return copyText(tx.title + '\n' + tx.bullets.join('\n'), el); }
    if (a === 'dlpng') {
      const cv = $('cfPoster');
      if (!cv) return noImg();
      cv.toBlob(blob => {
        if (!blob) { toast('浏览器拒绝导出：画面被跨域素材污染（请通过 tools/proxy.mjs 打开页面）'); return; }
        dl(((prod() || {}).id || 'x') + '-' + imgSize().key + '-' + vStyle(state.vStyle).key + '.png', blob);
        toast('已下载 ' + imgSize().t + ' PNG · ' + imgSize().w + '×' + imgSize().h);
      }, 'image/png');
      return;
    }
    if (a === 'apply') {
      const g = copyGen(), p = prod() || {};
      if (!g) return noCopy();
      DB.applyCopy(p.id, {
        name_en: g.c.title.en, description_en: g.c.description.en,
        keywords: (g.c.seo.added || []).concat(g.c.seo.existing || []), tags: g.c.tags, faq: g.c.faq,
        iso: p.target_country, lang: 'en', evidence: g.c.evidence, model: g.model || (g.live ? '模型' : '本地规则'), live: !!g.live
      }).then(r => {
        toast('已写入商品库：' + ((r.diff || []).map(x => x.f).join('、') || '无字段变化') + ' · 未同步到任何平台');
        return Promise.all([loadProds(), loadHist()]).then(render);
      }, err => { toast('应用失败：' + (err && err.message || err)); render(); });
      return;
    }
    if (a === 'fixcopy') return makeCopy('已按当前设置（' + langName(state.lang) + ' · ' + chan(state.chan).name + '）重新生成');
    if (a === 'genCopyFromImg') {
      if (copyGen()) return makeImage('已有文案，直接按当前设置重画图片');
      /* busy 交给 makeCopy 自己管：这里先置 true 会让它当成"上一稿还在跑"直接返回，
         而这条链没人复位，「开始生成文案」就永远灰着点不动了 */
      return makeCopy('先生成文案，再合成图片').then(c => { if (c && prod()) makeImage('文案就绪后已合成图片 · ' + imgSrcNote(prod())); });
    }
    if (a === 'shot') {
      stop(); state.shot = +d.i;
      const g = state.gen.video;
      state.play.at = g ? g.segs[+d.i].from : 0;
      /* 切到的那一镜已经有 .mp4 就得换掉整个画面区：canvas 重画不出真片子，只显得按钮没反应 */
      if (clipOf(g && g.segs[+d.i])) return render();
      drawCanvases();
      shotOn(state.shot);
      const bar = $('cfProg'); if (bar) bar.style.width = (state.play.at / state.dur * 100) + '%';
      const tm = $('cfTime'); if (tm) tm.textContent = fmt(state.play.at) + ' / ' + fmt(state.dur);
      return;
    }
    if (a === 'cover') {
      const g = state.gen.video; if (!g) return noVideo();
      state.shot = (state.shot + 1) % g.segs.length; state.play.at = g.segs[state.shot].from; stop();
      toast('封面已换成第 ' + (state.shot + 1) + ' 镜 · ' + fmt(g.segs[state.shot].from) + ' ' + g.segs[state.shot].name + '（播放器画面同步跟着走）');
      render(); return;
    }
    if (a === 'histAll') { state.histAll = !state.histAll; render(); return; }
    if (a === 'cc') { state.cc = !state.cc; toast(state.cc ? '字幕已开 · 这一镜的字幕画在画面下沿' : '字幕已关 · 只留画面与时间码'); drawCanvases(); return; }
    if (a === 'fs') {
      const box = $('cfStageBox'); if (!box) return;
      const go = box.requestFullscreen || box.webkitRequestFullscreen;
      if (!go) { toast('这个浏览器不支持元素全屏 · 分镜画面仍在原处'); return; }
      /* requestFullscreen 返回的是 Promise：缺用户手势时它以 rejection 失败，
         try/catch 接不住，控制台就留下一条未捕获的 TypeError。被拦下得当面说清原因。 */
      Promise.resolve(go.call(box)).catch(err => toast('全屏被浏览器拦下：' + ((err && err.message) || err) + ' · 需要在画面上真点一次'));
      return;
    }
    if (a === 'play') { state.play.on ? stop() : play(); return; }
    if (a === 'dlscript') {
      if (!state.gen.video) return noVideo();
      dl(((prod() || {}).id || 'x') + '-' + state.vType + '-' + state.dur + 's-script.md', scriptMd(), 'text/markdown;charset=utf-8');
      toast('已下载分镜脚本 .md · ' + state.gen.video.segs.length + ' 镜时间线与字幕'); return;
    }
    if (a === 'vrender') return renderShot(+d.i);
    if (a === 'vpoll') {
      if (!state.gen.video) return noVideo();
      return pollJobs().catch(err => { toast('进度查询失败：' + (err && err.message || err)); });
    }
    if (a === 'vprobe') {
      state.vbusy = false;
      return loadVideoEngine(true).then(() => {
        render();
        toast(state.veng.on ? '探测成功：' + state.veng.model + ' 可用（' + state.veng.note + '）· 现在可以逐镜提交渲染'
          : '还是没接上：' + state.veng.note + ' · 改完 tools/video.env 要重启网关');
      });
    }
    if (a === 'igen') return genImage();
    if (a === 'ipoll') return pollImages();
    if (a === 'iprobe') {
      state.ibusy = false;
      return loadImageEngine(true).then(() => {
        render();
        toast(state.ieng.on ? '探测成功：' + state.ieng.model + ' 可用（' + state.ieng.note + '）· 按「生成真底图」才会提交任务'
          : '还是没接上：' + state.ieng.note + ' · 改完 tools/video.env 要重启网关');
      });
    }
    if (a === 'optvideo') return applyVideoTips();
    if (a === 'dlpkg' || a === 'cpypkg') {
      const it = ((state.gen.pkg || {}).items || []).filter(x => x.key === d.k)[0];
      if (!it) return;
      if (a === 'dlpkg') {
        dl(((prod() || {}).id || 'x') + '-' + it.key + '-package.json',
          JSON.stringify({ product: (prod() || {}).id, platform: it.key, fields: it.rows, exported_at: new Date().toISOString(), connected: false }, null, 2),
          'application/json');
        toast('已导出 ' + it.name + ' 素材包 · connected:false，未向平台发出请求');
      } else copyText(it.name + '\n' + it.rows.map(r => r.f + ' = ' + r.v).join('\n'), el);
      return;
    }
    if (a === 'reloadPlat') {
      return loadPlats().then(() => {
        toast('已重新读取 /api/db/platforms · ' + state.plats.filter(p => p.configured).length + ' / ' + state.plats.length + ' 个已配置');
        render();
      }, err => { toast('平台状态读取失败：' + (err && err.message || err)); render(); });
    }
    if (a === 'jump4a') { SHELL.goto('4a', { tab: 'goods' }); toast('已请求切到「AI 商品与客服」· 在那里改商品档案与上架状态'); return; }
    if (a === 'hist') return openHist(+d.id);
  }
  /* 语言是下拉框（稿子里就是这个控件）：change 才生效，选中当前语言时给一句实话 */
  function onChange(e) {
    const el = e.target.closest('select[data-act="lang"]');
    if (!el) return;
    const v = el.value;
    /* 一键跑全套中途换语言会出混稿：上一栏是英文、下一栏是中文。回退下拉，别让它悄悄生效 */
    if (state.allRun.busy) { el.value = state.lang; toast('一键生成进行中 · 语言等这一轮跑完再改'); render(); return; }
    if (v === state.lang) { toast('输出语言已经是「' + langName(v) + '」· 换语言才会重跑文案'); render(); return; }
    state.lang = v; render();
  }
  const noCopy = () => { toast('还没有生成文案 · 点左栏「' + GEN_LABEL.copy + '」'); render(); };
  const noImg = () => { toast('还没有生成图片 · 点左栏「' + GEN_LABEL.image + '」'); render(); };
  const noVideo = () => { toast('还没有生成分镜 · 点左栏「' + GEN_LABEL.video + '」'); render(); };

  function flash(id) {
    const el = $(id);
    if (!el) return;
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  /* 回看历史产物：读 ai_ops 里存下的那份，不重新调用模型 */
  function openHist(id) {
    const o = state.hist.filter(x => +x.id === id)[0];
    /* 列表会在每次生成后重取，点到的可能是刚被换掉的旧行——说一句实话，别默默什么都不发生 */
    if (!o) { toast('这条记录已经不在「最近生成」列表里 · 正在重新拉取'); loadHist().then(render); return; }
    const out = jparse(o.output, {});
    const tab = hasTab(out.tab) ? out.tab : state.tab;
    if (o.entity_id) state.prodId = o.entity_id;
    if (tab === 'copy' && out.copy) {
      state.lang = out.lang || state.lang; state.chan = out.chan || state.chan;
      state.gen.copy = { sig: sig('copy'), at: Date.now(), c: out.copy, live: !!out.live, prodId: o.entity_id };
      toast('已载入 ' + stamp(o.created_at) + ' 那次生成的文案（ai_ops #' + o.id + '）· 未重新调用模型');
    } else if (tab === 'video' && (out.segs || []).length) {
      state.vType = out.vType || state.vType; state.vStyle = out.vStyle || state.vStyle;
      state.chan = out.chan || state.chan; state.dur = out.dur || state.dur;
      state.gen.video = { sig: sig('video'), at: Date.now(), segs: out.segs, tips: null, prodId: o.entity_id };
      state.shot = 0; state.play = { on: false, at: 0 }; stop();
      toast('已载入 ' + stamp(o.created_at) + ' 那版分镜（ai_ops #' + o.id + '）· ' + out.segs.length + ' 镜（未重新生成）');
    } else if (tab === 'image') {
      state.imgSize = out.size || state.imgSize; state.vStyle = out.style || state.vStyle;
      toast('已载入 ' + stamp(o.created_at) + ' 的图片设置（ai_ops #' + o.id + '）· ' + imgSize().t + ' · 画面按当前文案重画');
      state.gen.image = { sig: sig('image'), at: Date.now(), prodId: state.prodId };
    } else if (tab === 'publish') {
      state.selPlat = out.plats || state.selPlat;
      toast('已载入 ' + stamp(o.created_at) + ' 的发布设置（ai_ops #' + o.id + '）· 选了 ' + state.selPlat.length + ' 个平台 · 素材包按当前商品重出');
      state.gen.pkg = { sig: sig('publish'), at: Date.now(), prodId: state.prodId, items: state.plats.filter(pl => state.selPlat.indexOf(pl.key) >= 0).map(pkgFor) };
    }
    goTab(tab, true);
  }

  function runTab(t, note) {
    if (state.busy) return;
    state.toast = null;
    if (!prod()) { toast('商品库为空 · 先去「AI 商品与客服」建档'); render(); return; }
    if (t === 'copy') makeCopy(note);
    else if (t === 'image') makeImage(note);
    else if (t === 'video') makeVideo(note);
    else makePkg();
  }
  /* ---------- 一键跑全套：文案 → 主图 → 分镜 → 素材包 ----------
     这四步本来就是四个 Tab 各自的「开始生成」，串起来跑一遍而已，没有新能力，也没有新花费：
     视频只到「分镜排出来」为止，绝不自动提交万相渲染（那是按次算钱的）；
     素材包只按平台字段口径导出，一个请求都不发给平台。按钮上必须把这两件事写明白。 */
  const allSteps = () => ALL_STEPS.filter(s => hasTab(s.k));
  /* 步骤条右边那一行：平时是一句固定说明，跑全套时换成逐项进度。
     只报真的跑没跑成，不说「已完成发布」这类接口根本没做的事。 */
  function allRunNote() {
    const r = state.allRun;
    if (!r.steps.length) return esc(cap(state.tab).t || '') + ' · 四个模块共用同一个商品';
    const marks = r.steps.map(s => s.t + ' ' + ALL_ST[s.st] + (s.why ? '(' + s.why + ')' : '')).join('  ');
    return esc(r.busy ? r.line + '   ' + marks : marks + ' · 一键跑全套');
  }
  function genStep(k) {
    if (k === 'copy') return makeCopy();
    if (k === 'image') return makeImage();
    if (k === 'video') return makeVideo();
    return makePkg();
  }
  /* 花费随引擎变：本地拼装是免费的，叫模型写就要按 token 计钱——这笔账要点开之前就说清 */
  function allCost() {
    if (state.engine === 'local') return '文案走本地规则拼装 · 不花钱';
    return '文案要叫 ' + engineOf(state.engine).t + ' 写 1 次 · 按 token 计钱，约 '
      + (state.engine === 'ollama' ? '1 分钟' : '10~30 秒');
  }
  function allBtn() {
    const r = state.allRun, n = allSteps().length;
    const tail = '主图用现成底图、不自动提交文生图 · 视频只排分镜、不提交渲染 · 素材包不发给任何平台';
    if (r.busy) {
      return `<button class="cf-all stop" type="button" data-act="runall">${ICON.pause}
        <div><b>停下 · 已跑完 ${r.steps.filter(s => s.st === 'ok').length}/${n} 项</b>
        <i>${esc(r.line || '')} · 再点一次停在下一步之前，已经跑出来的产物都留着</i></div></button>`;
    }
    return `<button class="cf-all" type="button" data-act="runall">${ICON.spark}
      <div><b>一键跑全套：文案 → 主图 → 分镜 → 素材包</b>
      <i>${esc(allCost())} · ${esc(tail)}</i></div></button>`;
  }
  function runAll() {
    const r = state.allRun;
    if (r.busy) {
      /* 「停下」只保证下一步不再开跑：正在跑的那一步（可能是模型调用）收不回来，别说成已经停了 */
      if (!r.abort) {
        r.abort = true;
        toast('已请求停下 · 手上这一步跑完就不再往下 · 已出的产物都留着'); render(); return;
      }
      /* 再按一次是「不等了」：网关卡住时这是唯一出口，左栏不能永远灰着。
         seq 一换，那趟即使晚一步回来也不会再把后续跑下去（见 step 里的对不上就收手）。 */
      r.seq++; r.busy = false;
      /* 没收尾的项一律标成 —，不能留在 … 上：那一行是这轮的唯一结论，转圈符号会让人以为还在跑 */
      r.steps.forEach(s => { if (s.st === 'wait' || s.st === 'run') { s.st = 'skip'; s.why = '已收手'; } });
      toast('已收手 · 卡住那一步即使回来也不再往下 · 设置与生成按钮恢复可用'); render(); return;
    }
    if (state.busy) { toast('单项生成正在跑 · 等它结束再按一键'); render(); return; }
    if (!prod()) { toast('商品库为空 · 先去「AI 商品与客服」建档'); render(); return; }
    const todo = allSteps();
    const seq = ++r.seq;
    r.busy = true; r.abort = false; r.line = '';
    r.steps = todo.map(s => ({ k: s.k, t: s.t, st: 'wait' }));
    state.toast = null;
    const dead = () => seq !== r.seq;
    const skipRest = from => r.steps.forEach((s, i) => { if (i >= from && s.st === 'wait') s.st = 'skip'; });
    const finish = why => {
      r.busy = false;
      const ok = r.steps.filter(s => s.st === 'ok').length;
      r.line = r.steps.map(s => s.t + ' ' + ALL_ST[s.st]).join('  ');
      /* 停下时不能说「已停」：手上那一步（可能是模型调用）收不回来，只能说跑到第几项时不再往下 */
      const pend = r.steps.some(s => s.st === 'run') ? '（等当前这项跑完）' : '';
      /* 每一项的单项回音都会被这条总结盖掉，所以哪里没成必须在总结里再讲一遍，不能只留个 ✓/✗ */
      const bad = r.steps.filter(s => s.st === 'no').map(s => s.t + ' 没跑成（' + (s.why || '未知') + '）');
      const skiped = r.steps.filter(s => s.st === 'skip' && s.why).map(s => s.t + ' 跳过（' + s.why + '）');
      /* 选了模型却没跑成（网关回退到本地拼装）：这也得说，否则一句「跑完 4/4」把回退盖住了 */
      const fell = state.engine !== 'local' && r.steps.some(s => s.k === 'copy' && s.st === 'ok')
        && state.gen.copy && state.gen.copy.live === false;
      toast((why ? why + ' · ' : '') + (r.abort ? '停在 ' + ok + '/' + todo.length + ' 项' + pend : '一键跑完 ' + ok + '/' + todo.length + ' 项')
        + ' · 产物在各自那一栏 · 视频没有提交任何渲染作业 · 素材包没有发给任何平台'
        + (fell ? ' · 文案没跑成模型，这一版是本地拼装' : '')
        + (bad.length || skiped.length ? ' · ' + bad.concat(skiped).join(' ') : ''));
      render();
    };
    const step = i => {
      /* 收手之后这一趟就废了：还挂着的请求晚一步回来也不再改界面、不再往下跑 */
      if (dead()) { r.busy = false; return; }
      if (r.abort) { skipRest(i); return finish('你按了停下'); }
      if (i >= r.steps.length) return finish();
      const s = r.steps[i];
      /* 没勾平台时素材包这一步本来就会被 makePkg 拒掉；在这里标成「—」并把原因写出来，
         比让它悄悄失败成「✗」诚实，也比假装成功强。 */
      if (s.k === 'publish' && !state.selPlat.length) {
        s.st = 'skip'; s.why = '没勾平台'; r.line = '素材包这步跳过：没勾平台'; render(); return step(i + 1);
      }
      s.st = 'run'; r.line = '正在跑 ' + s.t + ' · 第 ' + (i + 1) + '/' + r.steps.length + ' 项';
      /* 产物就在自己那一栏：跑到哪一栏就切到哪一栏，用户看得见进度，不是转圈等一个黑盒 */
      state.tab = s.k; render();
      return Promise.resolve(genStep(s.k)).then(out => {
        /* 已收手：手上这一项即使跑完也不再改那行结论（产物本身照常留在它那一栏），
           否则「停在哪儿」会变成一桩取决于请求什么时候回来的事，界面会自己改口。 */
        if (dead()) return;
        s.st = out ? 'ok' : 'no';
        if (!out) s.why = s.k === 'copy' ? '引擎没返回' : '没出产物';
        return step(i + 1);
      }, err => {
        if (dead()) return;
        s.st = 'no'; s.why = String((err && err.message) || err || '').slice(0, 60);
        render();
        /* 文案失败就到此为止：主图的文字、分镜的字幕、素材包的字段全拿它当底，
           硬跑下去只会出一份看起来完整、其实底稿是空的稿子。 */
        if (s.k === 'copy') { skipRest(i + 1); return finish('文案这一步没跑成：' + s.why); }
        return step(i + 1);
      });
    };
    return step(0);
  }

  /* 进入视频 / 图片屏时先把文案跑出来：这两屏的中栏挂着「AI 生成的文案」，
     空着一栏等于没复刻到位。手动点「开始生成视频」不会顺手重跑文案——那是另一件事。 */
  function autoRun(t) {
    /* 一键跑全套时不插手：它自己会按顺序把每一栏跑出来，这里再插一次只会打架 */
    if (state.allRun.busy) { render(); return; }
    /* 走模型时一律不自动跑：一次云端调用十几秒、按 token 计钱，不能因为"进了页面/换了商品"就替用户点下去。
       本地规则引擎是免费且逐字确定的，保持进来就有稿子，离线演示不受影响。 */
    if (state.engine !== 'local') {
      /* 只有文案栏那颗按钮会叫模型写；图片/分镜/素材包按下去是本地拼装、不花钱也不等十几秒，
         把「要模型写」挂在它们身上是说谎，也是把人往错误的按钮上引 */
      const cost = state.engine === 'ollama' ? '本机模型一次约 1 分钟' : '一次约 10~30 秒';
      const LOCAL_OUT = { image: '用商品库资料画海报', video: '用商品库资料排分镜', publish: '用商品库字段导素材包' };
      toast(t === 'copy' ? '引擎是「' + engineOf(state.engine).t + '」· 要模型写就按下面的「' + GEN_LABEL.copy + '」，' + cost
        : '引擎是「' + engineOf(state.engine).t + '」· 左栏「' + GEN_LABEL[t] + '」是' + LOCAL_OUT[t]
          + '，不叫模型写文案 · 要模型写去「' + capName('copy') + '」那一栏，' + cost);
      return;
    }
    if ((t === 'video' || t === 'image') && !genOf('copy')) {
      return makeCopy().then(c => { if (c) runTab(t); });
    }
    runTab(t);
  }
  /* 切 Tab 就擦掉上一条回执：它说的是上一个 Tab 的结论，挂在别处就是假信息 */
  function goTab(id, keep) {
    if (!hasTab(id)) return;
    if (!keep && id !== state.tab) { state.toast = null; stop(); stopPoll(); stopImgPoll(); }
    state.tab = id;
    if (!genOf(id)) { render(); autoRun(id); return; }
    render();
    /* 回视频屏重新读一遍作业：离开时停了轮询，百炼那边这几十秒里可能已经跑完了 */
    if (id === 'video') loadVideoJobs().then(render);
    /* 图片屏同理：底图在百炼那边跑的时候切走再回来，得重新读到落盘的 PNG，海报才会换图 */
    if (id === 'image') loadImageJobs().then(render);
  }

  /* ---------- 外壳交互 ---------- */
  SHELL.onMessage(d => {
    if ('active' in d) {
      if (d.active) { Promise.all([loadProds(), loadPlats(), loadHist(), loadVideo(), loadImage()]).then(render, () => render()); }
      else { stop(); stopPoll(); stopImgPoll(); }
      return;
    }
    if (d.open && d.open.tab) goTab(d.open.tab, true);
  });
  if (SHELL.embedded) {
    addEventListener('wheel', e => {
      if (!e.target.closest('.cf-pick, .cf-card.grow, .cf-board, .cf-copy')) SHELL.post({ swipe: e.deltaY });
    }, { passive: true, capture: true });
    addEventListener('keydown', e => {
      if (/^Arrow(Up|Down)$|^Page(Up|Down)$/.test(e.key) && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) SHELL.post({ navKey: e.key });
    });
  }

  /* ---------- 启动 ---------- */
  function tick() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    $('cfClock').textContent = d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function boot() {
    $('stage').addEventListener('click', onClick);
    $('stage').addEventListener('change', onChange);
    const want = new URLSearchParams(location.search).get('tab');
    window.__AI_READY = false;
    loadSpec().then(sp => { state.spec = sp; if (hasTab(want)) state.tab = want; return DS.ready(); })
      .then(() => Promise.all([loadProds(), loadPlats(), loadHist(), loadEngines(), loadVideo(), loadImage()]))
      .then(() => {
        state.ready = true;
        window.__AI_READY = true;
        render();
        SHELL.post({ ready: VIEW });
        if (state.prodId) autoRun(state.tab);
        else toast('商品库为空 · 先去「AI 商品与客服」建档');
      }, err => {
        $('cfSide').innerHTML = '<section class="cf-card"><div class="cf-h"><span>内容工厂起不来</span></div>'
          + '<div class="ai-err">' + esc(DB.downMessage(err)) + '</div></section>';
        $('cfState').textContent = '数据层未就绪 · 页面停在这里';
        $('cfMid').innerHTML = '<div class="ai-err">没有数据层就没有内容：请先启动 tools/proxy.mjs（默认 :8642，指向 data/app.db）。</div>';
      });
    tick(); setInterval(tick, 1000);
  }
  boot();
})();
