/* AI 引擎：只做「数据层能支撑的推理」。每个结论都必须带 evidence（来源 + 指标 + 数值）；
   数据缺失时明确返回 gap，不允许生成没有出处的数字。 */
(function () {
  'use strict';

  var tax = null;

  function load() {
    return DS.ready().then(function () {
      if (tax) return tax;
      return API.request('ai.taxonomy', {}).then(function (r) { tax = r.data || {}; return tax; });
    });
  }

  function ev(label, value, src) {
    return { label: label, value: value, src: src };
  }
  function srcWB() { return '世界银行 NE.EXP/IMP.GNFS.CD'; }
  function srcMk(m) { return (m && m.source) || '内置示例数据'; }

  /* ---------- 自然语言解析 ---------- */
  function parse(text) {
    return load().then(function () {
      var t = String(text || '').toLowerCase();
      var out = { raw: text, cats: [], iso: null, types: [], sizes: [], unmatched: [] };
      (tax.categories || []).forEach(function (c) {
        if (c.keys.some(function (k) { return t.indexOf(String(k).toLowerCase()) >= 0; })) out.cats.push(c.cat);
      });
      Object.keys(tax.countries || {}).forEach(function (w) {
        if (t.indexOf(w.toLowerCase()) >= 0 && !out.iso) out.iso = tax.countries[w];
      });
      Object.keys(tax.types || {}).forEach(function (ty) {
        if (tax.types[ty].some(function (k) { return t.indexOf(k.toLowerCase()) >= 0; })) out.types.push(ty);
      });
      Object.keys(tax.sizes || {}).forEach(function (sz) {
        if (tax.sizes[sz].some(function (k) { return t.indexOf(k.toLowerCase()) >= 0; })) out.sizes.push(sz);
      });
      if (!out.cats.length) out.unmatched.push('商品品类');
      if (!out.iso) out.unmatched.push('目标国家');
      return out;
    });
  }

  function pickCat(mk, cats) {
    var rows = (mk && mk.cats) || [];
    for (var i = 0; i < (cats || []).length; i++) {
      var hit = rows.filter(function (c) { return c.cat === cats[i]; })[0];
      if (hit) return hit;
    }
    return null;
  }

  /* ---------- 功能二：AI 市场分析 ---------- */
  function marketReport(input) {
    var product = input.product || '', iso = input.iso;
    return parse(product + ' ' + (input.query || '')).then(function (p) {
      var cats = p.cats.length ? p.cats : (input.cats || []);
      return DS.market(iso).then(function (m) {
        var wb = TRADE.stats(iso) || {};
        var rep = {
          iso: iso, country: wb.cn || DS.name(iso), product: product,
          cats: cats, src: m.src, source: m.source, nodata: !!m.nodata, sections: []
        };
        if (m.nodata) {
          rep.gap = '世界银行未收录该经济体数据，无法生成市场分析';
          return rep;
        }
        var row = pickCat(m, cats);
        var cn = m.china || {};
        var S = rep.sections;

        S.push({
          k: 'size', t: '市场规模',
          main: row ? num(row.amount) + ' 亿美元' : '品类未收录',
          sub: row ? DS.name(iso) + '该品类自全球年度进口规模' : '该品类未进入示例口径，可切换品类或接入海关明细',
          evidence: row ? [ev(DS.name(iso) + '·品类进口额', num(row.amount) + ' 亿美元', srcMk(m)),
                           ev(DS.name(iso) + '·货物与服务进口总额', num(wb.imp) + ' 亿美元', srcWB())]
                        : [ev(DS.name(iso) + '·进口总额', num(wb.imp) + ' 亿美元', srcWB())]
        });
        S.push({
          k: 'demand', t: '进口需求',
          main: row ? '进口需求 ' + num(row.amount) + ' 亿美元 · 中国供应 ' + cnShare(row) : '—',
          sub: '需求 = 品类进口规模；中国供应份额越低，替代空间越大',
          evidence: [ev(DS.name(iso) + '·进口依赖度（进口/贸易总额）', dep(wb) + '%', srcWB())]
            .concat(row ? [ev('该品类中国供应份额', cnShare(row), srcMk(m))] : [])
        });
        S.push({
          k: 'growth', t: '市场增长趋势',
          main: row && row.yoy != null ? pct(row.yoy) : (row && row.derived ? '增速待接入' : '—'),
          sub: cn.nodata ? '双边贸易数据未收录' : '中国与该国贸易 ' + num(cn.total) + ' 亿美元，同比 ' + pct(cn.yoy),
          evidence: [ev(DS.name(iso) + '·贸易总额同比', pct(wb.yoy), srcWB())]
            .concat(!cn.nodata && cn.hist ? [ev('中国与该国 5 年贸易额', cn.hist.map(function (h) { return h.y + ':' + num(h.amt); }).join(' / '), srcMk(m))] : [])
        });
        S.push({
          k: 'china', t: '中国出口情况',
          main: cn.nodata ? '暂无双边数据' : num(cn.exp) + ' 亿美元（中国对该国出口）',
          sub: cn.nodata ? '待接入 UN Comtrade / 中国海关分国别出口明细'
                         : '占中国进出口总额 ' + (cn.shareOfChina == null ? '—' : cn.shareOfChina + '%') + '，中国自该国进口 ' + num(cn.imp) + ' 亿美元',
          evidence: [ev('中国货物与服务出口总额', num((TRADE.stats('CHN') || {}).exp) + ' 亿美元', srcWB())]
            .concat(cn.nodata ? [] : [ev('中国对该国出口', num(cn.exp) + ' 亿美元', srcMk(m))])
        });
        S.push({
          k: 'rivals', t: '主要竞争国家',
          main: row && row.suppliers && row.suppliers.length ? row.suppliers.map(function (s) { return s.cn + ' ' + s.share + '%'; }).join(' · ') : '—',
          sub: row && row.globalSuppliers ? '注意：该供应结构为全球口径，非该国分国别数据' : '按该品类自全球进口的国别份额排序',
          evidence: (row && row.suppliers ? row.suppliers : []).map(function (s) { return ev(s.cn, s.share + '%', srcMk(m)); })
        });
        S.push({
          k: 'contest', t: '市场竞争情况',
          main: row ? '前三供应国合计 ' + top3(row) + '%，' + verdict(row) : '—',
          sub: '集中度越高说明渠道越被少数供应国把持，突破成本越大；集中度越低越容易切入',
          evidence: row ? [ev('中国排名', rankOf(row) || '未进前三', srcMk(m)), ev('领先供应国份额', lead(row), srcMk(m))] : []
        });
        S.push({
          k: 'chance', t: '潜在市场机会',
          main: '', sub: '', chances: chances(m, wb, row, cats)
        });
        S.push({
          k: 'risk', t: '市场进入注意事项',
          main: '', sub: m.note || '', risks: (m.barriers || []).slice(0, 5)
        });
        if (m.src === 'derived') rep.gap = '该经济体未收录品类与双边明细，以上为按全球结构推算的量级，仅供排序参考';
        return rep;
      });
    });
  }

  function chances(m, wb, row, cats) {
    var out = [];
    if (row) {
      var cn = row.suppliers.filter(function (s) { return s.iso === 'CHN'; })[0];
      var leadS = row.suppliers[0];
      if (cn && leadS && leadS.iso !== 'CHN' && leadS.share > cn.share) {
        out.push({ text: '把订单从 ' + leadS.cn + ' 迁回中国：对方份额 ' + leadS.share + '%，中国 ' + cn.share + '%，差距 ' + (leadS.share - cn.share).toFixed(1) + ' 个百分点',
          evidence: [ev(leadS.cn + ' 份额', leadS.share + '%', srcMk(m)), ev('中国份额', cn.share + '%', srcMk(m))] });
      }
      if (row.yoy != null && row.yoy > 3) {
        out.push({ text: '需求正在扩张：该品类自全球进口同比 ' + pct(row.yoy) + '，适合提前锁定年度框架订单',
          evidence: [ev('品类进口同比', pct(row.yoy), srcMk(m))] });
      }
      if (row.yoy != null && row.yoy <= 0) {
        out.push({ text: '需求收缩（同比 ' + pct(row.yoy) + '），应以小单快返与差异化款式切入，避免压库存',
          evidence: [ev('品类进口同比', pct(row.yoy), srcMk(m))] });
      }
    }
    if (!m.china.nodata && m.china.yoy != null && m.china.yoy > 0) {
      out.push({ text: '双边大盘在涨：中国与该国贸易同比 ' + pct(m.china.yoy) + '，物流与结算通道成熟',
        evidence: [ev('双边贸易额', num(m.china.total) + ' 亿美元', srcMk(m)), ev('双边同比', pct(m.china.yoy), srcMk(m))] });
    }
    if (wb.yoy != null && wb.yoy > 0) {
      out.push({ text: '该经济体整体外贸同比 ' + pct(wb.yoy) + '（世界银行 ' + wb.year + ' 年），宏观需求有支撑',
        evidence: [ev('贸易总额同比', pct(wb.yoy), srcWB())] });
    }
    if (!out.length) out.push({ text: '现有数据不足以支撑明确机会，建议接入分国别海关明细后再判断', evidence: [] });
    return out;
  }

  /* ---------- 功能三：AI 市场机会发现 ---------- */
  function opportunities(input) {
    var q = input.query || '';
    return parse(q).then(function (p) {
      var cats = p.cats.length ? p.cats : (input.cats || []);
      var list = (input.isos || MARKET).slice();
      return Promise.all(list.map(function (iso) { return DS.market(iso); })).then(function (mks) {
        var items = [];
        mks.forEach(function (m, i) {
          if (!m || m.nodata) return;
          var row = pickCat(m, cats);
          if (!row) return;
          var wb = TRADE.stats(list[i]) || {};
          var cn = (row.suppliers || []).filter(function (s) { return s.iso === 'CHN'; })[0];
          var leadS = (row.suppliers || [])[0];
          var gap = cn && leadS && leadS.iso !== 'CHN' ? leadS.share - cn.share : 0;
          var reasons = [];
          if (row.yoy != null) reasons.push({ t: '需求增长：该品类自全球进口同比 ' + pct(row.yoy), e: ev('品类进口同比', pct(row.yoy), srcMk(m)) });
          if (gap > 0) reasons.push({ t: '份额可夺：' + leadS.cn + ' ' + leadS.share + '% 领先中国 ' + cn.share + '%，差 ' + gap.toFixed(1) + ' 个百分点', e: ev('领先国与中国份额差', gap.toFixed(1) + ' pt', srcMk(m)) });
          if (row.amount) reasons.push({ t: '市场体量：' + DS.name(list[i]) + '该品类年进口 ' + num(row.amount) + ' 亿美元', e: ev('品类进口规模', num(row.amount) + ' 亿美元', srcMk(m)) });
          if (!cn) reasons.push({ t: '中国尚未进入该品类前三供应国，属空白市场', e: ev('中国份额', '未进前三', srcMk(m)) });
          items.push({
            iso: list[i], cn: DS.name(list[i]), cat: row.cat,
            demand: num(row.amount) + ' 亿美元', growth: row.yoy == null ? '待接入' : pct(row.yoy),
            competition: (row.suppliers || []).map(function (s) { return s.cn + ' ' + s.share + '%'; }).join(' / ') || '—',
            score: (row.yoy || 0) * 2 + gap + Math.min(row.amount / 100, 8),
            reasons: reasons, src: m.src, risks: (m.barriers || []).slice(0, 2)
          });
        });
        items.sort(function (a, b) { return b.score - a.score; });
        return { parsed: p, cats: cats, items: items.slice(0, input.limit || 6) };
      });
    });
  }

  /* ---------- 功能五：AI 找客户（解析 + 过滤） ---------- */
  function findCustomers(input) {
    return parse(input.query || '').then(function (p) {
      var f = {
        iso: p.iso || input.iso || null,
        products: p.cats.length ? p.cats : (input.cats || []),
        types: p.types.length ? p.types : (input.types || []),
        sizes: p.sizes.length ? p.sizes : (input.sizes || []),
        limit: input.limit || 12
      };
      return DS.customers(f).then(function (r) {
        return { parsed: p, filter: f, items: r.items, total: r.total, meta: r.meta };
      });
    });
  }

  /* ---------- 功能四：AI 客户画像（由客户库聚合，不虚构） ---------- */
  function profiles(input) {
    return findCustomers({ query: (input.product || '') + ' ' + (input.country || '') + ' ' + (input.query || ''), limit: 60 }).then(function (r) {
      var byType = {};
      r.items.forEach(function (c) {
        c.types.forEach(function (t) {
          var g = byType[t] || (byType[t] = { type: t, n: 0, sizes: {}, employees: 0, annual: 0, needs: [], traits: [], pains: [], samples: [] });
          g.n++; g.sizes[c.size] = (g.sizes[c.size] || 0) + 1;
          g.employees += c.employees || 0; g.annual += c.annualPurchase || 0;
          if (g.needs.indexOf(c.needs) < 0) g.needs.push(c.needs);
          if (g.traits.indexOf(c.traits) < 0) g.traits.push(c.traits);
          if (g.pains.indexOf(c.pains) < 0) g.pains.push(c.pains);
          if (g.samples.length < 2) g.samples.push(c.name);
        });
      });
      return { parsed: r.parsed, total: r.total, profiles: Object.keys(byType).map(function (k) {
        var g = byType[k];
        g.sizeMix = Object.keys(g.sizes).map(function (s) { return s + ' ' + g.sizes[s] + ' 家'; }).join(' / ');
        g.avgEmployees = g.n ? Math.round(g.employees / g.n) : 0;
        g.avgAnnual = g.n ? Math.round(g.annual / g.n) : 0;
        return g;
      }).sort(function (a, b) { return b.n - a.n; }) };
    });
  }

  /* ---------- 功能六：AI 开发信（客户事实全部取自客户库，能力自述留占位待人工确认） ---------- */
  function usd(wan) {
    var v = (wan || 0) * 10000;
    return v >= 1e6 ? 'USD ' + (v / 1e6).toFixed(1) + 'M' : 'USD ' + Math.round(v / 1e3) + 'K';
  }

  function letterSlots(c, product, lang) {
    var zh = lang === 'zh';
    var wb = TRADE.stats(c.iso) || {};
    var en = lang !== 'zh';
    var gloss = (tax.gloss || {});
    var miss = [];
    var lines = en ? ((gloss.cat || {})[c.industry] || (miss.push('产品线'), c.products.join(', ')))
                   : c.products.join('、');
    var types = en ? c.types.map(function (t) { return (gloss.type || {})[t] || (miss.push('客户类型'), t); }).join(', ')
                   : c.types.join('/');
    var size = en ? ((gloss.size || {})[c.size] || c.size) : c.size;
    return {
      cust: c.name + (zh && c.cn ? '（' + c.cn + '）' : ''),
      country: zh ? (c.countryCn || DS.name(c.iso)) : (wb.en || c.countryCn || DS.name(c.iso)),
      city: c.city, lines: lines, types: types, size: size,
      emp: c.employees || '—', annual: c.annualPurchase || '—', annualUsd: usd(c.annualPurchase),
      our: en && (gloss.cat || {})[product] ? (gloss.cat || {})[product] : product,
      needs: c.needs, pains: c.pains, traits: c.traits, website: c.website,
      untranslated: en ? miss : []
    };
  }

  var LETTERS = {
    zh: function (s) {
      return {
        subject: s.cust + ' · ' + s.our + ' 供应方案',
        body: '致 ' + s.cust + ' 采购负责人：\n\n'
          + '我们是中国 ' + s.our + ' 供应商。了解到贵公司位于 ' + s.city + '、' + s.country
          + '，主营 ' + s.lines + '，客户类型为' + s.types + '（' + s.size + '，约 ' + s.emp
          + ' 人，年采购规模约 ' + s.annual + ' 万美元）。\n\n'
          + '贵司的采购节奏是：' + s.needs + '；' + s.pains + '。\n'
          + '针对这两点，我们可在专属开发、快速打样与小单起订上配合（具体【起订量】【打样周期】【产能】以我方确认为准）。\n\n'
          + '是否可以先寄一组样品并附上最新报价单？也可安排视频看厂。\n\n'
          + '顺祝商祺\n【公司名称】 · 【联系人】 · 【邮箱】 · WhatsApp【WhatsApp】'
      };
    },
    en: function (s) {
      return {
        subject: 'Supplier proposal for ' + s.lines + ' - ' + s.our,
        body: 'Dear purchasing team at ' + s.cust + ',\n\n'
          + 'We are a China-based ' + s.our + ' supplier. ' + s.cust + ' is recorded as a ' + s.types
          + ' in ' + s.city + ', ' + s.country + ', sourcing ' + s.lines
          + ' - ' + s.size + ' company, about ' + s.emp + ' staff, purchase volume around ' + s.annualUsd + ' a year.\n\n'
          + 'We can support dedicated development, fast sampling and low starting quantities'
          + ' ([MOQ] / [sample lead time] / [capacity] to be confirmed on our side).\n\n'
          + 'May we send a sample set with the current price list for the styles you are sourcing now? A video factory tour can also be arranged.\n\n'
          + 'Best regards,\n[Company] · [Contact] · [Email] · WhatsApp [Number]'
      };
    },
    es: function (s) {
      return {
        subject: 'Propuesta de proveedor de ' + s.our + ' para ' + s.cust,
        body: 'Estimado equipo de compras de ' + s.cust + ',\n\n'
          + 'Somos proveedores de ' + s.our + ' con base en China. ' + s.cust
          + ' es ' + s.types + ' en ' + s.city + ', ' + s.country + ', con linea de producto ' + s.lines
          + ' - tamano ' + s.size + ', ~' + s.emp + ' empleados, volumen anual de ' + s.annualUsd + '.\n\n'
          + 'Podemos ofrecer desarrollo exclusivo, muestreo rapido y cantidades iniciales bajas'
          + ' ([MOQ] / [plazo de muestra] / [capacidad] por confirmar).\n\n'
          + 'Podemos enviar una muestra y la lista de precios actualizada?\n\n'
          + 'Saludos cordiales,\n[Empresa] · [Contacto] · [Correo] · WhatsApp [Numero]'
      };
    },
    de: function (s) {
      return {
        subject: 'Angebotsmappe ' + s.our + ' fuer ' + s.cust,
        body: 'Sehr geehrtes Einkaufsteam von ' + s.cust + ',\n\n'
          + 'wir sind Lieferant fuer ' + s.our + ' mit Sitz in China. ' + s.cust + ' ist als ' + s.types
          + ' in ' + s.city + ', ' + s.country + ' taetig; Produktsortiment: ' + s.lines
          + ' - Unternehmensgroesse ' + s.size + ', ca. ' + s.emp + ' Mitarbeitende, Jahresvolumen ca. ' + s.annualUsd + '.\n\n'
          + 'Wir unterstuetzen Eigenentwicklung, schnelle Musterung und kleine Startmengen'
          + ' ([MOQ] / [Musterzeit] / [Kapazitaet] noch zu bestaetigen).\n\n'
          + 'Durfen wir Ihnen Muster und die aktuelle Preisliste senden?\n\n'
          + 'Mit freundlichen Griessen\n[Firma] · [Ansprechpartner] · [E-Mail] · WhatsApp [Nummer]'
      };
    },
    ja: function (s) {
      return {
        subject: s.cust + ' 様へ ' + s.our + ' ご提案',
        body: s.cust + ' 購買ご担当者様\n\n'
          + '中国を拠点に ' + s.our + ' を手掛けるメーカーでございます。' + s.city + '（' + s.country
          + '）にて ' + s.types + ' として ' + s.lines + ' を展開されております（' + s.size
          + '、従業員約 ' + s.emp + ' 名、年間仕入規模 約 ' + s.annualUsd + '）。\n\n'
          + '専用開発・高速サンプル対応・小ロット発注にご対応可能です（[MOQ]・[サンプル納期]・[生産能力] は弊社確認事項）。\n\n'
          + 'サンプルと最新価格表をお送りしてもよろしいでしょうか。\n\n'
          + '何卒よろしくお願い申し上げます。\n[会社名] · [担当者] · [メール] · WhatsApp [番号]'
      };
    }
  };

  function offerLetter(input) {
    var lang = LETTERS[input.lang] ? input.lang : 'zh';
    return load().then(function () { return DS.customer(input.customerId); }).then(function (c) {
      if (!c) return { error: '客户库中未找到该记录，无法生成开发信' };
      var s = letterSlots(c, input.product || c.industry, lang);
      var t = LETTERS[lang](s);
      return {
        lang: lang, langs: Object.keys(LETTERS), subject: t.subject, body: t.body,
        customer: c.name, customerId: c.id, slots: s,
        fields: [
          { label: '公司名称/国家/城市', value: c.name + ' · ' + (c.countryCn || '') + ' · ' + c.city, src: 'data/customers.json' },
          { label: '产品线与行业', value: c.products.join('、') + ' / ' + c.industry, src: 'data/customers.json' },
          { label: '客户类型/规模', value: c.types.join('/') + ' · ' + c.size + ' · 约 ' + c.employees + ' 人', src: 'data/customers.json' },
          { label: '年采购规模', value: (c.annualPurchase || '—') + ' 万美元', src: 'data/customers.json（字段口径对齐海关/CRM 服务商）' },
          { label: '采购需求/痛点', value: lang === 'zh' ? (c.needs + '；' + c.pains) : '仅中文口径，未写入非中文正文', src: 'data/customers.json' }
        ],
        untranslated: s.untranslated,
        notice: '正文中的能力自述（专属开发/快反/小单）为通用模板句式，发送前须按贵司实际核对；客户事实字段全部取自数据层，未虚构。'
      };
    });
  }

  /* ---------- 功能七：AI 获客方案（30 天计划，任务量由客户库与市场数据推导） ---------- */
  function plan30(input) {
    input = input || {};
    var q = [input.product || '', input.country || '', (input.types || []).join(' ')].filter(Boolean).join(' ');
    return findCustomers({ query: q, limit: 500 }).then(function (r) {
      var iso = r.parsed.iso || input.iso || null;
      var cat = (r.parsed.cats || [])[0] || (input.cats || [])[0] || '';
      return DS.market(iso || 'USA').then(function (m) {
        var row = pickCat(m, [cat]);
        var wb = TRADE.stats(iso) || {};
        var items = r.items || [];
        var byStatus = {};
        items.forEach(function (c) { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
        var fresh = byStatus['未接触'] || 0;
        var first = Math.ceil(items.length / 2), second = items.length - first;
        var e = [];
        if (row) e.push(ev(DS.name(iso || 'USA') + '·' + row.cat + ' 进口规模', num(row.amount) + ' 亿美元', srcMk(m)));
        if (row && row.yoy != null) e.push(ev('品类进口同比', pct(row.yoy), srcMk(m)));
        if (wb.total != null) e.push(ev('该经济体贸易总额', num(wb.total) + ' 亿美元（' + wb.year + '）', srcWB()));
        e.push(ev('客户库匹配', items.length + ' 家（其中未接触 ' + fresh + ' 家）', 'data/customers.json'));
        return {
          product: input.product || cat, iso: iso, country: iso ? DS.name(iso) : '未指定（全球）',
          types: r.parsed.types.length ? r.parsed.types : (input.types || []),
          customers: items.length, fresh: fresh, byStatus: byStatus, src: m.src,
          headline: row ? '目标市场 ' + DS.name(iso || 'USA') + ' 的 ' + row.cat + ' 年进口 ' + num(row.amount)
                          + ' 亿美元，中国供应份额 ' + cnShare(row) : '品类未收录，计划按客户库规模排期',
          evidence: e,
          weeks: [
            { w: 1, range: 'D1-D7', theme: '市场口径与素材准备', tasks: [
              { ch: '数据', act: '锁定 ' + (iso ? DS.name(iso) : '目标市场') + ' ' + (cat || '品类') + ' 口径：需求 ' + (row ? num(row.amount) + ' 亿美元' : '待接入') + '，供应结构 ' + (row ? cnShare(row) : '—') + '，输出一页纸', kpi: '一页纸 1 份' },
              { ch: '内容', act: '按客户共性痛点拍摄 ' + (items.length ? Math.max(6, Math.ceil(items.length / 4)) : 6) + ' 条产线/打样短视频素材', kpi: '素材 ≥ 6 条' },
              { ch: '渠道', act: 'TikTok / Instagram / LinkedIn 主页装修 + 开发信模板（中/英）', kpi: '三平台主页与 2 语模板上线' }
            ] },
            { w: 2, range: 'D8-D14', theme: '首轮冷启动触达', tasks: [
              { ch: '邮件', act: '首轮开发信 ' + first + ' 家（优先状态为「未接触」的 ' + fresh + ' 家）', kpi: '回复 ≥ ' + Math.max(2, Math.round(first * 0.08)) + ' 家' },
              { ch: 'LinkedIn', act: '加同类买家/采购 ' + second + ' 位，附产线短视频', kpi: '通过率 ≥ 30%' },
              { ch: '内容', act: 'TikTok / Instagram 每周 3 条：产品细节 + 产线 + 客户案例', kpi: '单条播放 ≥ 2000' }
            ] },
            { w: 3, range: 'D15-D21', theme: '意向转化与寄样', tasks: [
              { ch: '邮件', act: '未回复客户第二轮，换角度（' + (row && row.yoy != null && row.yoy > 0 ? '需求增长期锁年度框架单' : '小单快反降低试错成本') + '）', kpi: '寄样 ≥ ' + Math.max(3, Math.round(items.length * 0.3)) + ' 家' },
              { ch: '跟进', act: '视频看厂 + 报价，样品反馈 48 小时内回收', kpi: '有效报价 ≥ 8 份' },
              { ch: '内容营销', act: '把首轮回复里被问最多的问题做成 1 篇长文/1 条深度视频', kpi: '自然流量询盘 ≥ 3 条' }
            ] },
            { w: 4, range: 'D22-D30', theme: '复盘与放量', tasks: [
              { ch: '数据复盘', act: '拆渠道漏斗：曝光 → 询盘 → 寄样 → 报价 → 成交，找出单条成本最低的渠道', kpi: '渠道 ROI 表 1 份' },
              { ch: '放量', act: '回复率最高的两条内容转常规投放；扩充 ' + (cat || '品类') + ' 关联关键词再跑一轮客户', kpi: '询盘环比 ≥ +30%' },
              { ch: '跟进', act: '已报价客户分层（A 类寄样后 7 天内二次跟进）', kpi: 'A 类客户跟进覆盖率 100%' }
            ] }
          ],
          review: [
            { metric: '开发信回复率', target: '≥ 8%', from: '任务量按客户库 ' + items.length + ' 家推导' },
            { metric: '寄样转化', target: '≥ 30%', from: '第 3 周任务 KPI' },
            { metric: '渠道单询盘成本', target: '次轮复盘后设定', from: '第 4 周 ROI 表' },
            { metric: '市场容量是否支撑放量', target: (row ? num(row.amount) + ' 亿美元' : '待接入'), from: srcMk(m) }
          ],
          notice: 'KPI 目标值为通用基准，需用贵司历史数据校准；客户数量、市场规模与供应份额来自数据层，未虚构。'
        };
      });
    });
  }

  /* ---------- 功能八：中国供应链与海外市场连接（地区 → 产业带 → 市场 → 客户 → 打法） ---------- */
  function chainView(input) {
    input = input || {};
    return DS.chains(input.adcode).then(function (list) {
      if (!list.length) return { nodata: true, adcode: input.adcode };
      var ch = list.filter(function (c) { return c.id === input.id; })[0] || list[0];
      var iso = input.iso || (ch.markets[0] || {}).iso;
      var f = ch.customerFilter || {};
      return Promise.all([DS.market(iso), DS.customers({
        iso: iso, products: f.products, types: f.types, sizes: f.sizes, limit: 6
      })]).then(function (a) {
        var m = a[0] || {}, row = pickCat(m, f.products || []);
        return {
          chain: ch, adcode: ch.adcode, iso: iso, country: DS.name(iso),
          demand: row ? num(row.amount) + ' 亿美元' : '—',
          growth: row && row.yoy != null ? pct(row.yoy) : '待接入',
          cnShare: row ? cnShare(row) : '—',
          competition: row ? (row.suppliers || []).map(function (s) { return s.cn + ' ' + s.share + '%'; }).join(' / ') : '—',
          total: TRADE.stats(iso) || {},
          customers: a[1].items, custTotal: a[1].total, src: m.src, source: m.source
        };
      });
    });
  }

  /* ---------- 工具 ---------- */
  function num(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function pct(n) { return n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%'; }
  function dep(wb) { return wb && wb.total ? (wb.imp / wb.total * 100).toFixed(1) : '—'; }
  function cnShare(row) {
    var cn = (row.suppliers || []).filter(function (s) { return s.iso === 'CHN'; })[0];
    return cn ? cn.share + '%' : '未进前三';
  }
  function top3(row) {
    return (row.suppliers || []).slice(0, 3).reduce(function (a, s) { return a + s.share; }, 0).toFixed(1);
  }
  function lead(row) {
    var s = (row.suppliers || [])[0];
    return s ? s.cn + ' ' + s.share + '%' : '—';
  }
  function verdict(row) {
    var t = parseFloat(top3(row));
    return t >= 70 ? '高度集中，渠道被少数供应国把持' : t >= 45 ? '中度集中，需靠差异化切入' : '结构分散，最容易切入';
  }
  function rankOf(row) {
    var i = (row.suppliers || []).findIndex ? (row.suppliers || []).findIndex(function (s) { return s.iso === 'CHN'; }) : -1;
    return i >= 0 ? '第 ' + (i + 1) + ' 位' : '';
  }

  var MARKET = ['USA', 'DEU', 'JPN', 'GBR', 'KOR', 'VNM', 'IND', 'IDN', 'MYS', 'THA', 'AUS', 'NLD', 'FRA', 'CAN', 'MEX', 'BRA', 'RUS', 'ARE', 'ITA'];

  window.AI = {
    parse: parse,
    marketReport: marketReport,
    opportunities: opportunities,
    findCustomers: findCustomers,
    profiles: profiles,
    offerLetter: offerLetter,
    plan30: plan30,
    chain: chainView,
    chains: function () { return DS.chains(); },
    markets: function () { return MARKET.slice(); },
    num: num, pct: pct
  };
})();
