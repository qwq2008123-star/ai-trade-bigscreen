/* 第四屏拆成两页：4a 是每天动手的（市场适配 / 商品 / 客服），4b 是每天看的（总览 / 洞察 / 建议）。
   两页共用本模块，按 <body data-view> 决定放哪几个模块。
   页面不写任何业务数字：市场与趋势经 SHOP / DS / API 取，商品与客服读本地数据库（data/app.db）；
   每条 AI 结论带 evidence（指标 / 数值 / 来源），商品页的写操作由接口真的落库并在 ai_ops 留痕。 */
(function () {
  'use strict';

  const T = window.TRADE, DS = window.DS, AI = window.AI, SHOP = window.SHOP, SHELL = window.SHELL;
  const $ = id => document.getElementById(id);
  const VIEW = document.body.dataset.view === 'b' ? '4b' : '4a';

  /* ?live=1 → 切到本地后端网关（tools/proxy.mjs）：由服务端持 Dify token 调工作流，浏览器永远拿不到密钥。
     不带该参数时页面仍是纯 mock，离线可演示。部署版没有网关，带上它也只能读到不存在的接口，故忽略。 */
  if (!window.DB.hosted && new URLSearchParams(location.search).has('live')) API.setProvider('http', { base: location.origin });

  /* ---------- 1920x1080 等比缩放（与前三屏同一口径） ---------- */
  function fitStage() {
    /* 优先按宽度铺满：外壳左栏挤掉的宽度不该由正文两侧裁掉。窗口比 16:9 矮时改按高度缩，
       否则舞台上下各顶出屏幕一截，而 html,body 是 overflow:hidden，那几十像素永远滚不回来。 */
    const s = Math.min(innerWidth / 1920, innerHeight / 1080);
    $('stage').style.transform = `scale(${s})`;
  }
  addEventListener('resize', () => { fitStage(); charts.forEach(c => c.resize()); });
  fitStage();

  const ALL_TABS = [
    { id: 'dash', t: 'AI 店铺总览' },
    { id: 'goods', t: 'AI 商品管理' },
    { id: 'service', t: 'AI 客服中心' },
    { id: 'insight', t: '客户洞察' },
    { id: 'fit', t: 'AI 市场适配' },
    { id: 'center', t: 'AI 经营中心' }
  ];
  const VIEW_OF = {
    fit: '4a', goods: '4a', service: '4a',
    dash: '4b', insight: '4b', center: '4b'
  };
  const TABS = ALL_TABS.filter(t => VIEW_OF[t.id] === VIEW);
  const HOME = VIEW === '4a' ? 'fit' : 'dash';
  /* 功能一：市场适配 → 寻找客户 → 建立店铺 → 创建商品 → AI 客服 → 行为分析 → 主动跟进 → 销售转化 → 经营建议
     跨页的条目写 page（'3b' 是内容工厂页），本页的写 tab。 */
  const FLOW = [
    { t: 'AI 市场适配', tab: 'fit', from: '逐条打分 + 依据' },
    { t: 'AI 生成营销内容', page: '3b', tab: 'copy', from: '文案 → 图片 → 分镜 → 素材包' },
    { t: '建立店铺', tab: 'dash', from: '店铺上下文 · 左栏' },
    { t: '创建商品', tab: 'goods', from: 'AI 上架 · 写库并改状态' },
    { t: 'AI 客服接待', tab: 'service', from: '逐条意图分析' },
    { t: '客户行为分析', tab: 'insight', from: '事件流 → 意向分' },
    { t: 'AI 主动跟进', tab: 'service', from: '行为阈值 → 建议 → 点发送才写' },
    { t: '销售转化', tab: 'center', from: '漏斗 + 订单贡献' },
    { t: 'AI 店铺经营建议', tab: 'center', from: '今日行动计划' }
  ];
  const SAMPLES = [
    '真无线降噪耳机，美国，25-40 岁通勤用户',
    '智能手表，德国，健身与健康管理人群',
    '移动电源，日本，出差与通勤',
    '蓝牙音箱，墨西哥，户外与聚会'
  ];
  const CHARTS = [
    { k: 'vis', t: '访客', c: '#58a6ff' },
    { k: 'views', t: '商品浏览', c: '#8fd6ff' },
    { k: 'cart', t: '加购', c: '#ffd76a' },
    { k: 'ord', t: '订单', c: '#7ef0cf' },
    { k: 'rev', t: '销售额', c: '#ff9b8a' }
  ];

  const state = {
    tab: HOME, iso: 'USA', product: '真无线降噪耳机', audience: '', query: '',
    chatId: null, prodId: null, optId: null, lang: 'en', insightCust: null,
    filters: { keyword: '', cat: '', status: '', sort: 'gmv' },
    cache: {}, busy: false, series: null,
    /* 商品页：列表与扫描结果都来自本地库，面板开合与最近一次写库结果留在内存里 */
    goods: { rows: [], scan: null }, tidy: { open: false, group: null },
    gen: { open: false, draft: null, form: {}, missing: [], evidence: [], notices: [], error: '', note: '', liveTag: '' },
    /* 客服中心：选中客户、待发送文本、知识库面板开合。文本只在内存里，点了发送才写 messages */
    cs: { cust: null, conv: null, text: null, edit: false, say: '', del: null, kbOpen: false, kbQ: '' },
    /* AI 主动跟进：清单只读 /api/db/followups；pick 是当前看草稿的客户，同样点发送才写库 */
    fu: { pick: null, edit: false, text: null, open: false },
    /* 演示自动对话：playing 存正在演的那个客户号（换客户就停），timer 是轮与轮之间的定时器 */
    demo: { playing: null, timer: null, round: null, seq: 0, cleared: 0, clearedRows: null },
    /* 订单明细：库里几百笔，界面一次只展开一天。ordDay 为空 = 后端按日报最后一天（"今日"）给 */
    ordDay: null, ordStatus: '', ordDays: [],
    plat: false,
    copy: null, toast: ''
  };

  /* 部署版没有库：页面上「本地数据库」这个出处名和「真的写库」的承诺都得按这份改口 */
  const DBN = DB.hosted ? '只读快照' : '本地数据库';
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const SRC = {
    live: ['世行 · 接口', 'live'], mock: ['模拟数据', 'mock'], derived: ['推算值', 'derived'],
    gap: ['待接入', 'gap'], input: ['人工输入', 'derived'], struct: ['结构 · 示例数据', 'mock'],
    wb: ['世行 · 内嵌快照', 'live'], db: [DBN + ' · ' + (DB.hosted ? '未落库' : '已落库'), 'live']
  };
  function srcTag(src, text) {
    const k = SRC[src] || ['待接入', 'gap'];
    return `<span class="ai-src ${k[1]}">${esc(text || k[0])}</span>`;
  }
  function evHtml(list, title) {
    if (!list || !list.length) return '';
    return `<div class="ai-ev"><div class="ai-ev-t">${esc(title || '依据 · 指标 / 数值 / 来源')}</div>`
      + list.map(e => `<div class="r"><b>${esc(e.label)}</b><s>${esc(e.value)}</s><em>${esc(e.src)}</em></div>`).join('')
      + '</div>';
  }
  function head(title, sub, src, srcText) {
    return `<div class="ai-top"><div style="flex:1"><h3>${esc(title)}${srcTag(src, srcText)}</h3><p>${sub || ''}</p></div></div>`;
  }
  /* 所有 AI 结论统一走 API.ai.invoke（mock 走本地引擎，http 走后端→Dify），这里只剥掉传输包装 */
  const ai = (name, input) => API.ai.invoke(name, input).then(r => {
    const d = r && r.data !== undefined ? r.data : r;
    if (d && typeof d === 'object') d.__m = (r && r.meta) || null;
    return d;
  });
  /* 来源徽标只在工作流真的跑通时才标 live；代理回退到本地引擎时 meta.src 仍是 mock，不会假装调用过模型 */
  function provArgs(d, fbSrc, fbText) {
    const m = d && d.__m;
    if (m && m.src === 'live' && m.workflow) return ['live', m.workflow + ' · ' + m.model + ' 实时'];
    if (m && m.fallback) return ['gap', '模型不可用 · 已回退本地'];
    return [fbSrc, fbText];
  }
  const liveTag = d => { const a = provArgs(d); return a[0] === 'live' ? ' · ' + a[1] : ''; };
  const cnName = iso => DS.name(iso) || iso;
  const usd = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = n => (n > 0 ? '+' : '') + n + '%';
  function delta(d, unit) {
    const cls = d > 0 ? 'up' : d < 0 ? 'dn' : 'fl';
    const ar = d > 0 ? '▲' : d < 0 ? '▼' : '—';
    return `<i class="sp-d ${cls}">${ar} ${Math.abs(d)}${unit || '%'}</i>`;
  }
  const stage = s => `<span class="ai-pill ${/成交|复购/.test(s) ? 'g' : /建联|寄样|报价|高意向/.test(s) ? 'y' : ''}">${esc(s)}</span>`;
  const scoreBar = (n, hot) => `<span class="sp-bar"><s class="${hot ? 'hot' : ''}" style="width:${Math.max(2, Math.min(100, n))}%"></s></span>`;

  /* ---------- 左栏 ---------- */
  /* 只有商品与客服页带 AI 指令卡（市场适配 / 商品生成要读它）；分析页没有，取值时得先判断 */
  const HAS_INPUT = () => !!$('spProduct');

  function buildShopCard() {
    /* 店铺卡只认本地数据库这一份来源；库没起来就明说不可读，绝不拿快照 JSON 顶上去（两处名字会打架） */
    if (!window.DB || !DB.status().ok) {
      $('spShopSrc').textContent = '不可读';
      $('spShop').innerHTML = '<div class="nm">—</div><div class="ai-err">店铺信息未读取：本地数据库未启动，本页不提供快照兜底。</div>';
      return Promise.resolve(null);
    }
    return DB.shop().catch(() => null).then(d => {
      const sh = (d && d.shop) || {}, plats = (d && d.platforms) || [];
      $('spShopSrc').textContent = d ? (DB.hosted ? '只读快照 · 种子 ' : '读写本地库 · 种子 ') + String(d.seeded_at || '').slice(0, 10) : '读取失败';
      $('spShop').innerHTML = `<div class="nm">${esc(sh.name || '—')}</div>
        <dl>
          <dt>品类</dt><dd>${esc(sh.category || '—')}</dd>
          <dt>供应链</dt><dd>${esc(sh.supply_region || '—')}</dd>
          <dt>开店</dt><dd>${esc(sh.since || '—')}</dd>
          <dt>在售市场</dt><dd>${(sh.markets || []).map(cnName).join(' / ')}</dd>
        </dl>
        <div class="sp-plat">${plats.map(p => `<i class="${p.status === 'connected' ? 'on' : ''}" title="${esc(p.note || '')}">${esc(p.name)} ${p.status === 'connected' ? '已连接' : '未连接'}</i>`).join('')}</div>`;
      return null;
    });
  }
  /* 两页共用一份 AI 指令口径：在商品页改了目标国家，切到分析页的适配入口不能还拿旧值。
     同源 iframe 共享 sessionStorage，写入在这里，对账由外壳的 active 消息触发。 */
  const CTX = 'shop.ctx';
  function ctxObj() {
    return { product: state.product, iso: state.iso, audience: state.audience, query: state.query };
  }
  function saveCtx() { SHELL.saveCtx(CTX, ctxObj()); }
  function writeInputs() {
    if (!HAS_INPUT()) return;
    $('spProduct').value = state.product;
    $('spAudience').value = state.audience;
    $('spQuery').value = state.query;
    $('spIso').value = state.iso;
  }
  function hydrateCtx() {
    const c = SHELL.loadCtx(CTX);
    if (!c) return false;
    const now = ctxObj();
    if (c.product === now.product && c.iso === now.iso && c.audience === now.audience && c.query === now.query) return false;
    Object.assign(state, { product: c.product, iso: c.iso, audience: c.audience, query: c.query });
    writeInputs();
    return true;
  }

  function buildInput() {
    if (!HAS_INPUT()) return;
    AI.markets().forEach(iso => {
      const o = document.createElement('option');
      o.value = iso;
      o.textContent = cnName(iso) + ' ' + iso;
      $('spIso').appendChild(o);
    });
    writeInputs();
    $('spSamples').innerHTML = SAMPLES.map((s, i) => `<button type="button" data-s="${i}">${esc(s)}</button>`).join('');
    $('spSamples').onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      applySample(SAMPLES[+b.dataset.s]);
      run(true);
    };
    /* 先把上一条回执擦掉再重算：输入变了却还挂着「结论与上一次完全一致」就是假话 */
    $('spRun').onclick = () => { rerunNote = true; state.toast = ''; run(true); };
    ['spProduct', 'spAudience', 'spQuery'].forEach(id => {
      $(id).addEventListener('input', debounce(() => { readInputs(); state.cache = {}; run(true); }, 620));
    });
    $('spIso').onchange = () => { state.iso = $('spIso').value; state.cache = {}; run(true); };
  }
  const debounce = (f, ms) => { let id; return () => { clearTimeout(id); id = setTimeout(f, ms); }; };

  /* 示例与自然语言指令 → 左栏三个字段，避免在页面里写死解析规则之外的数字 */
  function applySample(q) {
    const parts = q.split(/[，,]/).map(s => s.trim()).filter(Boolean);
    state.product = parts[0] || state.product;
    state.audience = parts.slice(2).join('，') || parts[parts.length - 1] || '';
    state.query = q;
    $('spProduct').value = state.product;
    $('spAudience').value = state.audience;
    $('spQuery').value = state.query;
    AI.parse(q).then(p => {
      if (p.iso) { state.iso = p.iso; $('spIso').value = p.iso; }
    });
  }
  function readInputs() {
    if (!HAS_INPUT()) return state;
    state.product = $('spProduct').value.trim();
    state.audience = $('spAudience').value.trim();
    state.query = $('spQuery').value.trim();
    return state;
  }

  /* ---------- 外壳交互 ---------- */
  let paused = false;
  SHELL.onMessage(d => {
    if ('active' in d) {
      paused = !d.active;
      if (d.active && hydrateCtx()) { state.cache = {}; run(true); }
      return;
    }
    if (d.seedStore) { /* 预留：外壳下发真实店铺数据时只清缓存，逻辑不变 */ state.cache = {}; run(true); }
    if (d.open && d.open.tab) applyOpen(d.open, true);
  });
  if (SHELL.embedded) {
    addEventListener('wheel', e => {
      if (!e.target.closest('.ai-body, .ai-flow, .sp-msgs, .sp-evt, .ai-mail')) SHELL.post({ swipe: e.deltaY });
    }, { passive: true, capture: true });
    addEventListener('keydown', e => {
      if (/^Arrow(Up|Down)$|^Page(Up|Down)$/.test(e.key) && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
        SHELL.post({ navKey: e.key });
      }
    });
  }

  /* ---------- 主流程 ---------- */
  /* 正在渲染时收到的新请求不能悄悄丢掉：跨页「去优化」常常正好落在上一次渲染里 */
  let again = false;
  /* 只有点「运行 AI 分析」才会置位：别的动作自己带了 toast，不能被这句盖掉 */
  let rerunNote = false;
  function run(force, quiet) {
    if (state.busy) { again = true; return; }
    const tab = state.tab;
    const runBtn = $('spRun');
    saveCtx();
    /* force 会清缓存，先把上一版稿子留着：重算出来一字不差，就说明输入没变，这句得由界面说出口 */
    const prev = state.cache[tab];
    if (force) delete state.cache[tab];
    if (state.cache[tab]) { paint(state.cache[tab]); return; }
    state.busy = true;
    if (runBtn) runBtn.disabled = true;
    /* quiet 只给「自动刷新」用（演示每 2 秒重画一次）：把整块面板换成转圈，用户那一刻的按下与抬起
       就落在不同节点上，click 只会发到共同祖先 #spBody，委托找不到 [data-act] —— 这一下被静静吃掉。
       旧内容留在原地，新读到的那一帧到了再一次性换上，转圈只在首次进入该 Tab 时出现。 */
    if (!quiet) $('spBody').innerHTML = '<div class="ai-loading">正在读取店铺数据并生成分析…</div>';
    /* 拼装函数同步抛错也必须走同一条收尾：否则 state.busy 永远挂着，
       之后每一次 run() 都被 again 挡回去，整块面板从此点什么都没反应。 */
    let job;
    try { job = Promise.resolve(RUNNERS[tab]()); } catch (e) { job = Promise.reject(e); }
    job.then(html => {
      if (rerunNote && prev != null && prev === html) toast(tab === 'service'
        ? '已按这条会话重新生成 · 客户没有新消息，所以这一版建议回复与上一版一字不差（改稿请用「改一改再发」）'
        : 'AI 分析已按当前输入重新运行 · 输入未变，所以结论与上一次完全一致');
      state.cache[tab] = html;
      paint(html);
    }).catch(err => {
      $('spBody').innerHTML = '<div class="ai-err">生成失败：' + esc(err && err.message) + '</div>';
    }).then(() => {
      state.busy = false;
      if (runBtn) runBtn.disabled = false;
      /* 排队的那次也是用户点出来的：先把它跑完，别在收尾时把回执标记擦掉 */
      if (again) { again = false; run(true); return; }
      rerunNote = false;
    });
  }
  let charts = [];
  let paintedTab = '';
  /* 回执条钉在哪儿是有讲究的：客服中心那一屏，演示条 / 发送按钮都在右列的 .sp-comp 里，
     而 .sp-comp 自己会滚。把回执插在整块面板顶部时，用户为了点「▶」已经把它滚下来了，
     回执落在他看不见的上方，而每一轮重绘又把右列滚回顶部——按钮就从指针下面跑掉了，
     看上去正是「再点 ▶ 完全没反应」。
     所以客服页把回执贴在演示条的下面（不是上面）：手眼在同一块地方，
     回执每轮变长变短也只会往下撑，绝不会把用户正要按的那一排按钮顶走。 */
  function mountToast() {
    const body = $('spBody');
    if (!body || !state.toast) return null;
    let t = $('spToast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'ai-note ok'; t.id = 'spToast';
    }
    t.textContent = state.toast;
    const demo = body.querySelector('.sp-demo');
    if (demo) demo.after(t);
    else {
      const h = body.querySelector('.ai-top');
      if (h) h.after(t); else body.prepend(t);
    }
    return t;
  }
  /* 滚到某一行的起点。首选 offsetTop：它本来就是未缩放的 CSS 像素，和 scrollTop 同一个单位。
     rect 是缩放后的像素，拿 rect 差值直接减 scrollTop 会少滚 (1-k) 的距离——
     实测 k=0.674 时那条客户问话永远停在框顶外几像素，看上去就像"客户那边没说话"。
     只有当 box 不在这条行的 offsetParent 链上（box 不是定位元素）时才退回按 k 折算。 */
  function scrollRowToTop(box, el, pad) {
    let y = null, n = el;
    while (n && n !== box) {
      if (!box.contains(n)) break;
      y = (y || 0) + n.offsetTop;
      n = n.offsetParent;
    }
    if (n !== box || y == null) {
      const h = box.offsetHeight, k = h ? box.getBoundingClientRect().height / h : 1;
      y = (el.getBoundingClientRect().top - box.getBoundingClientRect().top) / (k > 0 ? k : 1) + box.scrollTop;
    }
    box.scrollTop = Math.max(0, y - (pad == null ? 8 : pad));
  }
  /* 会话区停在「客户最后一条」那一行，不是整段最底部：AI 那条回答常常比一屏还高，
     硬滚到底会把客户那句话顶出视口——演示时看上去就像只有店员在自言自语。
     判据只有一条：这一行的顶边已经在框顶之上（被切了）才动手，否则一律不碰用户自己滚到的位置。 */
  function pinLastQuestion(box) {
    const lastQ = [...box.querySelectorAll('.sp-msg:not(.ai)')].pop();
    if (!lastQ) return;
    if (lastQ.getBoundingClientRect().top < box.getBoundingClientRect().top - 0.5) scrollRowToTop(box, lastQ);
  }
  function paint(html) {
    charts.forEach(c => { try { c.dispose(); } catch (e) { /* 已销毁 */ } });
    charts = [];
    /* 右列（含演示条）的滚动位置要跨重绘留住：演示每 2 秒重画一次，
       每次 innerHTML 一换 scrollTop 就归零，用户刚瞄准的按钮会被卷回顶部。 */
    const sameTab = paintedTab === state.tab;
    const oldComp = sameTab ? $('spBody').querySelector('.sp-comp') : null;
    const compTop = oldComp ? oldComp.scrollTop : 0;
    $('spBody').innerHTML = html || '<div class="ai-hint">无数据</div>';
    /* 换 Tab 就把正文滚回顶部：上一屏滚到哪儿是上一屏的事。
       不重置的话从经营中心滚回总览，KPI 卡上的明细入口会停在视口外——用户看到的正是「找不到订单」。 */
    if (!sameTab) { $('spBody').scrollTop = 0; paintedTab = state.tab; }
    /* 点 KPI 上的「逐笔订单明细」进来要停在明细表那一行，不能停在行动计划顶上让人自己往下找 */
    if (state.ordFocus) {
      state.ordFocus = false;
      const s = $('ordSec');
      if (s) scrollRowToTop($('spBody'), s);
    }
    /* 反馈条由 paint 统一挂载：run 之后才设的 toast 才赶得上这一帧，
       也不必每个视图各自记得拼一份（原来 fit 页就没有，等于点了没反应）。 */
    mountToast();
    const newComp = sameTab ? $('spBody').querySelector('.sp-comp') : null;
    if (newComp) newComp.scrollTop = compTop;
    document.querySelectorAll('.ai-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
    document.querySelectorAll('.ai-flow li').forEach(li => li.classList.toggle('on', li.dataset.tab === state.tab));
    if (state.series && $('spChartHost')) drawCharts(state.series);
    bindBody();
    /* 会话区停在「客户最后一条」那一行，不是整段最底部：AI 那条回答常常比一屏还高，
       硬滚到底会把客户那句话顶出视口——演示时看上去就像只有店员在自言自语。 */
    const box = $('spBody').querySelector('.sp-msgs');
    if (box) {
      box.scrollTop = box.scrollHeight;
      pinLastQuestion(box);
      /* 这一帧之后还可能被别人挪走：回执条的 scrollIntoView、按钮拿焦点时的自动滚动、
         外框高度落定后的重排。只要客户那行的顶边又跑到框顶之上就补一次，
         没被切到就什么都不做——绝不去抢用户自己滚出来的位置。 */
      requestAnimationFrame(() => { if (box.isConnected) pinLastQuestion(box); });
    }
  }
  /* 换 Tab 就擦掉上一条回执：它说的是上一次动作 / 上一个 Tab 的结论，挂在别处就成了假信息 */
  function goTab(id) { if (id !== state.tab) state.toast = ''; state.tab = id; run(false); }
  /* 模块可能在另一页：本页有就直接渲染，没有就交回外壳切屏，并带上要选中的商品 / 会话 / 客户 */
  function openTab(id, extra) {
    const payload = Object.assign({ tab: id }, extra || {});
    if (VIEW_OF[id] === VIEW) { applyOpen(payload); return; }
    saveCtx();
    SHELL.goto(VIEW_OF[id], payload);
  }
  /* 流程条里指向获客两页的步骤：带 page 的一律交给外壳切屏 */
  function openFlow(f) {
    if (f.page) { saveCtx(); SHELL.goto(f.page, f.tab ? { tab: f.tab } : null); return; }
    /* 点已经站着的步骤也得有回应：重画一次并说清出处，别让入口看着是死的 */
    if (f.tab === state.tab) { toast('已经在「' + f.t + '」· 这一块的出处：' + (f.from || '本页')); run(false); return; }
    openTab(f.tab);
  }
  function applyOpen(o, fromOtherPage) {
    if (VIEW_OF[o.tab] !== VIEW) return;
    /* 从另一页过来先对账输入；本页内切换不读 sessionStorage，免得盖掉刚改的口径 */
    if (fromOtherPage && hydrateCtx()) state.cache = {};
    /* 选中对象变了必须重渲染：列表缓存里带着上一次的选中行和高亮 */
    if (o.prodId) { state.prodId = o.prodId; state.optId = null; state.optHtml = ''; delete state.cache.goods; }
    if (o.chatId) { state.chatId = o.chatId; delete state.cache.service; }
    if (o.cust) { state.insightCust = o.cust; delete state.cache.insight; }
    /* 订单明细定位到某一天（KPI 上的「看逐笔」带的日期，可能来自另一屏的载荷） */
    if (o.day) { state.ordDay = o.day; state.ordFocus = true; delete state.cache.center; }
    goTab(o.tab);
  }

  /* ---------- 图表 ---------- */
  function drawCharts(s) {
    if (typeof echarts === 'undefined') return;
    CHARTS.forEach((c, i) => {
      const el = $('sp-c' + i);
      if (!el) return;
      const ch = echarts.init(el);
      const data = s[c.k];
      const last = data[data.length - 1], prev = data[data.length - 2] || last;
      const host = el.closest('.sp-chart');
      if (host) host.querySelector('.v').innerHTML = Number(last).toLocaleString('en-US') + ' ' + delta(+((last / prev - 1) * 100).toFixed(1));
      ch.setOption({
        animation: false,
        grid: { left: 18, right: 8, top: 8, bottom: 26 },
        xAxis: {
          type: 'category', data: s.x, boundaryGap: false,
          axisLine: { lineStyle: { color: 'rgba(90,140,210,.3)' } }, axisTick: { show: false },
          axisLabel: { color: "rgba(140,175,220,.75)", fontSize: 13, interval: 8 }
        },
        yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: 'rgba(90,140,210,.12)' } }, axisLabel: { show: false } },
        tooltip: {
          trigger: 'axis', backgroundColor: 'rgba(6,14,28,.92)', borderColor: 'rgba(90,140,210,.4)',
          textStyle: { color: '#dbeaff', fontSize: 13 },
          formatter: p => p[0].axisValue + ' · ' + c.t + ' ' + Number(p[0].value).toLocaleString('en-US')
        },
        series: [{
          type: 'line', data: data, smooth: true, symbol: 'none',
          lineStyle: { color: c.c, width: 2 },
          areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: c.c + '66' }, { offset: 1, color: c.c + '00' }]) }
        }]
      });
      charts.push(ch);
    });
  }
  const chartHost = () => `<div id="spChartHost" class="sp-charts">` + CHARTS.map((c, i) =>
    `<div class="sp-chart"><h6><span>${c.t}</span><b class="v"></b></h6><div class="sp-cv" id="sp-c${i}"></div></div>`).join('') + '</div>';

  /* ---------- 商品页面板：全部读写本地数据库 ---------- */
  const ST_CN = { draft: '草稿', under_review: '审核中', online: '已上架', offline: '已下架' };
  /* 整理面板里的「去处理」直接跳到详情面板对应的那一处 */
  const FOCUS_OF = { stock: 'edDelta', status: 'spOpsRow', price: 'edPrice' };
  function dbErr(what) {
    const info = (window.DB && DB.status().info) || {};
    return `<div class="ai-err">${esc(what)}读写不可用：${esc(info.error || '本地数据库未启动')}。
      本页不提供快照兜底——请先执行 <code>node tools/seed.mjs</code>，再用 <code>node tools/proxy.mjs</code> 打开本页。</div>`;
  }
  function legalFor(status) {
    return (((DB.status() || {}).info || {}).transitions || []).filter(t => (t.from || []).indexOf(status) >= 0);
  }
  const short = s => { const v = String(s == null ? '' : s); return v.length > 150 ? v.slice(0, 150) + '…' : v; };

  /* ---------- 电商平台接缝 ----------
     状态一律来自 /api/db/platforms（唯一出处 tools/platforms.mjs），这里不抄一份「未连接」文案。
     面板里没有任何「同步到平台」按钮：真实调用没实现之前，做一个点了会显示成功的按钮就是造假。 */
  const platNote = p => (p && p.note) || '尚未连接电商平台';
  /* 接缝那句以句号收尾，嵌进半句里要去掉，否则页面上出现「请求。，」 */
  const platHalf = p => platNote(p).replace(/[。；]$/, '');
  function platPanel(p) {
    if (p && p.error) {
      return `<div class="sp-seam" id="platPanel"><div class="hd"><b>电商平台连接</b>
        <span class="ai-err" style="margin:0">${esc(p.error)}</span></div></div>`;
    }
    const items = (p && p.items) || [];
    const on = items.filter(x => x.configured).length;
    const chips = items.map(x => `<i class="${x.configured ? 'on' : ''}" title="${esc(x.note)}">${esc(x.name)} `
      + `${x.configured ? '凭据齐全 · 仍未实现调用' : '未连接 · 缺 ' + x.missing.length + ' 项凭据'}</i>`).join('');
    const detail = !state.plat ? '' : `<div style="overflow-x:auto"><table class="ai-table" style="margin-top:8px"><thead><tr>
        <th>平台</th><th>鉴权方式</th><th>要填的凭据（只列名字，值不进浏览器）</th><th>还缺</th><th>接上之后能做什么</th><th>接口地址（文档，未调用过）</th></tr></thead>
      <tbody>${items.map(x => `<tr>
        <td><span class="sp-name">${esc(x.name)}</span><span class="sp-en">${esc(x.seeded_as || '库里没有这一行')} · ${esc(x.seeded_status || '')}${x.status_stale ? '（与实时检测结果不一致）' : ''}</span></td>
        <td>${esc(x.auth)}</td>
        <td>${(x.required || []).map(r => `<code>${esc(r)}</code>`).join(' ')}</td>
        <td>${x.missing.length ? x.missing.map(m => `<span class="sp-warn">${esc(m.env)}</span><i class="sp-en"> ${esc(m.why)}</i>`).join('<br>') : '<span class="sp-ok">不缺，但仍未实现真实调用</span>'}</td>
        <td>${(x.capabilities || []).map(c => esc(c)).join(' / ')}</td>
        <td><code>${esc(x.endpoint)}</code></td></tr>`).join('')}</tbody></table></div>
      <div class="ai-note">${esc(p.notice || '')}</div>
      <div class="ai-note">出处：${esc(p.source || '—')}（凭据读 ${esc(p.env_file || '—')} 或环境变量）· 库里的 4 行由同一处播种 · 每次「上架」都会问一遍这 ${items.length} 个适配器，返回原样记进 ai_ops</div>`;
    return `<div class="sp-seam" id="platPanel">
      <div class="hd"><b>电商平台连接</b>
        <span class="ai-pill ${on ? 'y' : ''}">${on} / ${items.length} 已连接</span>
        <button class="ai-btn xs" data-act="plat-toggle" type="button">${state.plat ? '收起明细' : '缺哪些凭据'}</button>
        <button class="ai-btn xs" data-act="plat-recheck" type="button">重新检测</button>
        <span class="ai-note" style="margin:0">${esc(platNote(p))}</span></div>
      <div class="sp-plat">${chips}</div>${detail}</div>`;
  }
  function platRecheck() {
    state.plat = true;
    return done(DB.platforms(), r => '平台连接重新检测完成：' + r.connected + ' / ' + r.items.length
      + ' 已连接 · 出处 ' + r.source + ' · 本次没有向任何平台发出请求');
  }

  /* 「AI 整理店铺」：条目来自 /api/db/store/scan（tools/store-ops.mjs 扫出来的），这里只负责摆出来与下指令 */
  function tidyPanel(scan) {
    if (!state.tidy.open) return '';
    return `<div class="sp-ai"><h4>AI 整理店铺<em>扫描 ${scan.scanned} 个商品 × ${scan.rules_checked} 条规则 · 共 ${scan.total} 项，其中 ${scan.fixable} 项可自动修、${scan.needs_human} 项需人工确认</em></h4>
      <div class="sp-row" style="margin-bottom:10px">
        <button class="ai-btn pri" data-act="tidy-apply" data-scope="all" type="button">AI 一键整理（${scan.fixable} 项）</button>
        <button class="ai-btn" data-act="tidy-scan" type="button">重新扫描</button>
        <button class="ai-btn" data-act="tidy-close" type="button">收起</button>
        <span class="ai-note" style="margin:0">${DB.hosted ? '这一版是只读快照：改字段会被当场拒绝，「最近 AI 操作」里不会多出记录' : '每改一个字段都写进 ai_ops，可在下方「最近 AI 操作」里核对'}</span>
      </div>
      <div class="sp-grps">${scan.groups.map(g => `
        <div class="sp-grp${state.tidy.group === g.key ? ' on' : ''}">
          <div class="hd"><b class="nm" data-act="tidy-group" data-rule="${g.key}">${state.tidy.group === g.key ? '▾' : '▸'} ${esc(g.label)}</b>
            <s>${g.count} 个商品</s>
            ${g.fixable ? `<button class="ai-btn xs" data-act="tidy-apply" data-scope="rule" data-rule="${g.key}" type="button">只整理这一类（${g.fixable} 项）</button>` : ''}
            ${g.needs_human ? `<u class="sp-warn">${g.needs_human} 项需人工确认</u>` : ''}
            <em>${esc(g.severity === 'high' ? '影响成交' : g.severity === 'mid' ? '影响转化' : '影响体验')}</em></div>
          <p>${esc(g.how)}</p>
          ${state.tidy.group === g.key ? `<div class="its">${g.items.map(f => `
            <div class="it"><i>${esc(f.product_id)}</i><span>${esc(f.name)}</span>
              ${evHtml(f.evidence, '判定依据（指标 / 数值 / 来源）')}
              ${f.plan ? `<div class="dofix">拟改 <code>${esc(f.plan.field)}</code> ← ${esc(short(JSON.stringify(f.plan.to)))}</div>` : ''}
              ${f.auto ? '' : `<div class="dofix warn">不自动改：${esc(f.why || '需要人工判断')} <button class="ai-btn xs" data-act="edit" data-id="${f.product_id}" data-focus="${FOCUS_OF[f.action] || 'edNameEn'}" type="button">去处理</button></div>`}
            </div>`).join('')}</div>` : ''}
        </div>`).join('')}</div>
      <div class="ai-note">${esc(scan.notice)}</div></div>`;
  }

  /* 「AI 上架商品」：表单 → /api/db/products/draft 预览 → 保存 / 立即上架 */
  const GEN_FORM = [['name', '产品名称 *', 'text'], ['info', '产品资料（参数、材质、认证、起订量，越具体越好）', 'area'],
    ['cost', '成本 USD', 'num'], ['stock', '库存件数', 'num'], ['audience', '目标客户', 'text'], ['image', '主图地址（留空用占位图）', 'text']];
  function genPanel() {
    const g = state.gen;
    if (!g.open) return '';
    if (!g.draft) {
      return `<div class="sp-ai"><h4>AI 上架商品<em>资料越全，草稿越全；缺的字段一律留【待填】，AI 不补数字</em></h4>
        <div class="sp-form">${GEN_FORM.map(f => `
          <label>${esc(f[1])}${f[2] === 'area'
            ? `<textarea class="ai-ta" id="gn${cap(f[0])}" rows="3">${esc(g.form[f[0]] || '')}</textarea>`
            : `<input class="ai-in" id="gn${cap(f[0])}" type="${f[2]}" value="${esc(g.form[f[0]] || '')}">`}</label>`).join('')}
          <label>目标国家<select class="ai-se" id="gnIso">${AI.markets().map(i => `<option value="${i}" ${i === g.form.iso ? 'selected' : ''}>${esc(cnName(i))} ${i}</option>`).join('')}</select></label>
        </div>
        <div class="sp-row" style="margin-top:10px">
          <button class="ai-btn pri" data-act="gen-run" type="button">生成草稿预览</button>
          <button class="ai-btn" data-act="gen-close" type="button">取消</button>
          <span class="ai-note" style="margin:0">目标国家取自左栏（当前 ${esc(cnName(state.iso))}），改了以左栏为准</span>
        </div>
        ${g.error ? '<div class="ai-err">' + esc(g.error) + '</div>' : ''}</div>`;
    }
    const d = g.draft;
    return `<div class="sp-ai"><h4>AI 上架商品 · 草稿预览<em>${esc(d.name)}${d.category ? ' · 归类 ' + esc(d.category) : ' · 待归类'}${esc(g.liveTag || '')}</em></h4>
      <div class="sp-row" style="margin-bottom:8px">
        <label class="sp-inline">英文标题<input class="ai-in" id="gdNameEn" value="${esc(g.form.name_en || d.name_en || '')}" placeholder="【待填】"></label>
        <label class="sp-inline">售价 USD<input class="ai-in" id="gdPrice" type="number" step="0.1" value="${esc(g.form.price != null ? g.form.price : (d.price == null ? '' : d.price))}"></label>
        <button class="ai-btn" data-act="gen-run" type="button">重新生成</button>
      </div>
      <div class="sp-cols">
        <div class="c" style="grid-column:span 3"><h5>英文描述（AI 拼装）</h5><p>${esc(d.description_en || '【待填】没有可用英文素材——先在上方补英文标题，或保存后点「AI 优化文案」') + (d.description_en ? '' : '')}</p>
          <i>${esc(d.description || '（资料原文为空）')}</i></div>
        <div class="c"><h5>卖点（资料原文）</h5><ol>${(d.bullets || []).map(b => `<li>${esc(b)}</li>`).join('') || '<li>【待填】资料里没有带单位的数字</li>'}</ol></div>
        <div class="c"><h5>规格</h5><ul>${Object.keys(d.specs || {}).map(k => `<li><i>${esc(k)}</i> ${esc(d.specs[k])}</li>`).join('') || '<li>【待填】</li>'}</ul></div>
        <div class="c"><h5>SEO 关键词 / 标签</h5><div class="sp-tags">${(d.keywords || []).map(k => `<span class="ai-pill">${esc(k)}</span>`).join('') || '<span class="ai-pill y">【待填】</span>'}
          ${(d.tags || []).map(t => `<span class="ai-pill g">${esc(t)}</span>`).join('')}</div>
          <p><i>售价 ${d.price == null ? '【待填】' : d.price + ' USD'} ｜ 成本 ${d.cost == null ? '【待填】' : d.cost + ' USD'} ｜ 库存 ${d.stock} 件 ｜ 状态 草稿</i></p></div>
        <div class="c"><h5>FAQ（店铺知识库原文）</h5><ul>${(d.faq || []).map(f => `<li><span>${esc(f.q)}</span><br><i>${esc(short(f.a))}${f.src ? ' ｜ 来源 ' + esc(f.src) : ''}</i></li>`).join('') || '<li>知识库无对应条目</li>'}</ul></div>
      </div>
      ${evHtml(g.evidence, '这份草稿的每个字段是怎么来的')}
      <div class="ai-sub" style="margin:10px 0 6px">还需要人工补的字段</div>
      <div class="sp-tags">${(g.missing || []).map(m => `<span class="ai-pill y" title="${esc(m.why)}">${esc(m.cn)}</span>`).join('') || '<span class="ai-pill g">字段齐全</span>'}</div>
      ${(g.missing || []).length ? '<div class="ai-note">想一次拿到更完整的草稿：在「产品资料」里带上参数与数字，例如「IPX5 防水 蓝牙5.3 单次续航 8 小时 成本 12 美元 库存 800」。</div>' : ''}
      ${g.notices.map(n => `<div class="ai-note warn">${esc(n)}</div>`).join('')}
      <div class="sp-row" style="margin-top:10px">
        <button class="ai-btn pri" data-act="gen-save" type="button">保存商品（写入本地库 · 草稿）</button>
        <button class="ai-btn" data-act="gen-opt" type="button">AI 优化（先存草稿，再生成英文文案）</button>
        <button class="ai-btn" data-act="gen-publish" type="button">保存并立即上架</button>
        <button class="ai-btn" data-act="gen-close" type="button">放弃这份草稿</button>
        ${g.note ? `<span class="ai-note ok" style="margin:0">${esc(g.note)}</span>` : ''}
      </div>
      <div class="ai-note">${esc(platNote(state.platInfo))}「立即上架」只把 products.status 改成 online，并把这 ${((state.platInfo || {}).items || []).length || '几'} 个适配器的回答记进 ai_ops。</div>
      ${g.error ? '<div class="ai-err">' + esc(g.error) + '</div>' : ''}</div>`;
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  /* 选中商品：档案 + 可编辑字段 + 补货 + AI 文案 */
  function detailPanel(p) {
    const st = ST_CN[p.status] || p.status;
    return `<div class="sp-detail" id="spDetail"><div class="ai-sub" style="margin-top:14px">商品详情与编辑 · ${esc(p.name)}（${p.id}）· ${esc(st)}</div>
      <div class="sp-cols">
        <div class="c"><h5>档案</h5><ul>
          <li><i>SKU</i> ${esc(p.sku || '—')}</li>
          <li><i>英文标题</i> ${esc(p.name_en || '（无）')}</li>
          <li><i>分类 / 目标市场</i> ${esc(p.category || '—')} / ${esc(cnName(p.target_country) || '—')}</li>
          <li><i>来源</i> ${esc(p.source || '—')}</li>
          <li><i>浏览 / 加购 / 订单</i> ${p.views} / ${p.cart} / ${p.ord}</li>
          <li><i>更新时间</i> ${esc(p.updated_at || '—')}</li></ul></div>
        <div class="c"><h5>改字段（${DB.hosted ? '只读快照 · 点了会被拒' : '直接写库'}）</h5>
          <label class="sp-inline">英文标题<input class="ai-in" id="edNameEn" value="${esc(p.name_en || '')}"></label>
          <label class="sp-inline">售价 USD<input class="ai-in" id="edPrice" type="number" step="0.1" value="${p.price}"></label>
          <label class="sp-inline">成本 USD<input class="ai-in" id="edCost" type="number" step="0.1" value="${p.cost}"></label>
          <label class="sp-inline">分类<input class="ai-in" id="edCat" value="${esc(p.category || '')}"></label>
          <div class="sp-row" style="margin-top:6px"><button class="ai-btn pri" data-act="edit-save" data-id="${p.id}" type="button">保存修改</button>
            <span class="ai-note" style="margin:0">${DB.hosted ? '这一版没有后端，保存会当场说明未写入' : '改了售价/库存/分类会同步知识库里的商品档案，AI 客服不会再按旧价回答'}</span></div></div>
        <div class="c"><h5>库存与状态</h5>
          <p><i>当前库存</i> <b style="color:#fff">${p.stock}</b> 件</p>
          <label class="sp-inline">到货 / 出库数量（负数为出库）<input class="ai-in" id="edDelta" type="number" placeholder="如 200 或 -5"></label>
          <label class="sp-inline">事由<input class="ai-in" id="edReason" placeholder="补货到仓 / 样品寄出"></label>
          <div class="sp-row" id="spOpsRow" style="margin-top:6px">
            <button class="ai-btn" data-act="stock" data-id="${p.id}" type="button">写库存流水</button>
            ${legalFor(p.status).map(t => `<button class="ai-btn ${t.to === 'online' ? 'pri' : ''}" data-act="st" data-id="${p.id}" data-action="${t.action}" type="button">${esc(t.label)}</button>`).join('')}
          </div>
          <p><i>状态机</i> 草稿 → 审核中 → 已上架 → 已下架；非法转换由后端拒绝（409）。${DB.hosted ? '这一版是只读快照，点状态按钮只会当场告诉你没写进去' : '每次转换写 products.status 并留一条 ai_ops'}；${esc(platNote(state.platInfo))}</p></div>
      </div>
      <div class="sp-row" style="margin:10px 0">
        <button class="ai-btn pri" data-act="opt" data-id="${p.id}" type="button">生成 AI 文案（标题 / 描述 / 卖点 / SEO / FAQ）</button>
        <span class="ai-note" style="margin:0">当前市场：${esc(cnName(state.iso))}（改左栏目标国家可换一版文案依据）</span>
      </div>
      <div id="spOpt">${state.optId === p.id && state.optHtml ? state.optHtml : '<div class="ai-hint">' + (DB.hosted ? '文案先生成后预览；这一版是只读快照，「写入这一行」不会真的改数据。' : '文案先生成后预览，确认无误再点「写入这一行」——写库的是你看到的这段文字。') + '</div>'}</div></div>`;
  }


  /* ---------- 各模块 ---------- */
  const NEED = q => `<div class="ai-hint">请先在左侧填写${q}，再点「运行 AI 分析」。</div>`;
  const RUNNERS = {
    dash: function () {
      return ai('storeAnalysis', {}).then(o => {
        if (o.error) return '<div class="ai-err">' + esc(o.error) + '</div>';
        state.series = o.series;
        const kpi = o.kpis.map(k => `
          <div class="sp-kpi"><span>${esc(k.k)}</span>
            <b>${esc(k.vText)}${k.u ? `<em>${esc(k.u)}</em>` : ''}${delta(k.d, k.u === '%' ? 'pp' : '%')}</b>
            <p>${esc(k.e)}</p>
            ${k.drill ? `<button class="ai-btn kpi-drill" data-act="orders" data-day="${esc(o.today.d)}" type="button">▸ 逐笔订单明细 · ${esc(o.today.d)} 共 ${o.today.ord} 笔</button>` : ''}</div>`).join('');
        const jump = a => {
          if (!a) return null;
          if (a === 'orders') return { tab: 'center' };
          if (a === 'service') return { tab: 'service' };
          if (a.indexOf('product:') === 0) return { tab: 'goods', prod: a.slice(8) };
          if (a.indexOf('plan:') === 0) return { tab: 'insight' };
          return { tab: a };
        };
        const finds = o.findings.map((f, i) => `
          <div class="sp-find ${esc(f.level)}">
            <div class="hd"><u>${f.icon}</u><b>${esc(f.t)}</b></div>
            <p>${esc(f.d)}</p>
            <div class="act"><button class="ai-btn" data-act="toggle" data-target="fd${i}" type="button">查看依据（${f.e.length} 条）</button>
              ${f.act ? (() => { const j = jump(f.act); return `<button class="ai-btn" data-act="nav" data-tab="${j.tab}" ${j.prod ? `data-prod="${esc(j.prod)}" ` : ''}type="button">去处理</button>`; })() : ''}</div>
            <div class="ai-evbox" id="fd${i}">${evHtml(f.e)}</div>
          </div>`).join('');
        const fun = o.funnel.map(x => `<div class="r"><i>${esc(x.k)}</i><div class="bar"><s style="width:${Math.max(3, x.v / o.today.vis * 100)}%"></s></div><b>${x.v}</b><em>${(x.v / o.today.vis * 100).toFixed(1)}%</em></div>`).join('');
        return head('AI 店铺总览 · ' + o.today.d, DB.hosted
          ? '访客到下单的每一个数字都取自发布时烘好的只读快照；公网这一版没有后端，改不了数据，所以下一次刷新也不会变。'
          : '访客到下单的每一个数字都取自本地数据库 data/app.db 的明细行；你在商品页与客服中心改过的东西，这里下一次刷新就会算进去。', ...provArgs(o, 'db'))
          + `<div class="sp-kpis">${kpi}</div>`
          + chartHost()
          + `<div class="ai-sub">AI 今日经营分析</div>
             <div class="sp-finds">${finds}</div>
             <div class="ai-sub">AI 建议</div>
             <div class="ai-cell"><ul>${o.advice.map(a => `<li><span>${esc(a)}</span></li>`).join('')}</ul></div>
             <div class="ai-sub">今日转化漏斗（口径：ord / vis 等，全部按明细算）</div>
             <div class="sp-funnel">${fun}</div>
             <div class="ai-note">${esc(o.notice)}</div>`;
      });
    },

    goods: function () {
      if (!window.DB || !DB.status().ok) return dbErr('商品管理');
      return Promise.all([DB.products({ limit: 500 }), DB.scan(),
        DB.platforms().catch(e => ({ error: DB.downMessage(e) }))]).then(rs => {
        const all = rs[0].items, scan = rs[1], plat = rs[2];
        state.platInfo = plat;
        state.goods = { rows: all, scan: scan };
        const f = state.filters, kw = f.keyword.toLowerCase();
        let rows = all.filter(p => (!f.cat || p.category === f.cat) && (!f.status || p.status === f.status) &&
          (!kw || [p.id, p.sku, p.name, p.name_en, p.category, (p.keywords || []).join(' ')].some(v => String(v || '').toLowerCase().indexOf(kw) >= 0)));
        const gmv = p => (p.price || 0) * (p.ord || 0);
        const rate = (a, b) => b - a;
        const CMP = {
          gmv: (a, b) => rate(gmv(a), gmv(b)), views: (a, b) => rate(a.views, b.views),
          cvr: (a, b) => rate(a.cvr, b.cvr), margin: (a, b) => rate(a.margin, b.margin),
          stock: (a, b) => (a.stock || 0) - (b.stock || 0)
        };
        rows = rows.slice().sort(CMP[f.sort] || CMP.gmv);
        if (!state.prodId || !all.some(p => p.id === state.prodId)) state.prodId = (rows[0] || {}).id || null;
        const cats = [];
        all.forEach(p => { if (p.category && cats.indexOf(p.category) < 0) cats.push(p.category); });
        const diagOf = id => (scan.items || []).filter(x => x.product_id === id);
        const rowsHtml = rows.map(p => {
          const dg = diagOf(p.id);
          return `
          <tr data-act="prod" data-id="${p.id}" class="${p.id === state.prodId ? 'on' : ''}">
            <td><span class="sp-name">${esc(p.name)}</span><span class="sp-en">${esc(p.name_en || '（无英文标题）') + ' · ' + p.id}</span></td>
            <td>${esc(p.category || '—')}</td>
            <td>${stage(ST_CN[p.status] || p.status)}</td>
            <td class="num">${p.price}</td>
            <td class="num">${p.margin == null ? '—' : p.margin + '%'}</td>
            <td class="num ${p.stock === 0 ? 'sp-warn' : p.stock < 50 ? '' : 'sp-ok'}">${p.stock}</td>
            <td class="num">${p.views}</td>
            <td class="num">${p.views ? ((p.cart / p.views) * 100).toFixed(1) : '0'}%</td>
            <td class="num">${p.cvr == null ? '—' : p.cvr + '%'}</td>
            <td class="why">${dg.length ? dg.slice(0, 3).map(x => `<button class="sp-chip" data-act="tidy" data-rule="${x.rule}" data-prod="${p.id}" type="button">${esc(x.rule_label)}</button>`).join('')
              + (dg.length > 3 ? `<i class="sp-en"> 等 ${dg.length} 项</i>` : '') : '<span class="sp-ok">未发现问题</span>'}</td>
            <td class="ops">${legalFor(p.status).map(t => `<button class="ai-btn xs" data-act="st" data-id="${p.id}" data-action="${t.action}" type="button">${esc(t.label)}</button>`).join('')}
              <button class="ai-btn xs" data-act="edit" data-id="${p.id}" type="button">编辑</button></td>
          </tr>`;
        }).join('');
        const tools = `<div class="sp-tools">
            <input class="ai-in" id="spKw" placeholder="搜索商品 / 关键词" value="${esc(f.keyword)}">
            <select class="ai-se" id="spCat"><option value="">全部品类</option>${cats.map(c => `<option ${c === f.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
            <select class="ai-se" id="spSt"><option value="">全部状态</option>${Object.keys(ST_CN).map(s => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${ST_CN[s]}</option>`).join('')}</select>
            <select class="ai-se" id="spSort">${[['gmv', '按销售额'], ['views', '按浏览量'], ['cvr', '按转化率'], ['margin', '按毛利'], ['stock', '按库存升序']].map(s => `<option value="${s[0]}" ${s[0] === f.sort ? 'selected' : ''}>${s[1]}</option>`).join('')}</select>
            <button class="ai-btn pri" data-act="tidy" data-rule="" type="button">AI 整理店铺（可自动修 ${scan.fixable} 项）</button>
            <button class="ai-btn" data-act="gen" type="button">AI 上架商品</button>
            <span class="sp-row" style="margin-left:auto">${rows.length} / ${all.length} 个 SKU ｜ 合计销售额 ${(all.reduce((a, b) => a + (b.price || 0) * (b.ord || 0), 0)).toLocaleString('en-US')} 美元 ｜ 待人工确认 ${scan.needs_human} 项</span>
          </div>`;
        const sel = all.filter(p => p.id === state.prodId)[0];
        return head('AI 商品管理 · ' + all.length + ' 个 SKU',
          (DB.hosted
            /* 部署版对公网访客绝不能宣称「写进去刷新后还在」：这句必须换成实话 */
            ? '这张表读的是发布时烘好的只读快照：' + esc(String((DB.status().info || {}).file || ''))
              + '。快照写不进——编辑、补货、上下架点下去只会说明「部署版没有后端」，不会伪装成已保存；'
              + platHalf(plat) + '，这一版什么都不会改动。'
            : '这张表读的是本地数据库：' + esc(String((DB.status().info || {}).file || '')).split('/').pop()
              + '。编辑、补货、上下架都会真的写库，刷新后还在；' + platHalf(plat) + '，改的只是本地档案。'), 'db')
          + tools
          + platPanel(plat)
          + tidyPanel(scan)
          + genPanel()
          + (sel ? detailPanel(sel) : '<div class="ai-hint">该筛选下没有商品。</div>')
          + `<div style="overflow-x:auto"><table class="ai-table"><thead><tr>
               <th>商品</th><th>分类</th><th>状态</th><th>价格 USD</th><th>毛利</th><th>库存</th><th>浏览</th><th>加购率</th><th>转化率</th><th>AI 诊断</th><th>操作</th>
             </tr></thead><tbody>${rowsHtml || '<tr><td colspan="11">无匹配记录</td></tr>'}</tbody></table></div>`
          + `<div class="ai-note">${esc(scan.notice)}</div>`;
      });
    },

    service: function () {
      if (!window.DB || !DB.status().ok) return dbErr('AI 客服中心');
      return DB.chats().then(l => {
        const rows = l.items;
        if (!rows.length) return '<div class="ai-hint">本地库里还没有客户与会话记录：先执行 <code>node tools/seed.mjs</code>。</div>';
        /* 别的页面传过来的是会话号（C-10232），客服中心一律按客户号定位 */
        const key = state.chatId || state.cs.cust;
        const hit = rows.filter(r => r.id === key || r.conv_id === key)[0] || rows[0];
        if (hit.id !== state.cs.cust) state.cs = { cust: hit.id, conv: hit.conv_id, text: null, edit: false, say: '', del: null, kbOpen: state.cs.kbOpen, kbQ: '' };
        state.chatId = hit.id;
        return Promise.all([
          DB.thread(hit.id),
          DB.csDraft(hit.id).catch(e => ({ error: DB.downMessage(e) })),
          state.cs.kbOpen ? DB.kb({ q: state.cs.kbQ }) : Promise.resolve(null),
          DB.followups().catch(e => ({ error: DB.downMessage(e) })),
          DB.chatDemo(hit.id).catch(e => ({ error: DB.downMessage(e), turns: [], skipped: [], demo_turns: 0, demo_messages: [] }))
        ]).then(rs => serviceView(rows, rs[0], rs[1], rs[2], rs[3], rs[4]));
      });
    },
    insight: function () {
      return ai('customerInsight', {}).then(all => {
        const items = all.items;
        if (!items.length) return '<div class="ai-hint">没有客户记录。</div>';
        if (!state.insightCust || !items.some(c => c.cust === state.insightCust)) state.insightCust = items[0].cust;
        const one = items.filter(c => c.cust === state.insightCust)[0];
        return ai('customerBehavior', { cust: one.cust }).then(b => {
          const chips = items.map(c => `<button class="ai-btn ${c.cust === one.cust ? 'pri' : ''}" data-act="ins" data-cust="${esc(c.cust)}" type="button">${esc(c.name)} · 意向 ${c.buy}</button>`).join('');
          const evt = b.items.map(e => `<li><time>${esc(e.at)}</time><span class="a">${esc(e.label)}</span><span class="o">${e.pid ? esc(e.pid) : ''}${e.sec ? '停留 <em>' + e.sec + ' 秒</em>' : ''}</span></li>`).join('');
          /* W04 只读左侧这份事件流做判断，所以分数与本地公式并列展示，不一致时以可回溯的公式值为准 */
          const mm = b.model;
          const modelCard = mm ? `<div class="ai-sub" style="margin:12px 0 6px">模型研判 · 读上面 ${b.items.length} 条事件</div>
            <dl class="sp-score">
              <dt>兴趣程度</dt><dd><b>${esc(mm.interest)}</b>${scoreBar(+mm.interest || 0)}<i class="sp-vs">本地公式 ${esc(mm.localInterest)}</i></dd>
              <dt>购买意向</dt><dd><b>${esc(mm.buy)}</b>${scoreBar(+mm.buy || 0, +mm.buy >= 62)}<i class="sp-vs">本地公式 ${esc(mm.localBuy)}</i></dd>
              <dt>客户阶段</dt><dd>${esc(mm.stage || '—')}</dd>
              <dt>关注商品</dt><dd>${esc(mm.favorite || '—')}</dd>
              <dt>价格敏感度</dt><dd>${esc(mm.priceSens || '—')}</dd>
              <dt>建议动作</dt><dd>${esc(mm.action || '—')}</dd>
            </dl>
            <div class="ai-note">以上 6 行来自 ${esc(mm.src)}（${mm.ms}ms），属模型判断、不可回溯；黑字分数按公开公式算出：${esc(mm.formula)}。两者不一致时以公式值为准。</div>` : '';
          return head('客户洞察 · ' + one.name + '（Customer #' + one.cust + '）',
            '行为事件与会话取自' + DBN + ' events / messages 行；兴趣度 / 购买意向 / 阶段 / 价格敏感度由这些明细按下式算出，可逐条回溯。', ...provArgs(b, 'db'))
            + `<div class="ai-chips" style="margin-bottom:12px">${chips}</div>
               <div class="sp-in2"><div class="L">
                 <div class="ai-sub" style="margin:0 0 8px">行为事件流（${b.items.length} 条）</div>
                 <ul class="sp-evt">${evt}</ul>
                 ${modelCard}
               </div><div class="R">
                 <div class="ai-det"><h4>AI 客户分析<em>${esc(one.countryCn)} · ${esc(one.city)} · ${esc(one.channel || '')}</em></h4>
                   <dl class="sp-score">
                     <dt>兴趣程度</dt><dd><b>${one.interest}</b>${scoreBar(one.interest)} <span class="ai-note" style="margin:0">0-99</span></dd>
                     <dt>购买意向</dt><dd><b>${one.buy}</b>${scoreBar(one.buy, one.buy >= 62)} <span class="ai-note" style="margin:0">${one.buy >= 62 ? '高意向，建议今日跟进' : one.buy >= 38 ? '评估中，需要参数与保障支撑' : '初步了解，先给场景内容'}</span></dd>
                     <dt>客户阶段</dt><dd>${esc(one.stage)}</dd>
                     <dt>价格敏感度</dt><dd>${esc(one.priceSens)}（${one.priceSensShare}% 的消息在问价格）</dd>
                     <dt>累计停留</dt><dd>${esc(one.dwellText)}</dd>
                   </dl>
                   <div class="ai-sub">关注商品</div>
                   <table class="ai-table"><tbody>${one.focus.map(f => `<tr><td>${esc(f.name)} <span class="sp-en">${f.id}</span></td><td class="num">浏览 ${f.hits} 次</td><td class="num">$${f.price}</td></tr>`).join('') || '<tr><td>无商品浏览记录</td></tr>'}</tbody></table>
                   <div class="ai-sub">咨询话题分布</div>
                   <div class="sp-tags">${one.topics.map(t => `<span class="ai-pill">${esc(t.k)} ${t.n} 次 · ${t.share}%</span>`).join('') || '—'}</div>
                   ${evHtml(one.evidence, '分析依据')}
                   <div class="ai-note">公式：${esc(one.formula)}</div>
                   <div class="sp-row" style="margin-top:10px">
                     <button class="ai-btn pri" data-act="chat" data-id="${esc(one.id)}" type="button">去客服中心回复</button>
                     <button class="ai-btn" data-act="nav" data-tab="fit" type="button">看这个市场的适配报告</button>
                   </div>
                 </div>
               </div></div>`;
        });
      });
    },

    fit: function () {
      readInputs();
      if (!state.product && !state.query) return Promise.resolve(NEED('产品（例如「真无线降噪耳机」）'));
      return ai('marketFit', {
        product: state.product, iso: state.iso, audience: state.audience, query: state.query
      }).then(r => {
        if (r.error) return '<div class="ai-err">' + esc(r.error) + '</div>';
        const cells = r.sections.map((s, i) => `
          <div class="ai-cell ${i >= r.sections.length - 2 ? 'wide' : ''}">
            <span>${esc(s.t)}</span><b>${esc(s.v)}</b><p>${esc(s.d)}</p>
            ${s.e && s.e.length ? `<button class="ai-btn" style="margin-top:7px" data-act="toggle" data-target="ft${i}" type="button">分析依据</button>
              <div class="ai-evbox" id="ft${i}">${evHtml(s.e)}${s.formula ? `<div class="ai-note">算式：${esc(s.formula)}</div>` : ''}</div>` : ''}
          </div>`).join('');
        const lastSec = r.sections[r.sections.length - 1];
        const pb = provArgs(r, r.src);
        if (pb[0] === 'live') pb[1] = '数据层 + ' + pb[1];
        return head('AI 市场适配报告 · ' + esc(r.product || '') + ' → ' + esc(r.country),
          '宏观口径来自世界银行，品类结构来自数据层；人群 / 成本 / 认证为人工输入，缺项直接标出来而不是猜。', ...pb)
          + `<div class="ai-hint">解析品类：${esc((r.cats || []).join('、') || '未识别，按整体市场口径')} ｜ 人群：${esc(r.audience || '未填写')}</div>
             <div class="ai-grid sp-fit">${cells}</div>
             <div class="sp-verdict">${esc(lastSec.verdict || '')}</div>
             <div class="ai-note warn">${esc(r.notice)}</div>
             <div class="ai-chips" style="margin-top:12px">
               <button class="ai-btn" data-act="nav" data-tab="goods" type="button">据此优化商品文案</button>
               <button class="ai-btn" data-act="nav" data-tab="service" type="button">看这个市场的客户在问什么</button>
             </div>`;
      });
    },

    center: function () {
      return Promise.all([
        ai('storeAnalysis', {}), ai('dailyPlan', {}),
        ai('orderAnalysis', { day: state.ordDay || '', status: state.ordStatus || '' }),
        ai('customerInsight', {}), DS.products({ sort: 'risk' })
      ]).then(r => {
        const o = r[0], ap = r[1], oa = r[2], ci = r[3], ps = r[4];
        state.series = o.series;
        /* 订单明细的日期下拉：候选与笔数都取 store_daily 那 30 行（不写死一个天数） */
        state.ordDays = o.series.x.map((d, i) => ({ d: d, ord: o.series.ord[i] })).reverse();
        const plan = ap.plan.map((p, i) => `
          <li><time>${esc(p.time)}</time><div class="bd"><b>${esc(p.act)}</b><p>${esc(p.why)}</p>
            <button class="ai-btn" style="margin-top:5px;font-size:14px;padding:2px 9px" data-act="toggle" data-target="pl${i}" type="button">依据</button>
            <div class="ai-evbox" id="pl${i}">${evHtml(p.e)}</div></div>
            <span class="tg"><span class="ai-pill y">${esc(p.tag)}</span></span></li>`).join('');
        const hot = ci.items.filter(x => x.buy >= 38).sort((a, b) => b.buy - a.buy).slice(0, 5);
        const needOpt = ps.items.slice(0, 4);
        /* 卡片名带的是数据日期（09-21 访客），所以按词尾匹配，别再把日期写死在这里 */
        const flow = o.kpis.filter(k => /(访客|订单|销售额|转化率)$/.test(k.k)).map(k =>
          `<div class="r"><i>${esc(k.k)}</i><div class="bar"><s style="width:${Math.min(100, Math.abs(k.d) * 4 + 8)}%"></s></div><b>${esc(k.vText)}${k.u === '美元' ? '' : ''}</b><em>${delta(k.d, k.u === '%' ? 'pp' : '%')}</em></div>`).join('');
        return head('AI 经营中心 · ' + o.today.d,
          (DB.hosted
            ? '今日重点、待优化商品、待跟进客户、客服问题、转化与流量变化，全部汇总自发布时烘好的只读快照明细行；这一版没有后端，时间按优先级推导，不是固定模板。'
            : '今日重点、待优化商品、待跟进客户、客服问题、转化与流量变化，全部汇总自本地数据库的明细行；时间按优先级推导，不是固定模板。'), ...provArgs(ap, 'db'))
          + `<div class="ai-sub">AI 今日行动计划</div>
             <ul class="sp-plan">${plan}</ul>
             <div class="ai-note">${esc(ap.notice)}</div>
             <div class="ai-sub">需要优化的商品（按转化下滑排序）</div>
             <table class="ai-table"><thead><tr><th>商品</th><th>浏览</th><th>今日转化</th><th>前 6 日转化</th><th>AI 判断</th><th></th></tr></thead><tbody>
             ${needOpt.map(p => `<tr><td><span class="sp-name">${esc(p.name)}</span><span class="sp-en">${p.id}</span></td>
               <td class="num">${p.views}</td><td class="num">${p.cvrToday}%</td><td class="num">${p.cvrPrev}%</td>
               <td class="why">${esc(p.issues[0] || '页面参数完整，先看主图与价格锚点')}</td>
               <td><button class="ai-btn" data-act="nav" data-tab="goods" data-prod="${p.id}" type="button">去优化</button></td></tr>`).join('')}
             </tbody></table>
             <div class="ai-sub">需要跟进的客户（会话 + 行为综合意向）</div>
             <table class="ai-table"><thead><tr><th>客户</th><th>国家</th><th>意向</th><th>阶段</th><th>AI 建议</th><th></th></tr></thead><tbody>
             ${hot.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.countryCn)}</td>
               <td class="num">${c.buy}</td><td>${esc(c.stage)}</td>
               <td class="why">${c.buy >= 62 ? '今日催单，先锁库存再谈价' : '补参数与保障说明，别急着报价'}</td>
               <td><button class="ai-btn" data-act="chat" data-id="${c.id}" type="button">去回复</button></td></tr>`).join('') || '<tr><td colspan="6">暂无中高意向客户</td></tr>'}
             </tbody></table>
             <div class="ai-sub">客服问题 → 页面改动</div>
             <div class="ai-grid" style="grid-template-columns:repeat(2,1fr)">
               <div class="ai-cell"><span>今日客服话题</span><ul>
                 ${ci.items.reduce((acc, c) => { c.topics.forEach(t => { const k = acc.find(x => x.k === t.k); if (k) k.n += t.n; else acc.push({ k: t.k, n: t.n }); }); return acc; }, [])
                   .sort((a, b) => b.n - a.n).slice(0, 5).map(t => `<li><span>${esc(t.k)}</span><b style="min-width:40px;text-align:right">${t.n} 条</b></li>`).join('')}</ul></div>
               <div class="ai-cell"><span>商品出单（${esc(oa.today.d)} 这一天）</span><ul>
                 ${oa.byProduct.slice(0, 4).map(p => `<li><span>${esc(p.name)} 出 ${p.n} 笔 · 占当日销售额 ${p.contribution}%（转化率 ${p.cvr}% · 库存 ${p.stock}）</span></li>`).join('') || '<li><span>这一天没有订单行</span></li>'}</ul></div>
             </div>
             <div class="ai-sub">流量与销售变化</div>
             <div class="sp-funnel">${flow}</div>
             ${chartHost()}
             ${ordSection(oa, ci)}
             <div class="ai-note">${esc(oa.notice || '')}</div>
             <div class="ai-note">${esc(o.notice)}</div>`;
      });
    }
  };

  /* ---------- 订单明细 ----------
     库里几百笔（一天 30 笔 × 30 天），一次全渲染既没意义又卡页面，所以这一节默认只展开一天：
     日期与状态都是真查询参数（走 /api/db/orders?day=&status=），表头那行合计由数据库算，
     并与 store_daily 同一行对着报——对不上就当场说对不上。 */
  function ordSection(oa, ci) {
    if (!oa || oa.error) return '<div class="ai-sub">订单明细</div><div class="ai-err">' + esc((oa || {}).error || '订单分析没有返回') + '</div>';
    const t = oa.today, rows = oa.orders || [];
    const names = {};
    ((ci || {}).items || []).forEach(c => { names[c.cust || c.id] = c.name; });
    const days = (state.ordDays || []).slice();
    const opts = days.map(x => `<option value="${esc(x.d)}"${x.d === t.d ? ' selected' : ''}>${esc(x.d)} · ${x.ord} 笔</option>`).join('');
    const sts = ['全部状态'].concat(['已下单', '待发货', '已发货', '已完成', '退款中']);
    const sumTxt = 'USD ' + Number(oa.orderSum || 0).toFixed(2);
    const same = oa.status ? '已按「' + oa.status + '」筛 · 合计只算筛出来的这些（不与日报对齐）'
      : oa.match
        ? '与 store_daily[' + t.d + '] 一字不差（日报 ' + t.ord + ' 笔 / ' + t.rev + '）'
        : '与 store_daily[' + t.d + '] 不一致（日报 ' + t.ord + ' 笔 / ' + t.rev + '）· 以逐笔明细为准';
    return `<div class="ai-sub" id="ordSec">订单明细（${DBN} orders 表 · 逐笔）
              <select class="ai-se" id="ordDay" style="width:150px;height:28px;margin-left:8px">${opts}</select>
              <select class="ai-se" id="ordStatus" style="width:120px;height:28px;margin-left:6px">
                ${sts.map(s => `<option value="${esc(s)}"${s === (state.ordStatus || '全部状态') ? ' selected' : ''}>${esc(s)}</option>`).join('')}
              </select>
            </div>
            <div class="ai-note" style="margin:0 0 6px">这一天 <b>${oa.orderTotal}</b> 笔 · 合计 <b>${esc(sumTxt)}</b> · ${esc(same)}${rows.length < oa.orderTotal ? ' · 本页只列前 ' + rows.length + ' 笔' : ''}</div>
            <table class="ai-table"><thead><tr><th>订单</th><th>时间</th><th>商品</th><th>数量</th><th>单价</th><th>金额 USD</th><th>状态</th><th>买家</th></tr></thead><tbody>
            ${rows.map(x => `<tr><td>${esc(x.id)}</td><td>${esc(x.at)}</td><td>${esc(x.pid)}</td><td class="num">${x.qty}</td>
              <td class="num">${esc(x.unit_price)}</td><td class="num">${esc(x.amount)}</td>
              <td>${stage(x.status)}</td>
              <td>${x.cust ? esc(names[x.cust] || x.cust) : '<span class="why">未咨询直接下单</span>'}</td></tr>`).join('')
              || '<tr><td colspan="8">这个条件下库里没有订单行</td></tr>'}
            </tbody></table>`;
  }

  /* ---------- AI 商品文案：生成预览 → 由人确认后才写库 ---------- */
  function optPanel(id) {
    const row = (state.goods.rows || []).filter(p => p.id === id)[0];
    if (!row) return Promise.resolve(null);
    $('spOpt').innerHTML = '<div class="ai-loading">正在按商品参数与目标市场生成文案…</div>';
    return ai('productGenerator', { id: id, iso: state.iso, product: row }).then(o => {
      if (o.error) { $('spOpt').innerHTML = '<div class="ai-err">' + esc(o.error) + '</div>'; return ''; }
      state.copy = { payload: copyPayload(o), src: o.__m || null };
      const L = ['zh', 'en', 'es', 'de', 'ja'], LN = { zh: '中文', en: 'English', es: 'Español', de: 'Deutsch', ja: '日本語' };
      const html = `<div class="sp-ai">
        <h4>AI 优化方案<em>${esc(o.id)} · 目标市场 ${esc(cnName(state.iso))}${esc(liveTag(o))}</em></h4>
        <div class="sp-lang">${L.map(l => `<button class="${l === state.lang ? 'on' : ''}" data-act="lang" data-lang="${l}" type="button">${LN[l]}</button>`).join('')}
          <button class="ai-btn" data-act="copy" data-src="spAiTitle" type="button">复制标题</button></div>
        <div class="sp-cols">
          <div class="c" style="grid-column:span 3"><h5>标题（建议替换现标题）</h5><p id="spAiTitle" style="font-size:17px;color:#fff">${esc(o.title[state.lang])}</p>
            <i>现标题：${esc(o.name)}</i></div>
          <div class="c" style="grid-column:span 3"><h5>商品描述</h5><p>${esc(o.description[state.lang])}</p></div>
          <div class="c"><h5>卖点</h5><ol>${o.bullets.map(b => `<li>${esc(b[state.lang] || b.en)}</li>`).join('')}${(o.modelBullets || []).map(s => `<li><i class="sp-model-tag">模型</i>${esc(s)}</li>`).join('')}</ol>
            ${(o.modelBullets || []).length ? '<i>带「模型」标记的是英文前台版，未做平台合规校验</i>' : ''}</div>
          <div class="c"><h5>FAQ</h5><ul>${o.faq.map(f => `<li>${esc(f.q)}<br><i>${esc(f.a)}</i></li>`).join('')}</ul>
            <i>FAQ 按买家前台语言（英文）给，不随上方文案语言切换</i></div>
          <div class="c"><h5>SEO 关键词 / 标签</h5>
            <p><i>已有：</i>${o.seo.existing.map(k => `<span class="ai-pill">${esc(k)}</span>`).join('')}</p>
            <p><i>AI 建议新增：</i>${o.seo.added.map(k => `<span class="ai-pill y">${esc(k)}</span>`).join('')}</p>
            <div class="sp-tags">${o.tags.map(t => `<span class="ai-pill g">${esc(t)}</span>`).join('')}</div></div>
          <div class="c"><h5>详情页待补</h5><ul>${o.todo.map(t => `<li><span class="sp-warn" style="color:#ff9b8a">${esc(t)}</span></li>`).join('') || '<li>未登记缺口</li>'}</ul>
            <p><i>定价：</i>现售 $${o.priceHint.current}，成本 $${o.priceHint.cost}，毛利 ${o.priceHint.margin}%</p></div>
        </div>
        ${evHtml(o.evidence, '这份文案用到了哪些数据')}
        ${o.notices.map(n => `<div class="ai-note warn">${esc(n)}</div>`).join('')}
        <div class="ai-note">${esc(o.seo.note)}</div>
        <div class="ai-note">${esc(o.priceHint.note)}</div>
        <div class="sp-row" style="margin-top:10px">
          <button class="ai-btn pri" data-act="apply-copy" data-id="${esc(o.id)}" type="button">写入这一行（英文标题 / 描述 / 关键词 / FAQ）</button>
          <span class="ai-note" style="margin:0">${(o.__m && o.__m.src) === 'live' ? '这段是模型产出，写入会在 ai_ops 里标 live=true，需人工复核' : '这段由本地规则拼装，写入同样留痕'}</span>
        </div>
      </div>`;
      state.optId = id;
      state.optHtml = html;
      $('spOpt').innerHTML = html;
      return '';
    });
  }

  /* ---------- AI 生成商品 ---------- */
  /* ---------- 商品页写操作：每个动作都落库，并把接口返回的行号显示出来 ---------- */
  /* 按下与抬起之间哪怕只换一次 DOM，click 也只会发到共同祖先，委托找不到 [data-act]，这一下静默丢失。
     所以按住期间的重画与回执先记账，抬起后补——用户看到的按钮始终是他按下的那一个。
     这里声明、不在演示那一节声明：toast() 从头到尾都会被调用，读到还没初始化的 let 会直接 ReferenceError。 */
  let holding = false, holdRedraw = false, holdToast = null;
  /* 回执必须当场出现在屏幕上：run() 在 state.busy（上一次请求还在路上）时会把整段重绘推迟，
     只把话存进 state.toast 就等于用户点下去一个字都没变——「再点 ▶ 完全没反应」就是这么来的。
     paint() 之后仍会按 state.toast 重建这条，所以这里只是抢在重绘之前先答一声。
     但按住的那一下绝不能再动 DOM：改高度会把按钮从指针下面挪走，mousedown/mouseup 落在不同节点上
     click 只会发到共同祖先，委托找不到 [data-act]，这一下又被静静吃回去。 */
  function toast(msg) {
    state.toast = msg;
    const body = $('spBody');
    if (!body || !msg) return;
    if (holding) { holdToast = msg; return; }
    const t = mountToast();
    if (t && t.scrollIntoView) { try { t.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老内核不支持选项 */ } }
  }
  function done(p, fmt) {
    return p.then(r => { toast(fmt(r)); run(true); return r; })
      .catch(e => { toast('未写入：' + DB.downMessage(e)); run(true); });
  }
  function val(id) { const el = $(id); return el ? el.value.trim() : ''; }
  const numOrNull = s => (s === '' || s == null ? null : Number(s));

  /* 生成的英文文案 → 接口认识的字段名 */
  function copyPayload(o) {
    const kw = (o.seo.existing || []).concat(o.seo.added || []).slice(0, 8);
    return {
      name_en: o.title.en, description_en: o.description.en, keywords: kw, faq: o.faq,
      iso: state.iso, lang: 'en', evidence: o.evidence || [],
      model: (o.__m && (o.__m.workflow || o.__m.model)) || 'js/shop.js 本地引擎',
      live: !!(o.__m && o.__m.src === 'live')
    };
  }
  function applyCopy(id) {
    if (!state.copy) { toast('先生成文案再写入'); run(true); return; }
    return done(DB.applyCopy(id, state.copy.payload), r =>
      '已写入 products.' + id + '：' + (r.diff || []).map(x => x.f).join('、') + ' · 记录 ai_ops #' + r.op.id);
  }

  function genOpen() {
    readInputs();
    state.gen = { open: true, draft: null, form: { name: state.product, info: state.query, audience: state.audience, iso: state.iso }, missing: [], evidence: [], notices: [] };
    run(true);
  }
  function genRun(el) {
    const f = state.gen.form;
    f.name = val('gnName'); f.info = val('gnInfo'); f.cost = val('gnCost');
    f.stock = val('gnStock'); f.audience = val('gnAudience'); f.image = val('gnImage'); f.iso = val('gnIso') || state.iso;
    if (!f.name) { state.gen.error = '请至少填写产品名称——AI 只整理你给的资料，不会凭空造出一个商品'; run(true); return; }
    el.disabled = true;
    return DB.draftProduct({ name: f.name, info: f.info, audience: f.audience, cost: numOrNull(f.cost), stock: numOrNull(f.stock), image: f.image, target_country: f.iso })
      .then(g => {
        state.gen.draft = g.draft; state.gen.evidence = g.evidence; state.gen.formula = g.formula;
        state.gen.missing = g.missing; state.gen.notices = g.notices; state.gen.error = '';
        state.gen.liveTag = '';
        state.gen.note = '';
        run(true);
      }).catch(e => { state.gen.error = DB.downMessage(e); run(true); })
      .then(() => { el.disabled = false; });
  }
  function genSave(publish, thenOpt) {
    const g = state.gen, d = g.draft, f = g.form;
    const price = numOrNull(val('gdPrice'));
    const nameEn = val('gdNameEn');
    const payload = {
      name: d.name, name_en: nameEn || null, category: d.category, target_country: d.target_country,
      audience: d.audience, price: price, cost: d.cost, stock: d.stock, description: d.description,
      description_en: d.description_en, attrs: d.specs, keywords: d.keywords, tags: d.tags,
      faq: d.faq, langs: d.langs, image: d.image || undefined, source: 'AI 上架指令'
    };
    let p = DB.createProduct(payload);
    if (publish) p = p.then(r => DB.productStatus(r.product.id, 'publish').then(s => Object.assign(r, { published: s })));
    return done(p, r => {
      const id = r.product.id;
      state.prodId = id; state.gen.open = false; state.gen.draft = null;
      if (thenOpt) afterRender(() => optPanel(id));
      return '已写入 products.' + id + '（' + r.product.status_cn + '）· 图片/编号已存本地库'
        + (r.published ? ' → ' + r.published.label + '（跳过审核，记录 ai_ops #' + r.published.op_id + '）' : '')
        + (r.published && r.published.platform_sync ? ' · 已询问 ' + r.published.platform_sync.queried
            + ' 个平台适配器，' + r.published.platform_sync.synced + ' 个同步' : '')
        + (thenOpt ? '｜文案在下面，确认后点「写入这一行」才落库' : '')
        + '｜' + platNote(state.platInfo);
    });
  }

  function editSave(id) {
    const patch = { name_en: val('edNameEn') || null, price: numOrNull(val('edPrice')), cost: numOrNull(val('edCost')), category: val('edCat') || null };
    Object.keys(patch).forEach(k => { if (patch[k] === null || patch[k] === '' || Number.isNaN(patch[k])) delete patch[k]; });
    if (!Object.keys(patch).length) { toast('没有需要保存的改动'); run(true); return; }
    return done(DB.patchProduct(id, patch), r => '已保存 products.' + id + '：' + (r.diff || []).map(x => x.f).join('、')
      + (r.kb ? '（知识库商品档案已同步）' : ''));
  }
  function stockMove(id) {
    const delta = numOrNull(val('edDelta'));
    if (!delta) { toast('请填写到货或出库数量'); run(true); return; }
    return done(DB.productStock(id, delta, val('edReason') || '人工调整'), r =>
      '库存已写库：products.' + id + ' ' + r.from + ' → ' + r.to + ' 件（记入 stock_movements 流水，知识库档案同步）');
  }
  function statusMove(id, action) {
    return done(DB.productStatus(id, action), r => {
      const ps = r.platform_sync;
      return '状态已写库：products.' + id + ' '
        + (ST_CN[r.from] || r.from) + ' → ' + (ST_CN[r.to] || r.to) + '（' + r.label + '）· 记录 ai_ops #' + r.op_id
        + (ps ? ' · 已询问 ' + ps.queried + ' 个平台适配器，' + ps.synced + ' 个同步、' + ps.refused + ' 个返回未连接'
               : ' · 本动作不涉及平台同步');
    });
  }
  function tidyApply(scope, rule) {
    const scan = state.goods.scan;
    const ids = scan.items.filter(f => f.auto && (!rule || f.rule === rule)).map(f => f.id);
    if (!ids.length) { toast('这一类没有可自动修改的项——需要人工确认的会留在列表里'); run(true); return; }
    return done(DB.tidy(ids), r => 'AI 一键整理完成：改 ' + r.applied.length + ' 项'
      + (r.skipped.length ? '，跳过 ' + r.skipped.length + ' 项（行已被改动）' : '')
      + ' · 记录 ai_ops #' + r.op.id + ' · 剩余 ' + r.result.total + ' 项（其中可自动修 ' + r.result.fixable + '）');
  }

  /* 重画商品行后才能拿到详情面板里的节点（面板由 run 异步生成） */
  function afterRender(then, focusId) {
    delete state.cache.goods;
    run(true);
    const t0 = Date.now();
    (function poll() {
      const el = focusId ? $(focusId) : $('spOpt');
      if (el) {
        if (focusId) { el.scrollIntoView({ block: 'center' }); el.focus(); }
        if (then) then();
        return;
      }
      if (Date.now() - t0 < 4000) setTimeout(poll, 200);
    })();
  }

  /* ---------- 交互 ---------- */
  function bindBody() {
    const body = $('spBody');
    body.onclick = e => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const d = el.dataset, act = d.act;
      const stop = () => e.preventDefault();
      if (act === 'toggle') {
        const box = $(d.target);
        if (box) box.classList.toggle('on');
      } else if (act === 'nav') {
        state.cache = {};
        openTab(d.tab, d.prod ? { prodId: d.prod } : null);
      } else if (act === 'page') {
        saveCtx();
        SHELL.goto(d.page, d.tab ? { tab: d.tab } : null);
      } else if (act === 'prod') {
        /* 再点已经站着的那件商品：重算出来一字不差，DOM 一点不变，这一下看着就是死的。
           界面必须自己说出口（dead-click 实测：421 个入口里只有它是零反应）。 */
        if (state.prodId === d.id && state.tab === 'goods') { toast('这件已经在看了 · 要换一件点列表里别的那一行'); return; }
        /* 换件是真换了：上一条「这件已经在看了」必须跟着擦掉，否则 paint() 会照 state.toast 把它重建一遍，
           界面就在对着一件新商品说假话。 */
        stop(); state.toast = ''; state.prodId = d.id; state.optId = null; state.optHtml = ''; state.copy = null; run(true);
      } else if (act === 'opt') {
        stop(); optPanel(d.id);
      } else if (act === 'apply-copy') {
        stop(); applyCopy(d.id);
      } else if (act === 'gen') {
        stop(); if (state.tab !== 'goods') { openTab('goods'); } genOpen();
      } else if (act === 'gen-run') {
        stop(); genRun(el);
      } else if (act === 'gen-save') {
        stop(); genSave(false);
      } else if (act === 'gen-opt') {
        stop(); genSave(false, true);
      } else if (act === 'gen-publish') {
        stop(); genSave(true);
      } else if (act === 'gen-close') {
        stop(); state.gen.open = false; state.gen.draft = null; run(true);
      } else if (act === 'tidy') {
        stop();
        /* 同一项缺口再点一次：面板本来就停在这一组，DOM 一字不变，用户只会以为按钮坏了 */
        if (state.tidy.open && state.tidy.group === d.rule && (!d.prod || state.prodId === d.prod)) {
          toast('这一项的清单就在下面的整理面板 · 已经修过的不会再改');
        }
        state.tidy.open = true; if (d.rule) { state.tidy.group = d.rule; if (d.prod) state.prodId = d.prod; } run(true);
      } else if (act === 'tidy-group') {
        stop(); state.tidy.group = state.tidy.group === d.rule ? null : d.rule; run(true);
      } else if (act === 'tidy-apply') {
        stop(); tidyApply(d.scope, d.scope === 'rule' ? d.rule : null);
      } else if (act === 'tidy-scan') {
        stop(); delete state.cache.goods; run(true);
      } else if (act === 'plat-toggle') {
        stop(); state.plat = !state.plat; run(true);
      } else if (act === 'plat-recheck') {
        stop(); delete state.cache.goods; platRecheck();
      } else if (act === 'tidy-close') {
        stop(); state.tidy.open = false; state.tidy.group = null; run(true);
      } else if (act === 'edit') {
        stop(); state.prodId = d.id; afterRender(null, d.focus || 'edNameEn');
      } else if (act === 'edit-save') {
        stop(); editSave(d.id);
      } else if (act === 'stock') {
        stop(); stockMove(d.id);
      } else if (act === 'st') {
        stop(); statusMove(d.id, d.action);
      } else if (act === 'lang') {
        stop(); state.lang = d.lang;
        if (state.optId) optPanel(state.optId);
      } else if (act === 'chat') {
        stop(); state.chatId = d.id; delete state.cache.service;
        /* 打开会话就把未读清零：这是唯一一处「点一下就写库」，写在 toast 里说明白 */
        if (+d.unread > 0 && d.conv) DB.convUpdate(d.conv, { read: true }).catch(() => null);
        openTab('service', { chatId: d.id });
      } else if (act === 'fu-pick') {
        stop();
        /* 再点已经选中的那位：面板重算出来一字不差，界面必须把「为什么没变」说出口 */
        if (state.fu.pick === d.id) toast('这条草稿就在下面这块 · 点「改一改再发」可以编辑');
        state.fu.pick = d.id; state.fu.edit = false; state.fu.text = null; run(true);
      } else if (act === 'fu-edit') {
        stop();
        const ta = $('fuRep');
        if (ta) state.fu.text = ta.value;
        state.fu.edit = !state.fu.edit;
        run(true);
      } else if (act === 'fu-send') {
        stop(); fuSend(d.id);
      } else if (act === 'fu-send-edit') {
        stop();
        const ta = $('fuRep'), t = ta ? ta.value.trim() : '';
        if (!t) { toast('跟进内容为空——不发送空消息'); state.fu.edit = false; run(true); }
        else fuSend(d.id, t);
      } else if (act === 'cs-send') {
        stop(); state.cs.text = null; state.cs.edit = false; csSend(d.id);
      } else if (act === 'cs-send-edit') {
        stop();
        const ta = $('spRep'), t = ta ? ta.value.trim() : '';
        if (!t) { toast('回复内容为空——不发送空消息'); run(true); }
        else { state.cs.text = null; state.cs.edit = false; csSend(d.id, t); }
      } else if (act === 'cs-regen') {
        stop(); state.cs.text = null; state.cs.edit = false;
        /* 重算是确定性的：客户没发新消息时稿子一字不差，界面不把这次点击吞掉（死按钮扫描实测）。
           缓存交给 run(force) 自己清——它要先留住上一版稿子才比得出「没变」。 */
        rerunNote = true;
        run(true);
      } else if (act === 'cs-edit') {
        stop();
        const ta = $('spRep');
        if (ta) state.cs.text = ta.value;
        state.cs.edit = !state.cs.edit;
        run(true);
      } else if (act === 'cs-alt') {
        stop(); csAlt(+d.i);
      } else if (act === 'cs-human') {
        stop(); csHuman(d.id);
      } else if (act === 'cs-say') {
        stop(); csSay(d.id, d.conv);
      } else if (act === 'cs-demo') {
        stop();
        if (d.restart) demoRestart(d.id, +d.done || 0); else demoStart(d.id);
      } else if (act === 'cs-demo-stop') {
        stop(); demoStop('演示停在当前这轮 · 已写进库的消息不会偷偷删，要清空点「清空演示对话」');
      } else if (act === 'cs-demo-clear') {
        stop(); demoClearRun(d.id);
      } else if (act === 'msg-del') {
        stop(); state.cs.del = +d.id; run(true);
      } else if (act === 'msg-del-yes') {
        stop(); state.cs.del = null; csDel(+d.id);
      } else if (act === 'msg-del-no') {
        stop(); state.cs.del = null; run(true);
      } else if (act === 'kb') {
        stop(); state.cs.kbOpen = !state.cs.kbOpen; delete state.cache.service; run(true);
      } else if (act === 'fu-open') {
        stop(); state.fu.open = !state.fu.open; delete state.cache.service; run(true);
      } else if (act === 'kb-search') {
        stop(); state.cs.kbQ = (val('kbQ') || '').trim(); delete state.cache.service; run(true);
      } else if (act === 'kb-add') {
        stop(); kbAdd();
      } else if (act === 'orders') {
        /* KPI 上的「看逐笔」：切到经营中心，并把明细定位到这一天。
           回执不靠 toast（换 Tab 会被擦掉），由明细表头那行写清"哪一天、几笔、合计、与日报对不对得上"。 */
        stop();
        state.ordStatus = '';
        state.cache = {};
        openTab('center', { day: d.day });
      } else if (act === 'ins') {
        stop(); state.insightCust = d.cust; delete state.cache.insight;
        openTab('insight', { cust: d.cust });
      } else if (act === 'copy') {
        const src = $(d.src);
        if (src) copyText(src.innerText, el);
      }
    };
    const kw = $('spKw');
    if (kw) kw.oninput = debounce(() => { state.filters.keyword = kw.value.trim(); delete state.cache.goods; run(true); }, 420);
    [['spCat', 'cat'], ['spSt', 'status'], ['spSort', 'sort']].forEach(p => {
      const s = $(p[0]);
      if (s) s.onchange = () => { state.filters[p[1]] = s.value; delete state.cache.goods; run(true); };
    });
    /* 订单明细的日期与状态：都是真查询参数，改一个就重新查库（toast 在 run 之前设，才赶得上那一帧） */
    const od = $('ordDay'), os = $('ordStatus');
    if (od) od.onchange = () => {
      state.ordDay = od.value; delete state.cache.center;
      toast('订单明细已切到 ' + od.value + ' · 重新查了库');
      run(true);
    };
    if (os) os.onchange = () => {
      state.ordStatus = os.value === '全部状态' ? '' : os.value; delete state.cache.center;
      toast(state.ordStatus ? '订单明细只看「' + state.ordStatus + '」· 合计只算筛出来的这些' : '订单明细取消状态筛选 · 回到当天的全部逐笔');
      run(true);
    };
  }

  /* ---------- 客服中心：视图与写库动作 ----------
     列表、会话、AI 建议都来自 /api/db/chats*，页面不自己拼一条消息、不自己算一个分。 */
  const SEN_CN = { ai: 'AI 客服（已发送）', human: '人工客服（老板发送）', system: '系统' };
  const kbRow = k => `<tr><td>${esc(k.id)}</td><td>${esc(k.kind)}</td><td>${esc(k.title)}</td>
      <td class="why">${esc(short(k.body))}</td><td>${esc(k.source || '—')}</td><td>${esc(k.updated_at || '')}</td></tr>`;

  /* AI 主动跟进：阈值、优先级、草稿文案全部来自 /api/db/followups（tools/cs-ops.mjs），
     页面不自己判「该不该跟进」、不自己拼一句话；只有点发送才走 POST 写 messages。 */
  function fuPanel(f) {
    const items = (f && f.items) || [];
    const rules = ((f && f.rules) || []).map(r => r.k + ' ≥ ' + r.need).join(' ｜ ');
    const top = items.slice().sort((a, b) => b.priority - a.priority)[0];
    const todo = items.filter(x => !x.sent_at).length;
    const sum = f && f.error ? '清单读取失败'
      : !items.length ? '暂无客户命中阈值'
        : (todo ? todo + ' 个待跟进 · 最高优先级 ' + top.name + '（' + top.priority + '）' : '清单内客户均已跟进');
    const box = `<div class="sp-ai sp-fu${state.fu.open ? ' open' : ''}" id="fuPanel">
      <div class="hd"><h4>AI 主动跟进<em>${items.length} 个客户命中行为阈值 · 清单只算不写 · ${esc(sum)}</em></h4>
      <button class="ai-btn ${state.fu.open ? '' : 'pri'}" data-act="fu-open" type="button">${state.fu.open ? '收起跟进清单' : '展开跟进清单（发送跟进在这里）'}</button></div>`;
    if (!state.fu.open) return box + '</div>';
    if (f && f.error) return box + `<div class="ai-err">跟进清单读取失败：${esc(f.error)}</div></div>`;
    const note = `<div class="ai-note">阈值（tools/cs-ops.mjs FOLLOW_RULES）：${esc(rules || '—')}。不满足任一条件的客户不会出现在这张表里。</div>`;
    if (!items.length) return box + note + '<div class="ai-hint">当前没有客户命中这三条阈值，清单是空的——AI 不会为了有活干而凑一个跟进理由。</div></div>';
    const pick = items.filter(x => x.cust === state.fu.pick)[0] || items[0];
    /* 默认显示的就是优先级最高那条，把 state 认下来：不然再点这一行时界面以为「换了个人」，
       实际 DOM 一字不变、也不给回执，看起来就是个坏按钮。 */
    state.fu.pick = pick.cust;
    const rows = items.map(x => `
      <tr class="${x.cust === pick.cust ? 'on' : ''}">
        <td><b>${esc(x.name)}</b><br><span class="ai-note" style="margin:0">#${esc(x.cust)} · ${esc(x.country || '')}</span></td>
        <td>${x.hits.map(h => `<span class="ai-pill">${esc(h.k)}：${esc(h.value)}</span>`).join(' ')}</td>
        <td><b>${x.priority}</b>${scoreBar(x.priority, x.priority >= 62)}<br><span class="ai-note" style="margin:0">命中 ${x.hits.length} 条 · 购买意向 ${x.signals.buy}</span></td>
        <td>${esc(x.signals.stage)}</td>
        <td>${x.sent_at ? '已跟进 ' + esc(x.sent_at) : '<span class="ai-pill y">未跟进</span>'}</td>
        <td class="sp-row" style="gap:4px">
          <button class="ai-btn xs ${x.cust === pick.cust ? 'pri' : ''}" data-act="fu-pick" data-id="${esc(x.cust)}" type="button">${x.cust === pick.cust ? '草稿在下方' : '看草稿'}</button>
          ${x.conv_id ? `<button class="ai-btn xs" data-act="chat" data-id="${esc(x.cust)}" data-conv="${esc(x.conv_id)}" data-unread="0" type="button">去会话</button>` : ''}
        </td>
      </tr>`).join('');
    const t = state.fu.text != null ? state.fu.text : pick.draft;
    const body = state.fu.edit
      ? `<textarea class="ai-ta" id="fuRep" rows="6" style="height:auto">${esc(t)}</textarea>
         <div class="sp-row" style="margin-top:6px"><button class="ai-btn pri" data-act="fu-send-edit" data-id="${esc(pick.cust)}" type="button" ${pick.conv_id ? '' : 'disabled'}>发送修改版（写入 messages）</button>
         <span class="ai-note" style="margin:0">改过的文本落库记 sender=human，不冒充 AI 原文；改前改后都进 ai_ops。</span></div>`
      : `<pre class="ai-mail" id="fuRep">${esc(pick.draft)}</pre>`;
    return box + note + `<div style="overflow-x:auto"><table class="ai-table"><thead><tr>
          <th>客户</th><th>命中的行为阈值（数值可回溯）</th><th>优先级</th><th>阶段</th><th>跟进记录</th><th>操作</th>
        </tr></thead><tbody>${rows}</tbody></table></div>
        <div class="ai-sub" style="margin:12px 0 6px">AI 建议跟进话术 · ${esc(pick.name)}（话术语言 中文 · 客户本国语言 ${esc(pick.native || '—')}${pick.product_id ? ' · 引用商品 ' + esc(pick.product_id) : ' · 无可引用商品，草稿不写价格与库存'}）</div>
        ${body}
        <div class="sp-row" style="gap:6px;margin-top:6px">
          ${state.fu.edit ? '' : `<button class="ai-btn pri" data-act="fu-send" data-id="${esc(pick.cust)}" type="button" ${pick.conv_id ? '' : 'disabled'}>发送这条跟进（写入 messages）</button>
            <button class="ai-btn" data-act="fu-edit" type="button">改一改再发</button>
            <button class="ai-btn" data-act="copy" data-src="fuRep" type="button">一键复制</button>`}
          <button class="ai-btn xs" data-act="toggle" data-target="fuEv" type="button">这条建议的依据（${(pick.evidence || []).length} 条）</button>
        </div>
        ${pick.conv_id ? '' : '<div class="ai-note warn">该客户还没有会话，跟进消息无处可写：先在客服中心给他发一条消息。</div>'}
        <div class="ai-evbox" id="fuEv">${evHtml(pick.evidence, '命中条件与草稿数字的出处（行号可回溯）')}</div>
        <div class="ai-note">${esc(f.notice || '')} 优先级口径：${esc(pick.formula)}。</div></div>`;
  }

  function serviceView(rows, th, draft, kb, fu, demo) {
    const c = th.customer, conv = th.conversation, sg = th.signals, prof = c.profile || {};
    state.cs.alts = draft.alt || [];
    /* 演示留下的消息都记在 ai_ops(kind=demo_turn) 里，接口把每一步（提问 / 追问 / 收尾）与行号给回来，
       这里照它逐条打标——标签写的是库里真记的那一步，不是前端数出来的第几条 */
    const demoIds = (demo && demo.demo_messages) || [];
    const demoSteps = (demo && demo.demo_steps) || [];
    const KIND_CN = { ask: '演示提问', react: '演示追问', close: '演示收尾', answer: '演示回应' };
    const stepOf = id => demoSteps.filter(s => s.ask_id === id || s.reply_id === id)[0] || null;
    const demoTag = id => {
      const s = stepOf(id);
      if (!s && demoIds.indexOf(id) < 0) return '';
      const ask = s ? s.ask_id === id : true;
      const why = s && s.basis ? ' · 接的是 AI 上一句 messages.' + s.basis : '';
      const t = '<b class="sp-dm-tag" title="这一条是点「演示自动对话」写进 messages 的，不是真人敲的' + esc(why) + '">'
        + esc(s ? ((KIND_CN[s.kind] || '演示') + (ask ? '' : '（AI）')) : '演示') + '</b>';
      return t;
    };
    const listHtml = rows.map(r => `
      <div class="sp-cust ${r.id === c.id ? 'on' : ''}" data-act="chat" data-id="${esc(r.id)}" data-conv="${esc(r.conv_id || '')}" data-unread="${r.unread}">
        <div class="av">${r.avatar ? `<img src="${esc(r.avatar)}" alt="${esc(r.name)}" title="customers.${esc(r.id)}.avatar">` : esc((r.name || '?').slice(0, 1))}</div>
        <div class="mt"><b>${esc(r.name)}${r.signals.buy >= 62 ? '<u>🔥高意向</u>' : ''}</b>
          <i>${esc(r.flag || '')} ${esc(r.country_cn || '')} · #${esc(r.id)}${r.online ? ' · 在线' : ' · 离线'}</i>
          <p>${esc((r.last_ask || r.last_text || '（还没有客户提问）').slice(0, 62))}</p>
          <div class="sp-row" style="gap:4px">${stage(r.signals.stage || '—')}<span class="ai-note" style="margin:0">购买意向 ${r.signals.buy}</span>${r.conv_status === 'need_human' ? '<span class="ai-pill y">待人工</span>' : ''}</div></div>
        <div class="tm">${esc(String(r.last_at || '').slice(5, 10))}<br>${r.unread ? `<s>${r.unread}</s>` : ''}</div>
      </div>`).join('');

    const msgs = th.messages.map(m => {
      const del = state.cs.del === m.id;
      /* 客户那条气泡原本只展示现算的分析依据；把落库时写进 messages.evidence 的那几条也带上，
         否则「这句是演示台词」这类留痕在页面上看不见，只剩一个小标签。 */
      const evList = (m.analysis ? m.analysis.evidence || [] : []).concat(m.sender === 'customer' ? m.evidence || [] : []);
      const tools = `<button class="ai-btn xs" data-act="toggle" data-target="ms${m.id}" type="button">依据（${evList.length} 条）</button>
        ${del ? `<button class="ai-btn xs pri" data-act="msg-del-yes" data-id="${m.id}" type="button">确认删除这条？</button>
                 <button class="ai-btn xs" data-act="msg-del-no" type="button">取消</button>`
              : `<button class="ai-btn xs" data-act="msg-del" data-id="${m.id}" type="button">删除</button>`}`;
      const ev = `<div class="ai-evbox" id="ms${m.id}">${evHtml(evList, '这条的指标 / 数值 / 来源')}</div>`;
      if (m.sender === 'customer') return `
        <div class="sp-msg">
          <div class="who">${esc(c.name)} · ${esc(prof.flag || '')}${demoTag(m.id)}<time>${esc(m.at)}</time></div>
          <div class="bu">${esc(m.text)}</div>
          <div class="sp-ana">
            <div class="t">AI 分析 · 这条消息${m.need_human ? ' ｜ 该问题需要人工确认' : ''}</div>
            <div class="kv">
              <span><i>客户意图</i> <b>${esc(m.intent || '其他咨询')}</b></span>
              <span><i>兴趣程度</i> <b>${m.interest == null ? '—' : m.interest}</b>${scoreBar(m.interest || 0)}</span>
              <span><i>购买意向</i> <b>${m.buy == null ? '—' : m.buy}</b>${scoreBar(m.buy || 0, (m.buy || 0) >= 62)}</span>
              <span><i>客户阶段</i> <b>${esc(m.stage || '—')}</b></span>
            </div>
            <div class="sg">建议：${esc(m.advice || '—')}${m.analysis && m.analysis.topics.length > 1 ? ' ｜ 同时提到 ' + esc(m.analysis.topics.slice(1).join('、')) : ''}</div>
            <div class="sp-row" style="gap:6px;margin-top:5px">${tools}</div>
            ${ev}
          </div>
        </div>`;
      return `
        <div class="sp-msg ai">
          <div class="who">${esc(SEN_CN[m.sender] || m.sender)}${m.need_human ? ' · 含需人工确认项' : ''}${demoTag(m.id)}<time>${esc(m.at)}</time></div>
          <div class="bu">${esc(m.text)}</div>
          <div class="sp-row" style="gap:6px;margin-top:3px">${tools}</div>
          ${ev}
        </div>`;
    }).join('');

    /* 演示自动对话：入口和「发送这条回复」排在同一块里，一眼看得到；按钮文字随状态变化，
       演到第几步 / 还剩哪几步（提问·追问·收尾）/ 为什么没得演，都直接写在这行，不靠 hover 也不藏进抽屉。 */
    const dTurns = demo.turns || [], dSkipped = demo.skipped || [], dDone = demo.demo_turns || 0;
    const dReask = dTurns.filter(t => t.reask).length;
    const playing = state.demo.playing === c.id;
    /* 每一步在提示条上就叫清楚：提问是照词典问，追问是读了 AI 那句「需人工确认」，收尾按最后一轮的缺口二选一，
       最后一格是客户回应收尾——那一句之后 AI 不再自动接话，会话真的停在客户这边 */
    const stepLabel = t => t.kind === 'react' ? t.topic + '（追问）'
      : t.kind === 'close' ? (t.planned ? '收尾（看最后一轮 AI 有没有留缺口）' : '收尾→' + t.topic)
      : t.kind === 'answer' ? (t.planned ? '客户回应（等收尾那句 AI 回复落库后定）' : '客户回应→' + t.topic)
      : t.topic + (t.reask ? '↻' : '');
    const demoHint = demo.error ? '演示接口不可用：' + esc(demo.error)
      : playing ? '正在一步一步真写库：客户说一句 → AI 回一条（与「发送这条回复」同一条链路）· AI 那句留了「需人工确认」，客户下一句就追着它再问 · 最后一步客户回一句就不再自动接 · 再点「停止演示」停在当前这一步'
      : !dTurns.length ? (dDone ? '四类话题各问了一遍、该追问的追问过、收尾与客户回应都说了（共 ' + dDone + ' 步）· 再点一次「▶ 重新演示」会先按留痕删掉这 ' + demoIds.length + ' 条演示消息，再从第一句演起'
                                : '台词没通过 classify 自检 · 见「演示口径与出处」')
      : '还剩 ' + dTurns.length + ' 步：' + dTurns.map(t => esc(stepLabel(t))).join('、')
        + ' · 台词是中文，按商品 ' + esc(demo.product_id || '（该会话没挂商品）') + ' 现算，不掺随机'
        + (dReask ? ' ｜ 带 ↻ 的 ' + dReask + ' 类客户之前问过，这句是过一阵再追问一次' : '');
    /* 演完不等于这个按钮废了：再点一次就是「清空 + 从头再演」，按钮上直接写清它会先删什么 */
    const replay = !dTurns.length && dDone > 0;
    const demoBtns = `<div class="sp-demo">
        ${playing ? `<button class="ai-btn pri" data-act="cs-demo-stop" type="button">■ 停止演示</button>`
                  : `<button class="ai-btn${replay ? ' pri' : ''}" data-act="cs-demo" data-id="${esc(c.id)}" type="button"
                      ${replay ? 'data-restart="1" data-done="' + dDone + '" ' : ''}
                      ${demo.error || (!dTurns.length && !dDone) ? 'disabled' : ''}>${replay ? '▶ 重新演示（先清掉这 ' + dDone + ' 步）' : '▶ 演示自动对话'}</button>`}
        ${dDone ? `<button class="ai-btn" data-act="cs-demo-clear" data-id="${esc(c.id)}" type="button">清空演示对话（${dDone} 步 · ${demoIds.length} 条消息）</button>` : ''}
        <button class="ai-btn xs" data-act="toggle" data-target="demoEv" type="button">演示口径与出处</button>
        <span class="ai-note" style="margin:0">${demoHint}</span>
        <div class="ai-evbox" id="demoEv">${evHtml([
          { label: '客户台词', value: 'tools/cs-ops.mjs demoTurns 现算 · 先按话题词典提问，AI 那句留了「需人工确认」就按 DEMO_REACT 追着同一类再问一轮，全问完按最后一轮的缺口收尾，收尾那句的 AI 回复落地后客户再回一句确认成交 · 每句都要被 classify 判回它声称的话题才发', src: 'ai_ops.kind=demo_turn' },
          { label: 'AI 回复', value: '与人工点「发送这条回复」走同一个 writeAiReply：读 kb_docs / products → 现算草稿 → 写 messages', src: 'tools/store-api.mjs' },
          { label: '已演', value: (demoSteps.length ? demoSteps.map(s => (KIND_CN[s.kind] || s.kind) + '「' + s.topic + '」' + (s.basis ? '←messages.' + s.basis : '')).join(' → ') : '一步还没演') + ' · 待演 ' + (dTurns.map(t => stepLabel(t)).join('、') || '无') + (dSkipped.length ? ' · 词典没判对的：' + dSkipped.map(s => s.topic + '→' + s.skipped).join('；') : ''), src: 'GET /api/db/chats/' + c.id + '/demo' },
          { label: '客户真实问过', value: ((demo.asked || []).join('、') || '一条客户提问都没有') + ' · 这些不占演示的名额', src: 'messages.conversation_id=' + conv.id },
          { label: '清空后', value: '点「清空演示对话」与演完后点「▶ 重新演示」走同一次反向删除：按 ai_ops 里记的两条消息号删掉演示行（连 AI 那句的 cs_reply 发送痕一起），并重算 conversations.updated_at / status 与 customers.last_at', src: 'DELETE /api/db/chats/' + c.id + '/demo' }
        ], '这个按钮到底做了什么') + `<div class="ai-note" style="margin-top:6px">${esc(demo.notice || '')}</div>`}</div>
      </div>`;
    const btns = `<div class="btns">
        <button class="ai-btn pri" data-act="cs-send" data-id="${esc(c.id)}" type="button" ${draft.error ? 'disabled' : ''}>发送这条回复（写入 messages）</button>
        <button class="ai-btn" data-act="cs-regen" data-id="${esc(c.id)}" type="button" ${draft.error ? 'disabled' : ''}>重新生成</button>
        <button class="ai-btn" data-act="cs-edit" type="button" ${draft.error ? 'disabled' : ''}>${state.cs.edit ? '收起编辑框' : '改一改再发'}</button>
        <button class="ai-btn" data-act="cs-human" data-id="${esc(conv.id)}" type="button">转人工</button>
        <button class="ai-btn" data-act="ins" data-cust="${esc(c.id)}" type="button">查看客户画像</button>
        <button class="ai-btn" data-act="copy" data-src="spRep" type="button">一键复制</button>
        <button class="ai-btn" data-act="kb" type="button">${state.cs.kbOpen ? '收起知识库' : 'AI 客服知识库'}</button>
      </div>`;
    const repText = state.cs.text != null ? state.cs.text : (draft.reply || '');
    const draftBox = draft.error ? `<div class="ai-err">AI 建议回复生成失败：${esc(draft.error)}</div>`
      : (state.cs.edit
        ? `<textarea class="ai-ta" id="spRep" rows="9" style="height:auto">${esc(repText)}</textarea>
           <div class="sp-row" style="margin-top:6px"><button class="ai-btn pri" data-act="cs-send-edit" data-id="${esc(c.id)}" type="button">发送修改版</button>
           <span class="ai-note" style="margin:0">改过的文本落库时记 sender=human，不冒充 AI 原文；改前改后都进 ai_ops。</span></div>`
        : `<pre class="ai-mail" id="spRep">${esc(repText)}</pre>`)
        + `<div class="ai-lang">${(draft.alt || []).map((a, i) => `<button data-act="cs-alt" data-i="${i}" type="button">${esc(a.t)}</button>`).join('')}
            <span class="ai-note" style="margin:0">回复语言 中文 · 客户本国语言 ${esc(draft.native || '—')} · 意图 ${esc(draft.intent || '—')}${draft.product_id ? ' · 引用商品 ' + esc(draft.product_id) : ''} · 重新生成＝按当前库存与最新提问重算，规则确定不掺随机</span></div>`
        + ((draft.cites || []).length
          ? `<div class="ai-note">引用出处：${(draft.cites || []).map(x => `<span class="ai-pill">${esc(x)}</span>`).join('')}</div>`
          : '<div class="ai-note warn">知识库里没有可引用的条目：这条 AI 答不了，只能转人工。</div>')
        + (draft.need_human ? `<div class="ai-note warn">该问题需要人工确认：${esc((draft.gaps || []).join('；'))}</div>` : '')
        + `<div class="sp-row" style="gap:6px;margin-top:5px"><button class="ai-btn xs" data-act="toggle" data-target="csRep" type="button">发送依据（${(draft.evidence || []).length} 条出处）</button>
           <span class="ai-note" style="margin:0">${esc(draft.notice || '')}</span></div>
           <div class="ai-evbox" id="csRep">${evHtml(draft.evidence, '这条回复用到的字段（行号可回溯）')}</div>`;
    const say = `<div class="sp-row" style="gap:8px">
        <input class="ai-in" id="csText" style="flex:1" placeholder="以人工身份回复这条会话（写入 messages，sender=human）" value="${esc(state.cs.say)}">
        <button class="ai-btn pri" data-act="cs-say" data-id="${esc(c.id)}" data-conv="${esc(conv.id)}" type="button">人工发送</button>
      </div>`;
    const kinds = (kb && kb.kinds) || [];
    const kbPanel = !state.cs.kbOpen ? '' : `<div class="sp-ai" id="kbPanel"><h4>AI 客服知识库<em>${kb ? kb.total : 0} 条 · ${kinds.map(k => esc(k.kind) + ' ' + k.n).join(' / ')}</em></h4>
      <div class="sp-row" style="margin-bottom:8px;gap:8px"><input class="ai-in" id="kbQ" style="flex:1" placeholder="检索：退货 / MOQ / 时效 / 保修 / 支付…" value="${esc(state.cs.kbQ)}">
        <button class="ai-btn" data-act="kb-search" type="button">检索</button></div>
      <div style="overflow-x:auto"><table class="ai-table"><thead><tr><th>编号</th><th>类型</th><th>标题</th><th>正文（AI 只引用这里的原文）</th><th>来源</th><th>更新</th></tr></thead>
        <tbody>${kb && kb.items.length ? kb.items.map(kbRow).join('') : '<tr><td colspan="6">没有匹配条目</td></tr>'}</tbody></table></div>
      <div class="sp-form" style="margin-top:10px">
        <label>类型<input class="ai-in" id="kbKind" list="kbKindList" placeholder="如 物流时效"><datalist id="kbKindList">${kinds.map(k => `<option value="${esc(k.kind)}">`).join('')}</datalist></label>
        <label>标题<input class="ai-in" id="kbTitle"></label>
        <label>编号（留空自动生成）<input class="ai-in" id="kbId" placeholder="如 KB-PAY-02"></label>
        <label style="grid-column:span 3">正文（写给 AI 的事实：时效、价格、政策、话术边界）<textarea class="ai-ta" id="kbBody" rows="3"></textarea></label>
      </div>
      <div class="sp-row" style="margin-top:8px"><button class="ai-btn pri" data-act="kb-add" type="button">补一条知识（写入 kb_docs）</button>
      <span class="ai-note" style="margin:0">补完 AI 下一条建议回复就能引用；编号重复会被数据库拒绝并说明原因。</span></div></div>`;
    /* 底部那张「话题分布」条不再渲染：同一份分布 AI 引擎在 storeAnalysis / customerService 里照算照返回，
       页面上它只是把会话列表又摊一遍，还会把聊天框挤成一小条。客服中心整屏留给会话。 */
    const lastQMsg = th.messages.filter(m => m.sender === 'customer').pop();
    /* 不叫「最后一问」：演示走到最后一步，客户说的是回应而不是提问，标签跟着库里那一步的 kind 走 */
    const lqStep = lastQMsg ? stepOf(lastQMsg.id) : null;
    const lastQBar = !lastQMsg ? '' : `<div class="sp-lastq"><b>客户最后一条</b><span>${esc(lastQMsg.text)}</span>
      <i>messages.${lastQMsg.id} · ${esc(String(lastQMsg.at || '').slice(5))}${lqStep ? ' · ' + esc(KIND_CN[lqStep.kind] || '演示台词') : ''}</i></div>`;
    return `<div class="sp-svcwrap">`
      + head('AI 客服中心 · ' + c.name + '（#' + c.id + ' · ' + (c.country_cn || '') + '）',
        (DB.hosted
          ? '客户、会话、消息与知识库读的是发布时烘好的只读快照；这一版没有后端，发送 / 删除 / 补知识点了只会当场说明「部署版不能写」，不会伪装成已发送。'
          : '客户、会话、消息与知识库都读自本地数据库，发送 / 删除 / 补知识都真的写库，刷新后还在。'
          + '电商平台尚未连接，这里发送只落本地 messages。'), 'db')
      + fuPanel(fu)
      + `<div class="sp-svc"><div class="sp-clist">${listHtml}</div>
           <div class="sp-thread">
             <div class="ai-note" style="margin:0 0 8px">${esc(c.name)}：${sg.views} 次浏览 / 停留 ${sg.dwellMin} 分钟 / ${sg.cart} 次加购 / ${sg.fav} 次收藏 / ${sg.purchases} 单成交
               ｜ 兴趣度 ${sg.interest} · 购买意向 ${sg.buy} ｜ 会话 ${esc(conv.id)}（${esc(conv.assignee)} / ${esc(conv.status)}）· 共 ${th.messages.length} 条消息
               <button class="ai-btn xs" data-act="toggle" data-target="csSig" type="button">算分口径</button>
               <div class="ai-evbox" id="csSig">${evHtml([{ label: '公式', value: sg.formula, src: 'tools/cs-ops.mjs' },
                 { label: '行为明细', value: th.events.length + ' 条 events（最近：' + esc((th.events[0] || {}).type || '—') + '）', src: 'events.customer_id=' + c.id },
                 { label: '订单', value: th.orders.length + ' 单 · 合计 ' + th.orders.reduce((n, o) => n + (o.amount || 0), 0) + ' 美元', src: 'orders.customer_id=' + c.id }], '这个客户的意向怎么来的')}</div></div>
             ${lastQBar}
             <div class="sp-chat">
               <div class="sp-msgs">${msgs}</div>
               <div class="sp-comp">${btns}${demoBtns}${draftBox}</div>
             </div>
             <div class="sp-say">${say}</div>
           </div>
         </div>
         ${kbPanel}
       </div>`;
  }

  function fuSend(cust, text) {
    state.fu.edit = false; state.fu.text = null;
    return done(DB.sendFollowup(cust, text), r =>
      '跟进已写入 messages.' + r.message.id + '（sender=' + r.sender + '）· 记录 ai_ops #' + r.op_id
      + (r.edited ? ' · 你改过的文本按人工发送记账' : '')
      + ' · 平台未连接，客户不会真的收到这条');
  }
  function csSend(cust, text) {
    return done(DB.csReply(cust, text), r => '已写入 messages.' + r.message.id + '（sender=' + r.sender + '）· 记录 ai_ops #' + r.op_id
      + (r.edited ? ' · 你改过的文本按人工发送记账' : '')
      + (r.draft.need_human ? ' · 本条含需人工确认项，会话已转人工' : ''));
  }
  function csSay(cust, convId) {
    const t = (val('csText') || '').trim();
    state.cs.say = t;
    if (!t) { toast('请先写要发送的内容'); run(true); return null; }
    state.cs.say = '';
    return done(DB.send({ conversation_id: convId, sender: 'human', text: t, lang: 'zh' }), r =>
      '已写入 messages.' + r.message.id + '（sender=human）· 会话 ' + convId + ' 时间已更新');
  }
  function csHuman(convId) {
    return done(DB.convUpdate(convId, { assignee: 'human', status: 'need_human' }), () =>
      '会话 ' + convId + ' 已转人工（assignee=human / status=need_human）· 系统没有代替人工发出任何消息');
  }
  function csDel(id) {
    return done(DB.deleteMessage(id), r => '已删除 messages.' + id + '（原属会话 ' + r.conversation_id + '）· 只删本地库这一行');
  }
  function csAlt(i) {
    const a = (state.cs.alts || [])[i];
    if (!a) return;
    state.cs.text = a.v + '\n\n（' + a.t + ' · 人工确认后再发）';
    state.cs.edit = true;
    run(true);
  }

  /* ---------- 演示自动对话 ----------
     台词不是前端拼的：每一轮都调 POST /api/db/chats/<cust>/demo，由服务端先写一条客户提问、
     再走 writeAiReply 生成 AI 回复，两条行号记进 ai_ops(kind='demo_turn')。
     这里只负责一轮一轮按下去：每轮之后强制重画，气泡是下一次从 messages 读回来的，不是本地假插的。 */
  const DEMO_GAP = 2000;
  /* 演示的重画一律走 quiet：它每 2 秒自己发生一次，绝不该把用户正在按的那一下吃掉 */
  function demoRedraw() { delete state.cache.service; run(true, true); }
  function demoClearTimer() { if (state.demo.timer) { clearTimeout(state.demo.timer); state.demo.timer = null; } }
  /* 按住期间的记账与抬起后的补画见上面的 holding / holdRedraw / holdToast 声明处 */
  addEventListener('pointerdown', () => { holding = true; });
  addEventListener('pointerup', () => {
    holding = false;
    /* 不能在这里立刻重画：click 是抬起之后才派发的，此刻换掉 DOM 等于把刚才那一下重新吃回去。
       等 250 毫秒，让 click 走完（用户点的那个按钮自己会重画），再补上被按住期间推迟的那一帧。 */
    if (holdRedraw || holdToast) {
      holdRedraw = false;
      const m = holdToast; holdToast = null;
      /* 抬起之后的这 250 毫秒里，用户那一下的点可能已经说了更新的一句话（比如「演示停在当前这轮」）。
         按住期间攒下的那句是上一轮的旧闻，不能再盖回去——实测按住 ■ 3.2 秒跨过一次重画时，
         松开后回执被旧的那轮顶掉，界面就说不清自己到底停没停。 */
      setTimeout(() => { if (m && state.toast === m) toast(m); demoRedraw(); }, 250);
    }
  });
  addEventListener('pointercancel', () => { holding = false; });
  function demoStop(msg) {
    demoClearTimer();
    state.demo.seq++;
    state.demo.playing = null;
    state.demo.cleared = 0; state.demo.clearedRows = null;
    if (msg) toast(msg);
    demoRedraw();
  }
  function demoStart(cust) {
    demoClearTimer();
    const prev = state.demo.playing;
    state.demo.seq++;
    state.demo.playing = cust;
    state.demo.cleared = 0; state.demo.clearedRows = null;
    toast((prev && prev !== cust ? '客户 #' + prev + ' 的演示已停 · ' : '') + '演示开始，第一轮正在写库…');
    demoRedraw();
    demoTick(cust);
  }
  /* 演完之后再点 ▶：先按 ai_ops(kind=demo_turn) 把这一会话的旧演示行清空，再从头演一遍。
     清空与重演都是真写库的同一套接口，中间不给本地假数据；清空失败就停在那儿报出来，不硬演。 */
  function demoRestart(cust, doneTurns) {
    demoClearTimer();
    state.demo.seq++;
    state.demo.playing = cust;
    state.demo.cleared = doneTurns;
    toast('这一会话已经演过 ' + doneTurns + ' 步 · 正在按 ai_ops(kind=demo_turn) 的留痕清空旧演示行，清完从头再演…');
    demoRedraw();
    const seq = state.demo.seq;
    DB.demoClear(cust).then(r => {
      if (state.demo.playing !== cust || seq !== state.demo.seq) return;
      state.demo.clearedRows = r.removed_messages + ' 条消息 / ' + r.removed_ops + ' 条留痕';
      demoTick(cust);
    }).catch(e => { if (seq !== state.demo.seq) return; demoStop('旧演示行没有清掉，所以没有重演：' + DB.downMessage(e)); });
  }
  function demoTick(cust) {
    state.demo.timer = null;
    if (state.demo.playing !== cust) return;
    if (cust !== state.cs.cust) { demoStop('已切到别的客户，演示停在这里 · 已写进库的消息点「清空演示对话」删'); return; }
    /* 换到别的模块也必须停：演示的重画会盖掉用户新站的那一屏。
       这里既不出回执、也不重画（goTab 刚擦掉上一条回执，重画会把用户新站那一屏的读取打回去），
       回到客服中心时演示条自己会写清「还剩几步」与已演的那几条。 */
    if (state.tab !== 'service') {
      demoClearTimer(); state.demo.seq++; state.demo.playing = null;
      state.demo.cleared = 0; state.demo.clearedRows = null;
      return;
    }
    /* 每一「次运行」发一个号：按了 ■ 之后再点 ▶，上一那次运行还在路上的那一轮会晚一步回来。
       它要是继续说话，就会拿旧的轮数把新一轮顶掉——甚至把 left===0 当成「演完了」把 playing 落回 null，
       用户看到的就是「按了 ▶ 什么都没发生」。所以只认自己这次的号。 */
    const seq = state.demo.seq;
    state.demo.round = seq;
    DB.demoTurn(cust).then(r => {
      if (seq !== state.demo.seq) { if (state.demo.round === seq) state.demo.round = null; return; }
      state.demo.round = null;
      const cites = ((r.draft && r.draft.cites) || []).join('、');
      const STEP = { ask: '提问', react: '读 AI 那句后追问', close: '收尾', answer: '客户回应' };
      /* 「重新演示」清空的那一下会被第一轮的回执盖掉，所以把删了多少条并进来写，不让它悄悄发生 */
      const again = r.round === 1 && state.demo.cleared
        ? '已按 ai_ops 留痕清掉上一轮演示（' + state.demo.cleared + ' 步 · ' + (state.demo.clearedRows || '旧演示行') + '）· ' : '';
      state.demo.cleared = 0; state.demo.clearedRows = null;
      /* 最后一步只有客户那一句：AI 不自动接话，回执就不许写成「→ AI messages.x」 */
      const tail = r.reply ? ' → AI messages.' + r.reply.id + '（记录 ai_ops #' + r.op_id + '）· 出处 ' + (cites || '无，本条转人工')
        : '（记录 ai_ops #' + r.op_id + '）· 这一句 AI 不自动接话，会话停在客户这边 · 右侧已按这句现算好建议回复';
      toast(again + '演示第 ' + r.round + ' / ' + r.avail + ' 步 · ' + (STEP[r.step] || '提问') + '「' + r.turn + '」'
        + (r.basis ? '（接 messages.' + r.basis + '）' : '') + '：客户 messages.' + r.ask.id
        + tail
        + (r.left > 0 ? ' · 还剩 ' + r.left + ' 步' : ' · 演完了，再点「▶ 重新演示」会自动清空这 ' + r.avail + ' 步并从第一句再演'));
      /* 演完的那一帧要先把「正在演」落回 null 再重画：否则最后一帧停在「■ 停止演示」，
         「▶ 重新演示」永远不出现，用户看到的就是「客户不说话了、按钮也没反应」。
         这一轮回来之前用户也可能已经按了停止——排下一轮之前只认还在演的那个客户。 */
      const stopped = state.demo.playing !== cust;
      if (!stopped && r.left === 0) state.demo.playing = null;
      if (holding && !stopped && r.left > 0) holdRedraw = true; else demoRedraw();
      if (stopped || r.left === 0) return;
      state.demo.timer = setTimeout(() => demoTick(cust), DEMO_GAP);
    }).catch(e => {
      if (seq !== state.demo.seq) { if (state.demo.round === seq) state.demo.round = null; return; }
      state.demo.round = null; demoStop('演示这一轮没有写进去：' + DB.downMessage(e));
    });
  }
  /* 切到别的标签页时 Chrome 会把这 2 秒的节拍冻成几十秒（实测同样 8 轮：前台 14.3 秒、后台 120 秒没走完），
     用户看到的就是「演示卡住了」。回到前台立刻补跑被冻住的那一轮，正在写库的那一轮不打断。 */
  document.addEventListener('visibilitychange', () => {
    const c = state.demo.playing;
    if (!c || state.demo.round || document.visibilityState !== 'visible') return;
    demoClearTimer();
    demoTick(c);
  });
  function demoClearRun(cust) {
    demoStop();
    done(DB.demoClear(cust), r => '已清空演示对话：删除 ' + r.removed_messages + ' 条 messages 与 ' + r.removed_ops
      + ' 条 ai_ops 留痕' + (r.missing_messages ? '（另 ' + r.missing_messages + ' 条早已被人工删掉）' : '')
      + ' · 会话现在共 ' + r.remaining + ' 条消息，时间与客户活跃点已按剩余真实行重算');
  }
  function kbAdd() {
    const kind = (val('kbKind') || '').trim(), title = val('kbTitle'), body = val('kbBody');
    if (!kind || !title || !body) { toast('知识库条目要填类型 / 标题 / 正文'); run(true); return null; }
    return done(DB.addKb({ kind: kind, title: title, body: body, id: (val('kbId') || '').trim() || undefined, lang: 'zh' }), r =>
      '已写入 kb_docs.' + r.doc.id + ' · AI 下一条建议回复即可引用这一条');
  }

  function copyText(txt, btn) {
    const done = () => { const t = btn.textContent; btn.textContent = '已复制 ✓'; setTimeout(() => { btn.textContent = t; }, 1400); };
    const area = document.createElement('textarea');
    area.value = txt;
    area.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (err) { /* 交给下面的 promise 兜底 */ }
    document.body.removeChild(area);
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, () => {});
  }

  /* ---------- 启动 ---------- */
  function tick() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    $('spClock').textContent = d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* 数据底座状态必须写在明面上：库没起来就直说「本地数据库未启动」，不能悄悄退回快照 */
  function bindDb() {
    const el = $('spProvider'), src = $('spShopSrc');
    const off = info => {
      const msg = String((info || {}).error || '未知原因');
      el.classList.add('db-down'); src.classList.add('db-down');
      if (DB.hosted) { el.textContent = msg + '（部署版读的是 data/snap/ 的只读快照，快照没烘上这一项）'; return; }
      el.textContent = msg.indexOf('node ') >= 0 ? msg : msg + '（请用 node tools/proxy.mjs 打开本页，纯静态下没有数据底座）';
    };
    if (!window.DB) { off({ error: '未加载 js/db.js' }); return Promise.resolve(null); }
    return DB.probe().then(st => {
      if (!st.ok) { off(st.info); return null; }
      const c = st.info.counts || {};
      el.classList.remove('db-down'); src.classList.remove('db-down');
      el.textContent = (DB.hosted ? '只读快照 ' + String(st.info.file || '') + '（' + String(st.info.seeded_at || '').slice(0, 10) + ' 播种）'
        : '本地数据库 ' + String(st.info.file || '').split('/').pop()) + ' · 商品 ' + c.products
        + ' · 客户 ' + c.customers + ' · 会话消息 ' + c.messages + ' · 知识库 ' + c.kb_docs
        + ' · ' + (DB.hosted ? '只读，不可写' : '可增删改查');
      return null;
    }).catch(e => { off({ error: e.message }); });
  }

  function boot() {
    $('spTabs').innerHTML = TABS.map(t => `<button class="ai-tab" data-tab="${t.id}" type="button">${t.t}</button>`).join('');
    $('spTabs').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      /* 点自己也要有回应：说清「这就是当前模块」，别让标签看着是死的 */
      if (b.dataset.tab === state.tab) {
        toast('已经在「' + ((TABS.filter(x => x.id === b.dataset.tab)[0] || { t: b.dataset.tab }).t) + '」· 换上面的标签才切模块');
        run(false); return;
      }
      goTab(b.dataset.tab);
    };
    $('spFlow').innerHTML = FLOW.map((f, i) => {
      const ext = f.page || (VIEW_OF[f.tab] !== VIEW ? VIEW_OF[f.tab] : '');
      return `<li data-i="${i}" data-tab="${f.tab || ''}"${ext ? ` data-ext="${ext}"` : ''}><s>${i + 1}</s>${esc(f.t)}`
        + `${f.from ? `<u>${esc(f.from)}</u>` : ''}${ext ? '<x>↗</x>' : ''}</li>`;
    }).join('');
    $('spFlow').onclick = e => {
      const li = e.target.closest('li');
      if (li) openFlow(FLOW[+li.dataset.i]);
    };
    buildInput();
    hydrateCtx();
    tick(); setInterval(tick, 1000);
    const want = new URLSearchParams(location.search).get('tab');
    const start = VIEW_OF[want] === VIEW ? want : HOME;
    window.__SHOP_READY = false;
    Promise.all([bindDb().then(buildShopCard), DS.ready()]).then(() => {
      window.__SHOP_READY = true;
      goTab(start);
      /* 外壳可能已经攒了一条跨页请求，等本页能渲染了再放行 */
      SHELL.post({ ready: VIEW });
      return null;
    }).catch(err => {
      $('spBody').innerHTML = '<div class="ai-err">店铺数据层加载失败：' + esc(err && err.message) + '</div>';
    });
  }
  boot();

})();
