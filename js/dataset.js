/* 统一数据集：把 data/*.json 与 js/data.js(世界银行) 归一化成页面与 AI 可直接消费的结构。
   页面里不允许再出现任何业务数字，全部经 DS 取。 */
(function () {
  'use strict';

  var docMeta = {};
  var readyPromise = null;

  function T() { return window.TRADE || {}; }
  function name(iso) {
    var s = T().stats && T().stats(iso);
    return (s && s.cn) || iso;
  }
  function pairs(arr, keys) {
    return (arr || []).map(function (r) {
      var o = {}; keys.forEach(function (k, i) { o[k] = r[i]; }); return o;
    });
  }
  function withName(arr) {
    return (arr || []).map(function (r) {
      return { iso: r[0], cn: name(r[0]), share: r[1] };
    });
  }
  function catRows(arr) {
    return (arr || []).map(function (r) {
      return { cat: r[0], amount: r[1], yoy: r[2], suppliers: withName(r[3]) };
    });
  }

  /* 未收录经济体：品类规模 = 世界银行真实进口额 × 全球品类结构占比；增速与双边数据一律留空 */
  function deriveMarket(iso, world) {
    var s = T().stats && T().stats(iso);
    if (!s || s.nodata) return { iso: iso, nodata: true };
    var gs = function (rows, base) {
      return (rows || []).map(function (r) {
        var cat = r[0], share = r[1];
        var gl = (world.k || []).filter(function (k) { return k[0] === cat; })[0];
        return {
          cat: cat, amount: +((base || 0) * share / 100).toFixed(1), yoy: null,
          share: share, suppliers: gl ? withName(gl[3]) : [], globalSuppliers: true, derived: true
        };
      });
    };
    return {
      iso: iso,
      src: 'derived',
      source: '品类规模由世界银行真实进口额按全球结构占比推算',
      goodsImport: pairs(world.i, ['name', 'share']),
      goodsExport: pairs(world.e, ['name', 'share']),
      partners: withName(world.p).filter(function (p) { return p.iso !== iso; }),
      china: { nodata: true, reason: '该经济体暂无中国与双边贸易记录，待接入 UN Comtrade / 中国海关' },
      cats: gs(world.i, s.imp),
      barriers: world.b.slice(),
      note: world.n
    };
  }

  function normalizeMarket(iso, row, meta) {
    var c = row.c || [];
    return {
      iso: iso,
      src: meta.src || 'mock',
      source: meta.source || '内置示例数据',
      unit: meta.unit,
      goodsImport: pairs(row.i, ['name', 'share']),
      goodsExport: pairs(row.e, ['name', 'share']),
      partners: withName(row.p),
      china: c.length ? {
        total: c[0], exp: c[1], imp: c[2], yoy: c[3], shareOfChina: c[4],
        hist: (c[5] || []).map(function (h) { return { y: h[0], amt: h[1] }; }),
        nodata: false
      } : { nodata: true, reason: '未收录该经济体与中国的双边贸易记录' },
      cats: catRows(row.k),
      barriers: (row.b || []).slice(),
      note: row.n || ''
    };
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = API.preload().then(function () { return true; });
    }
    return readyPromise;
  }

  function market(iso) {
    return ready().then(function () {
      return API.request('trade.market', { iso: iso }).then(function (res) {
        docMeta.market = res.meta;
        if (res.data) return normalizeMarket(iso, res.data, res.meta || {});
        return API.request('trade.world', {}).then(function (w) {
          return deriveMarket(iso, w.data || {});
        });
      });
    });
  }

  function catOf(mk, cat) {
    return (mk.cats || []).filter(function (c) { return c.cat === cat; })[0] || null;
  }
  function catsLike(mk, words) {
    return (mk.cats || []).filter(function (c) {
      return words.some(function (w) { return c.cat.indexOf(w) >= 0 || w.indexOf(c.cat) >= 0; });
    });
  }

  function region(adcode) {
    return ready().then(function () {
      return API.request('trade.region', { adcode: adcode }).then(function (res) {
        docMeta.region = res.meta;
        if (!res.data) return { adcode: adcode, nodata: true };
        var raw = res.data.raw, amt = raw.amt || null;
        return {
          adcode: res.data.adcode, level: res.data.level, name: res.data.name,
          parent: res.data.parentName || '', src: (res.meta && res.meta.src) || 'mock',
          source: (res.meta && res.meta.source) || '内置示例数据',
          amounts: amt ? { total: amt[0], exp: amt[1], imp: amt[2], unit: '亿元', from: 'regions' } : null,
          industries: pairs(raw.industries, ['name', 'share']),
          exports: pairs(raw.exports, ['name', 'share']),
          partners: withName(raw.partners),
          cities: Object.keys(raw.cities || {}).map(function (k) {
            return { adcode: k, name: raw.cities[k].name };
          }),
          note: raw.note || ''
        };
      });
    });
  }

  function provinceOfCity(adcode) {
    return String(adcode).slice(0, 2) + '0000';
  }

  function customers(filter) {
    filter = filter || {};
    return ready().then(function () {
      return API.request('customer.list', filter).then(function (res) {
        docMeta.customer = res.meta;
        var kw = (filter.keyword || '').toLowerCase();
        var words = (filter.products || []).concat(filter.terms || []);
        var out = (res.data || []).filter(function (c) {
          if (filter.iso && c.iso !== filter.iso) return false;
          if (filter.types && filter.types.length && !c.types.some(function (t) { return filter.types.indexOf(t) >= 0; })) return false;
          if (filter.sizes && filter.sizes.length && filter.sizes.indexOf(c.size) < 0) return false;
          var hay = (c.name + ' ' + c.cn + ' ' + c.city + ' ' + c.industry + ' ' + c.products.join(' ')).toLowerCase();
          if (kw && hay.indexOf(kw) < 0) return false;
          if (words.length) {
            var hit = words.some(function (w) {
              w = String(w).toLowerCase();
              return c.products.some(function (p) { return p.toLowerCase().indexOf(w) >= 0 || w.indexOf(p.toLowerCase()) >= 0; }) ||
                     c.industry.toLowerCase().indexOf(w) >= 0;
            });
            if (!hit) return false;
          }
          return true;
        });
        out.forEach(function (c) { c.matchReason = reason(c, filter); c.countryCn = name(c.iso); });
        out.sort(function (a, b) { return score(b, filter) - score(a, filter); });
        return { items: out.slice(0, filter.limit || 12), total: out.length, meta: res.meta || {} };
      });
    });
  }

  function reason(c, filter) {
    var r = [];
    if (filter.iso) r.push('位于' + name(filter.iso));
    if (filter.products && filter.products.length) r.push('经营' + filter.products.join('、'));
    if (filter.types && filter.types.length) r.push('属于' + filter.types.join('/'));
    if (filter.sizes && filter.sizes.length) r.push(c.size + '规模（约 ' + c.employees + ' 人）符合筛选');
    if (c.annualPurchase) r.push('年采购额约 ' + c.annualPurchase + ' 万美元');
    return r.filter(Boolean);
  }
  function score(c, filter) {
    var s = 0;
    if (filter.types) s += c.types.filter(function (t) { return filter.types.indexOf(t) >= 0; }).length * 3;
    if (filter.sizes) s += filter.sizes.indexOf(c.size) >= 0 ? 2 : 0;
    s += (c.annualPurchase || 0) / 1000;
    return s;
  }

  function customer(id) {
    return ready().then(function () {
      return API.request('customer.detail', { id: id }).then(function (res) {
        return res.data ? (res.data.countryCn = name(res.data.iso), res.data) : null;
      });
    });
  }

  function chains(adcode) {
    return ready().then(function () {
      return API.request('chain.byRegion', { adcode: adcode }).then(function (res) {
        docMeta.chain = res.meta;
        (res.data || []).forEach(function (c) {
          c.marketRows = (c.markets || []).map(function (m) {
            return { iso: m.iso, cn: name(m.iso), why: m.why };
          });
        });
        return res.data || [];
      });
    });
  }

  function news(limit) {
    return ready().then(function () {
      return API.request('news.list', { limit: limit || 8 }).then(function (res) {
        docMeta.news = res.meta;
        return res.data || [];
      });
    });
  }

  /* ============ AI 店铺（第四屏）：本地数据库 data/app.db 是唯一数据源 ============
     下面只把 window.DB 返回的行改成 AI 引擎认识的字段名，不再另存一份快照：
     老板刚改的库存、刚发的消息、刚上架的商品，下一次分析读到的就是那几行。
     库没起来时 DB 会 reject，错误一路抛到页面上显示「本地数据库未启动」，绝不静默换成假数据。 */
  function db() {
    if (!window.DB) return Promise.reject(new Error('本地数据库客户端未加载：店铺数据需要 js/db.js'));
    return window.DB;
  }
  function dbMeta(table, rows, extra) {
    docMeta.store = { src: 'db', table: table, rows: rows };
    return Object.assign({ src: 'db', source: '本地数据库 data/app.db · ' + table, rows: rows }, extra || {});
  }
  /* 库里 sender 用 human 表示人工发送；分析口径只分「客户说的」与「客服/agent 说的」 */
  function senderFrom(m) { return m.sender === 'customer' ? 'customer' : (m.sender === 'human' ? 'human' : 'ai'); }
  function shapeMsg(m) { return { from: senderFrom(m), at: m.at, text: m.text }; }
  function shapeProduct(r) {
    var daily = r.daily || [];
    return {
      id: r.id, name: r.name, nameEn: r.name_en || r.name, cat: r.category, price: r.price, cost: r.cost,
      stock: r.stock, status: r.status, views: r.views, cart: r.cart, ord: r.ord, dwell: r.dwell, fav: r.fav,
      attrs: r.attrs || {}, keywords: r.keywords || [], issues: r.issues || [], langs: r.langs || [],
      target: r.target_country, source: r.source, updated_at: r.updated_at,
      d7: { views: daily.map(function (x) { return x.views; }), ord: daily.map(function (x) { return x.ord; }) }
    };
  }

  function daily(days) {
    return db().daily(days || 30).then(function (d) {
      var rows = (d.items || []).map(function (r) {
        return {
          d: String(r.day).slice(5), vis: r.vis, pv: r.pv, chat: r.chat, cart: r.cart, ord: r.ord, rev: r.rev,
          dwell: r.dwell, hot: r.hot,
          cvr: r.vis ? +(r.ord / r.vis * 100).toFixed(2) : 0,
          aov: r.ord ? +(r.rev / r.ord).toFixed(1) : 0
        };
      });
      return { rows: rows, meta: dbMeta('store_daily', rows.length) };
    });
  }

  function rate(n, d) { return d ? +(n / d * 100).toFixed(1) : 0; }

  function normalizeProduct(p) {
    var v7 = (p.d7 && p.d7.views) || [], o7 = (p.d7 && p.d7.ord) || [];
    var prevV = v7.slice(0, 6), prevO = o7.slice(0, 6);
    var avg = function (a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; };
    return {
      id: p.id, name: p.name, nameEn: p.nameEn, cat: p.cat, price: p.price, cost: p.cost,
      stock: p.stock, status: p.status, views: p.views, cart: p.cart, ord: p.ord,
      dwell: p.dwell, fav: p.fav, attrs: p.attrs, keywords: p.keywords, issues: p.issues,
      target: p.target, langs: p.langs,
      cvr: rate(p.ord, p.views), cartRate: rate(p.cart, p.views),
      margin: p.price ? +((p.price - p.cost) / p.price * 100).toFixed(1) : 0,
      gmv: +(p.ord * p.price).toFixed(0),
      d7: { views: v7, ord: o7 },
      cvrToday: rate(o7[o7.length - 1] || 0, v7[v7.length - 1] || 0),
      cvrPrev: rate(avg(prevO), avg(prevV)),
      viewDelta: avg(v7.slice(0, 6)) ? +((v7[v7.length - 1] / avg(v7.slice(0, 6)) - 1) * 100).toFixed(1) : 0
    };
  }

  function products(filter) {
    filter = filter || {};
    return db().products({ limit: 1000, with: 'daily' }).then(function (d) {
      var kw = (filter.keyword || '').toLowerCase();
      var out = (d.items || []).map(function (r) { return normalizeProduct(shapeProduct(r)); }).filter(function (p) {
        if (filter.cat && p.cat !== filter.cat) return false;
        if (filter.status && p.status !== filter.status) return false;
        if (kw && (p.name + p.nameEn + p.id + p.cat + p.keywords.join(' ')).toLowerCase().indexOf(kw) < 0) return false;
        return true;
      });
      if (filter.sort === 'gmv') out.sort(function (a, b) { return b.gmv - a.gmv; });
      if (filter.sort === 'cvr') out.sort(function (a, b) { return b.cvr - a.cvr; });
      if (filter.sort === 'views') out.sort(function (a, b) { return b.views - a.views; });
      if (filter.sort === 'risk') out.sort(function (a, b) { return (a.cvrToday - a.cvrPrev) - (b.cvrToday - b.cvrPrev); });
      return { items: out, meta: dbMeta('products', out.length, { total: d.total }) };
    });
  }

  function chats() {
    return db().chats({ with: 'msgs' }).then(function (d) {
      var out = (d.items || []).filter(function (r) { return r.conv_id; }).map(function (r) {
        var msgs = (r.msgs || []).map(shapeMsg);
        var last = msgs[msgs.length - 1];
        var custMsgs = msgs.filter(function (m) { return m.from === 'customer'; });
        return {
          id: r.conv_id, cust: r.id, name: r.name, cn: r.name_cn, iso: r.iso, city: r.city, flag: r.flag,
          since: r.since, channel: r.channel || r.conv_channel, state: r.online ? '在线' : '离线', unread: r.unread,
          msgs: msgs,
          lastAt: last ? last.at : '', lastFrom: last ? last.from : '', lastText: last ? last.text : '',
          turns: custMsgs.length, countryCn: name(r.iso)
        };
      });
      out.sort(function (a, b) { return b.unread - a.unread || (a.lastAt < b.lastAt ? 1 : -1); });
      return { items: out, meta: dbMeta('customers × conversations × messages', out.length) };
    });
  }

  function events(cust) {
    return db().events(cust, { limit: 1000 }).then(function (d) {
      return {
        items: (d.items || []).slice().sort(function (a, b) { return a.id - b.id; }).map(function (e) {
          return { id: e.id, cust: e.customer_id, at: e.at, type: e.type, pid: e.product_id, sec: e.seconds };
        }),
        meta: dbMeta('events', (d.items || []).length, { cust: cust || 'all' })
      };
    });
  }

  /* 订单明细：库里一天 30 笔 × 30 天，一次全取没有意义，所以这里默认按天筛。
     total / sum 是「过滤后全部」的口径（后端算），items 只有本页这些——头部写「N 笔 · 合计 X 美元」
     时用前者，别拿本页条数当全天的笔数。 */
  function orders(q) {
    var query = typeof q === 'number' ? { limit: q } : Object.assign({}, q || {});
    if (query.limit == null) query.limit = 200;
    return db().orders(query).then(function (d) {
      return {
        items: (d.items || []).map(function (o) {
          return { id: o.id, cust: o.customer_id, pid: o.product_id, qty: o.qty, unit_price: o.unit_price, amount: o.amount, currency: o.currency, status: o.status, at: o.placed_at, platform: o.platform };
        }),
        total: d.total, sum: d.sum, day: d.day || null, limit: d.limit, offset: d.offset,
        meta: dbMeta('orders', (d.items || []).length, { total: d.total, sum: d.sum, day: d.day || 'all' })
      };
    });
  }

  /* 店铺上下文：直接读库里的 shops + platforms 行，不再从 JSON 复制 */
  function store() {
    return db().shop().then(function (d) {
      return { shop: d.shop || {}, platforms: d.platforms || [], counts: d.counts, meta: dbMeta('shops', 1, { table: 'shops + platforms' }) };
    });
  }

  function product(id) {
    return db().product(id).then(function (d) {
      if (!d.product) return null;
      var p = shapeProduct(Object.assign({}, d.product, { daily: (d.metrics || []).slice(-7) }));
      var out = normalizeProduct(p);
      out.metrics = d.metrics || []; out.stock_moves = d.stock_moves || []; out.kb = d.kb || null;
      return out;
    });
  }

  window.DS = {
    ready: ready,
    name: name,
    market: market,
    catOf: catOf,
    catsLike: catsLike,
    region: region,
    provinceOfCity: provinceOfCity,
    customers: customers,
    customer: customer,
    chains: chains,
    news: news,
    store: store,
    daily: daily,
    products: products,
    product: product,
    chats: chats,
    events: events,
    orders: orders,
    rate: rate,
    provenance: function () { return docMeta; }
  };
})();
