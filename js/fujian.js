/* 福建省贸易数据模块（第二屏）。
   金额只有一个来源：data/regions.json 的 provinces['350000']。
   本模块不写死任何统计数值，只负责把全省/分市金额整理成第二屏要的形状，
   月度曲线与品类金额都是「同一份金额 × 明示系数」的派生值（src=derived）。 */
(function () {
  'use strict';

  var PROVINCE = { adcode: 350000, name: '福建省' };
  var TOP_CITY = 350200;   /* 厦门市：KPI 与月度对照曲线取它，与全省口径同一来源 */
  var TABS = { all: '全部数据', import: '进口数据', export: '出口数据' };
  var MAX_PILLARS = 7;
  var UNIT = '亿元';

  /* 月度窗口与设计稿一致（二月~九月）。季节性系数只描述形状，绝对值由年额摊出：
     月值 = 年额 / 12 × 系数，所以改金额曲线一定跟着改，不会出现两处数字打架。 */
  var MONTHS = ['二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月'];
  var MONTH_CURSOR = 3;
  var SEASON = {
    province: [0.98, 0.90, 1.03, 1.15, 0.96, 0.88, 1.02, 1.06],
    city: [0.95, 0.82, 1.08, 1.12, 0.90, 0.85, 1.05, 1.10]
  };

  /* 环形图四组：group 里的名字必须出现在 regions.json 的 exports 里，剩下的并入「其他品类」 */
  var CAT_GROUPS = [
    { name: '电子信息产品', color: '#7ef0cf', group: ['电子信息产品'] },
    { name: '其他品类', color: '#f8fcff', group: [] },
    { name: '鞋服纺织', color: '#b6d3fa', group: ['鞋类', '服装', '化纤与面料'] },
    { name: '石材与瓷砖', color: '#fdeecb', group: ['石材与瓷砖'] }
  ];

  var state = { loaded: false, province: null, cities: [], catShare: [], catTable: [], catSeason: {}, catMonthly: [], monthSeries: {}, kpiBase: [], supply: null, chains: [] };

  function fmt(n) {
    if (n == null || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  }
  function fmt2(n) {
    return (n == null || isNaN(n)) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  /* 月度回放时 KPI 用一位小数：271 + 327 会被看成 598，和地图上厦门那根光柱的 597 当场打架；
     270.7 + 326.6 = 597.3 才对得上。 */
  function fmt1(n) {
    return (n == null || isNaN(n)) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  function round(n, d) {
    var k = Math.pow(10, d);
    return Math.round(n * k) / k;
  }

  /* regions.json 的 exports 是 [品类, 占出口比重%]，合计不足 100 时差额记入「其他品类」 */
  function buildCats(exports, exportAmt) {
    var rows = (exports || []).map(function (p) {
      return { name: p[0], pct: p[1], amt: round(exportAmt * p[1] / 100, 2) };
    });
    return { share: group(rows, exportAmt), table: rows };
  }
  /* 环形图四块：三组按 CAT_GROUPS 成员相加，「其他品类」= 100 - 其余三组，所以四块永远正好一圈 */
  function group(rows, exportAmt) {
    var buckets = CAT_GROUPS.map(function (g) {
      var pct = rows.filter(function (r) { return g.group.indexOf(r.name) >= 0; })
        .reduce(function (s, r) { return s + r.pct; }, 0);
      return { name: g.name, color: g.color, pct: round(pct, 1) };
    });
    var rest = buckets[1];
    rest.pct = round(100 - buckets.filter(function (b) { return b !== rest; })
      .reduce(function (s, b) { return s + b.pct; }, 0), 1);
    buckets.forEach(function (b) {
      b.amt = round(exportAmt * b.pct / 100, 2);
    });
    return buckets;
  }

  function buildMonths() {
    var y = state.province.all / 12, c = state.cityAll / 12;
    return {
      province: SEASON.province.map(function (k) { return round(y * k, 1); }),
      city: SEASON.city.map(function (k) { return round(c * k, 1); })
    };
  }

  /* screen2 取到 /api/trade/region?adcode=350000 之后调用这里；单位统一为亿元 */
  function applyRegion(raw) {
    if (!raw || !raw.cities) throw new Error('regions.json 缺少 350000 城市数据');
    state.cities = Object.keys(raw.cities).map(function (k) {
      var c = raw.cities[k];
      if (c.amt[1] + c.amt[2] !== c.amt[0]) throw new Error(c.name + ' 出口+进口 ≠ 进出口总额');
      return { adcode: +k, name: c.name, all: c.amt[0], export: c.amt[1], import: c.amt[2] };
    });
    var sum = [0, 1, 2].map(function (i) {
      return state.cities.reduce(function (s, c) { return s + c[['all', 'export', 'import'][i]]; }, 0);
    });
    if (sum[0] !== raw.amt[0]) throw new Error('城市金额之和 ≠ 全省金额（' + sum[0] + ' vs ' + raw.amt[0] + '）');
    state.province = { all: raw.amt[0], export: raw.amt[1], import: raw.amt[2] };
    state.rawCities = raw.cities;
    var top = byCode(TOP_CITY) || state.cities[0];
    state.cityAdcode = top.adcode;
    state.cityAll = top.all;
    var cats = buildCats(raw.exports, raw.amt[1]);
    state.catShare = cats.share;
    state.catTable = cats.table;
    /* 分品类的季节系数缺一个就当场报错：宁可挂横幅，也不要某个月悄悄退回「占比恒定」 */
    state.catSeason = {};
    var season = raw.exports_season || [];
    (raw.exports || []).forEach(function (p) {
      var s = season.filter(function (q) { return q[0] === p[0]; })[0];
      if (!s || !s[1] || s[1].length !== SEASON.province.length) throw new Error('regions.json 缺品类季节系数：' + p[0]);
      state.catSeason[p[0]] = s[1];
    });
    state.catMonthly = SEASON.province.map(function (k, i) { return monthCats(i); });
    state.monthSeries = buildMonths();
    /* 三条 KPI 存「底数」而不是死值：kpiList(i) 才能按同一算式摊到某个月 */
    state.kpiBase = [
      { label: '福建省进出口贸易总额', src: state.province, key: 'all' },
      { label: top.name + '出口贸易总额', src: top, key: 'export' },
      { label: top.name + '进口贸易总额', src: top, key: 'import' }
    ];
    state.loaded = true;
    return FJ;
  }

  /* 图层数据：供应链主体与产业带各自一份文件，缺城市就显示「未覆盖」 */
  function applySupply(doc) {
    if (!doc || !doc.cities) throw new Error('data/supply.json 缺 cities');
    state.supply = doc;
    var missing = state.cities.filter(function (c) { return !doc.cities[c.adcode]; });
    if (missing.length) throw new Error('supply.json 缺城市：' + missing.map(function (c) { return c.name; }).join('、'));
    return FJ;
  }
  function applyChains(items) {
    state.chains = items || [];
    return FJ;
  }

  function ranking(tab) {
    var key = TABS[tab] ? tab : 'all';
    return state.cities.slice().sort(function (a, b) { return b[key] - a[key]; });
  }

  /* 月度回放：某市某月 = 该市年额 / 12 × 季节系数，与 buildMonths 同一条算式（不另造系数、不掺随机）。
     厦门市用 SEASON.city —— 就是右侧金线那条，所以地图上厦门的月值和曲线上的点必须一字不差；
     其余城市没有自己的季节形状，用全省系数 SEASON.province，口径写在地图左下角那行标注里。
     peak 取「九个城市八个月里最大的那一个」，光柱高度按它归一：回放时谁高谁矮永远严格按当月金额排。 */
  function seasonK(i) { return SEASON.province[i]; }
  function seasonKFor(adcode, i) { return adcode === TOP_CITY ? SEASON.city[i] : SEASON.province[i]; }
  function monthVal(c, key, i) { return round(c[key] / 12 * seasonKFor(c.adcode, i), 1); }
  function monthRank(tab, i) {
    var key = TABS[tab] ? tab : 'all';
    var items = state.cities.map(function (c) { return { adcode: c.adcode, name: c.name, v: monthVal(c, key, i) }; })
      .sort(function (a, b) { return b.v - a.v; });
    var peak = 0;
    state.cities.forEach(function (c) {
      for (var m = 0; m < SEASON.province.length; m++) {
        var v = monthVal(c, key, m);
        if (v > peak) peak = v;
      }
    });
    return { key: key, peak: peak, items: items };
  }

  /* 回放某月时整屏的钱要一起换月，否则地图在呼吸、旁边的数字却冻在全年。
     三条都还是同一条算式（年额÷12×当月系数），不引入新数据：
     全省品类走 SEASON.province，厦门那两条 KPI 走 SEASON.city（与曲线金线同一条）。 */
  function kpiList(i) {
    return state.kpiBase.map(function (b) {
      return { label: b.label, unit: UNIT, value: i == null ? b.src[b.key] : kpiMonthVal(b, i) };
    });
  }
  /* 出口/进口各自取整之后必须还等于该市当月总额，否则「271 + 327 = 598」会和地图上厦门那根光柱的
     597 当场打架。所以进口用「当月总额 - 当月出口」倒推，只让最后一项吃进那 0.1 的舍入差。 */
  function kpiMonthVal(b, i) {
    if (b.key !== 'import') return monthVal(b.src, b.key, i);
    return round(monthVal(b.src, 'all', i) - monthVal(b.src, 'export', i), 1);
  }
  /* 品类占比按月怎么走：regions.json 的 exports_season 给六个品类各一条八个月的季节系数（同样是示例数据），
     当月占比 = 原始占比 × 该品类当月系数，再连同「未列名的其他出口」（按系数 1）一起归一到 100%。
     系数均值取 1，所以「全年」那一栏仍是公报口径的原始占比；金额合计恒等于全省当月出口，不另造总量。 */
  function monthCats(i) {
    var eAmt = round(state.province.export / 12 * SEASON.province[i], 1);
    var listed = state.catTable.reduce(function (s, r) { return s + r.pct; }, 0);
    var weighted = state.catTable.map(function (r) {
      var s = state.catSeason[r.name];
      return { name: r.name, pct: r.pct * (s ? s[i] : 1) };
    });
    var total = weighted.reduce(function (s, r) { return s + r.pct; }, 0) + (100 - listed);
    var rows = weighted.map(function (r) { return { name: r.name, pct: r.pct / total * 100 }; });
    return {
      share: group(rows, eAmt),
      table: rows.map(function (r) {
        var p = round(r.pct, 2);
        return { name: r.name, pct: p, amt: round(eAmt * p / 100, 2) };
      })
    };
  }
  function shareList(i) { return i == null ? state.catShare : state.catMonthly[i].share; }
  function tableList(i) { return i == null ? state.catTable : state.catMonthly[i].table; }

  function byCode(adcode) {
    for (var i = 0; i < state.cities.length; i++) if (state.cities[i].adcode === adcode) return state.cities[i];
    return null;
  }

  /* ---------- 供应链图层 ----------
     六个图层各自只读一个来源，面板上把来源写出来：没有数据源的城市显示「未覆盖」而不是补一个数 */
  var LAYER_DEFS = [
    { key: 'suppliers', label: '供应商', unit: '家', from: 'supply', src: 'data/supply.json', tag: '示例数据' },
    { key: 'factories', label: '工厂', unit: '家', from: 'supply', src: 'data/supply.json', tag: '示例数据' },
    { key: 'goods', label: '商品', unit: '%', from: 'goods', src: 'data/regions.json · 各市出口品类', tag: '示例数据' },
    { key: 'belt', label: '产业带', unit: '条', from: 'belt', src: 'data/chains.json', tag: '示例数据' },
    { key: 'logistics', label: '物流', unit: '个', from: 'logistics', src: 'data/supply.json · 物流节点', tag: '示例数据' },
    { key: 'sellers', label: '跨境卖家', unit: '个', from: 'supply', src: 'data/supply.json', tag: '示例数据' }
  ];

  function cityExports(adcode) {
    var raw = state.rawCities && state.rawCities[adcode];
    return (raw && raw.exports) || [];
  }

  function layerItems(def) {
    return state.cities.map(function (c) {
      var s = (state.supply && state.supply.cities[c.adcode]) || null;
      if (def.from === 'supply') {
        return { adcode: c.adcode, name: c.name, value: s ? s[def.key] : 0, text: s ? FJ.fmt(s[def.key]) + def.unit : '未覆盖' };
      }
      if (def.from === 'goods') {
        var ex = cityExports(c.adcode)[0];
        return { adcode: c.adcode, name: c.name, value: ex ? ex[1] : 0, text: ex ? ex[0] + ' ' + ex[1] + '%' : '未覆盖' };
      }
      if (def.from === 'belt') {
        var ch = state.chains.filter(function (x) { return String(x.adcode) === String(c.adcode); })[0];
        return { adcode: c.adcode, name: c.name, value: ch ? 1 : 0, text: ch ? ch.belt : '暂无产业带',
          sub: ch ? (ch.products || []).slice(0, 3).join('/') : '' };
      }
      var lg = (s && s.logistics) || [];
      return { adcode: c.adcode, name: c.name, value: lg.length, text: lg.length ? lg[0].name : '未覆盖',
        sub: lg.length > 1 ? '另有 ' + (lg.length - 1) + ' 个节点' : '' };
    });
  }

  function layer(key) {
    var def = LAYER_DEFS.filter(function (d) { return d.key === key; })[0];
    if (!def) return null;
    var items = layerItems(def);
    return {
      key: def.key, label: def.label, unit: def.unit, src: def.src, tag: def.tag,
      items: items,
      max: items.reduce(function (m, x) { return x.value > m ? x.value : m; }, 0),
      total: items.reduce(function (s, x) { return s + x.value; }, 0),
      covered: items.filter(function (x) { return x.value > 0; }).length
    };
  }

  var FJ = {
    province: PROVINCE,
    topCity: TOP_CITY,
    tabs: TABS,
    unit: UNIT,
    maxPillars: MAX_PILLARS,
    months: MONTHS,
    monthCursor: MONTH_CURSOR,
    season: SEASON,
    cities: function () { return state.cities; },
    totals: function () { return state.province; },
    kpis: kpiList,
    catShare: shareList,
    catTable: tableList,
    monthSeries: function () { return state.monthSeries; },
    monthName: function () { return (byCode(state.cityAdcode) || {}).name || ''; },
    loaded: function () { return state.loaded; },
    applyRegion: applyRegion,
    applySupply: applySupply,
    applyChains: applyChains,
    layerDefs: LAYER_DEFS,
    layer: layer,
    ranking: ranking,
    monthRank: monthRank,
    seasonK: seasonK,
    seasonKFor: seasonKFor,
    byCode: byCode,
    fmt: fmt,
    fmt1: fmt1,
    fmt2: fmt2
  };

  window.FJ = FJ;
})();
