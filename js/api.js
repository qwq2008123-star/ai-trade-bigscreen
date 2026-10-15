/* 数据接口层：页面与 AI 能力只能通过这里取数。
   provider='mock' 时读 data/*.json；后端就绪后 API.setProvider('http', {base}) 即可整体切换。 */
(function () {
  'use strict';

  /* 店铺数据不在这一层：唯一数据源是本地数据库，页面经 window.DB（js/db.js）→ /api/db/* 读，
     这里只留市场/客户线索等静态快照文档。少了 store.* 八条路由，也就没有第二份可写的假快照。 */
  var FILES = {
    countries: 'data/countries.json',
    regions: 'data/regions.json?v=3',
    customers: 'data/customers.json',
    chains: 'data/chains.json',
    news: 'data/news.json',
    taxonomy: 'data/taxonomy.json'
  };

  /* 端点契约：http provider 用 path，mock provider 用 file + pick */
  var ROUTES = {
    'trade.market':      { path: '/api/trade/market',      file: 'countries', pick: function (d, p) { return (d.items || {})[p.iso] || null; }, meta: function (d) { return d.meta; } },
    'trade.world':       { path: '/api/trade/world',       file: 'countries', pick: function (d) { return d.world; }, meta: function (d) { return d.meta; } },
    'trade.region':      { path: '/api/trade/region',      file: 'regions',   pick: function (d, p) { return pickRegion(d, p.adcode); }, meta: function (d) { return d.meta; } },
    'customer.list':     { path: '/api/customer/list',     file: 'customers', pick: function (d) { return d.items; }, meta: function (d) { return d.meta; } },
    'customer.detail':   { path: '/api/customer/detail',   file: 'customers', pick: function (d, p) { return (d.items || []).filter(function (c) { return c.id === p.id; })[0] || null; }, meta: function (d) { return d.meta; } },
    'chain.byRegion':    { path: '/api/chain',             file: 'chains',    pick: function (d, p) { return (d.items || []).filter(function (c) { return !p.adcode || String(c.adcode) === String(p.adcode); }); }, meta: function (d) { return d.meta; } },
    'news.list':         { path: '/api/news',              file: 'news',      pick: function (d, p) { return (d.items || []).slice(0, p.limit || 8); }, meta: function (d) { return d.meta; } },
    'ai.taxonomy':       { path: '/api/ai/taxonomy',       file: 'taxonomy',  pick: function (d) { return d; }, meta: function (d) { return d.meta; } }
  };

  /* ---- AI 能力接缝：mock 时调用本地注册的推理实现，http 时 POST 给后端（后端再转 Dify 工作流）。
        页面只允许通过 API.ai.invoke(name, input) 触发 AI，切换 provider 不改任何调用点。 ---- */
  var AI_ROUTES = {
    marketAnalysis:     { path: '/api/ai/market-analysis' },
    marketFit:          { path: '/api/ai/market-fit' },
    productGenerator:   { path: '/api/ai/product-generator' },
    customerService:    { path: '/api/ai/customer-service' },
    customerInsight:    { path: '/api/ai/customer-insight' },
    customerBehavior:   { path: '/api/ai/customer-behavior' },
    storeAnalysis:      { path: '/api/ai/store-analysis' },
    dailyPlan:          { path: '/api/ai/daily-plan' },
    orderAnalysis:      { path: '/api/ai/order-analysis' }
  };
  var aiHandlers = {};

  function pickRegion(doc, adcode) {
    var code = String(adcode), out = null;
    var ps = doc.provinces || {};
    Object.keys(ps).forEach(function (pv) {
      var row = ps[pv];
      if (pv === code) out = { level: 'province', adcode: pv, name: row.name, raw: row };
      var cs = row.cities || {};
      if (cs[code]) out = { level: 'city', adcode: code, name: cs[code].name, raw: cs[code], parent: pv, parentName: row.name };
    });
    return out;
  }

  var cache = {}, inflight = {};

  function loadDoc(name) {
    if (cache[name]) return Promise.resolve(cache[name]);
    if (inflight[name]) return inflight[name];
    var url = FILES[name] + (FILES[name].indexOf('?') < 0 ? '?v=1' : '');
    inflight[name] = fetch(url).then(function (r) {
      if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
      return r.json();
    }).then(function (doc) {
      cache[name] = doc; delete inflight[name]; return doc;
    }).catch(function (e) { delete inflight[name]; throw e; });
    return inflight[name];
  }

  var state = { provider: 'mock', base: '' };

  function request(endpoint, params) {
    var route = ROUTES[endpoint];
    if (!route) return Promise.reject(new Error('未知接口 ' + endpoint));
    params = params || {};
    if (state.provider === 'http') {
      var q = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
      return fetch(state.base + route.path + (q ? '?' + q : ''), { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error(endpoint + ' HTTP ' + r.status);
          return r.json();
        }).then(function (body) {
          return { data: body.data !== undefined ? body.data : body, meta: body.meta || { src: 'live', source: state.base } };
        });
    }
    return loadDoc(route.file).then(function (doc) {
      return { data: route.pick(doc, params) || null, meta: route.meta ? route.meta(doc) : {} };
    });
  }

  function aiInvoke(name, input) {
    var route = AI_ROUTES[name];
    if (!route) return Promise.reject(new Error('未知 AI 能力 ' + name));
    input = input || {};
    if (state.provider === 'http') {
      return fetch(state.base + route.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(input)
      }).then(function (r) {
        if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
        return r.json();
      }).then(function (body) {
        return { data: body.data !== undefined ? body.data : body, meta: body.meta || { src: 'live', source: state.base } };
      });
    }
    var h = aiHandlers[name];
    if (!h) return Promise.reject(new Error('AI 能力未注册：' + name));
    return Promise.resolve().then(function () { return h(input); }).then(function (out) {
      return { data: out, meta: { src: 'mock', provider: 'mock', source: '本地规则引擎 + 本地数据库 data/app.db（未调用外部模型）' } };
    });
  }

  window.API = {
    routes: Object.keys(ROUTES),
    /* path → endpoint 反查：本地后端网关（tools/proxy.mjs）用它把 /api/* 落到同一份 mock 实现，避免两处维护路由 */
    paths: function () {
      var m = {};
      Object.keys(ROUTES).forEach(function (k) { m[ROUTES[k].path] = k; });
      return m;
    },
    request: request,
    setProvider: function (name, opts) {
      opts = opts || {};
      state.provider = name === 'http' ? 'http' : 'mock';
      state.base = opts.base || '';
      if (state.provider === 'http') cache = {};
      return state.provider;
    },
    provider: function () { return state.provider; },
    preload: function () { return Promise.all(Object.keys(FILES).map(loadDoc)).then(function () { return true; }); },
    ai: {
      names: Object.keys(AI_ROUTES),
      paths: AI_ROUTES,
      register: function (name, fn) { aiHandlers[name] = fn; return name; },
      registered: function () { return Object.keys(aiHandlers); },
      invoke: aiInvoke
    }
  };
})();
