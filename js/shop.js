/* 第四屏 AI 店铺引擎（window.SHOP）。
   规则：页面不写任何业务数字；AI 结论必须能回溯到本地数据库 data/app.db 的某一行（或数据层指标），
   每条结论带 evidence + src（db=库里某一行，derived=按公开公式算出，mock=模板口径，gap=待人工补）；
   无法核实的表述一律用【】占位交给用户填。
   所有能力同时注册进 API.ai，切换 http provider 后由后端 / Dify 工作流接管。 */
(function () {
  'use strict';

  var tax = null;
  function load() {
    if (!tax) tax = API.request('ai.taxonomy', {}).then(function (r) { return r.data || {}; });
    return tax;
  }

  function ev(label, value, src) { return { label: label, value: value, src: src || 'db' }; }
  function n1(v) { return Math.round(v * 10) / 10; }
  function sum(a) { return a.reduce(function (x, y) { return x + y; }, 0); }
  function avg(a) { return a.length ? sum(a) / a.length : 0; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ============ 1. 消息意图与话题识别 ============
     中文词与 tools/cs-ops.mjs 那份词典同步（2026-09-28 起客服会话原文是中文）：
     少一边就会让「客户行为分析」的主题分布整片塌成「其他咨询」。 */
  var TOPICS = [
    { k: '下单意向', w: 34, re: /(buy|order|checkout|purchase|i want|take it|\bhold\b|reserve|kaufen|bestellen|comprar|pedir|voy a comprar|購入|注文|します|reserv|下单|订货|订购|要买|成交|付款)/i },
    { k: '批量与样品', w: 22, re: /(bulk|wholesale|\bmoq\b|sample|muster|muestra|サンプル|社販|distributor|private label|logo|invoice|請求書|units|\d+\s*台|[一二两三四五六七八九十]\s*台|采购|批量|起订|样品|拿样|贴牌|分销)/i },
    { k: '物流时效', w: 14, re: /(ship|shipping|deliver|delivery|arrive|track|courier|customs|\bduty\b|warehouse|versand|liefer|zoll|env[ií]o|entrega|aduana|tarda|almac[né]n|納期|配送|届|在庫|stock|restock|po box|发货|到货|送达|运输|时效|快递|清关|关税|物流|到港|库存|补货|运费|几天)/i },
    { k: '售后保障', w: 8, re: /(warranty|return|refund|broken|replace|defect|guarantee|garantie|r[iü]ckgabe|devolv|garant[ií]a|保証|返品|stops charging|firmware|drifts|保修|退货|退款|换货|坏了|故障|固件)/i },
    { k: '价格折扣', w: 10, re: /(price|cost|cheap|discount|coupon|\bdeal\b|rabatt|preis|precio|descuento|barato|割引|価格|高い|% off|价格|多少钱|报价|折扣|优惠|便宜|降价|单价)/i },
    { k: '参数与兼容', w: 6, re: /(compatible|work with|works with|does it|iphone|android|battery|waterproof|ipx|\bsize\b|\bfit\b|version|spec|akku|kompatibel|gr[oö]+e|tamaño|servicio|downgrade|desktop|funda|対応|サイズ|機能|手首|持ち込|機内|wh\b|calor|兼容|适配|尺寸|规格|参数|防水|电池|续航|型号|版本|蓝牙)/i }
  ];

  function classify(text) {
    var hits = TOPICS.filter(function (t) { return t.re.test(text); });
    hits.sort(function (a, b) { return b.w - a.w; });
    return { topics: hits.map(function (t) { return t.k; }), primary: hits.length ? hits[0].k : '其他咨询', weight: hits };
  }

  /* 话题中文名之外还要能对客户说，转人工话术会引用 */
  var TOPIC_L10N = {
    '下单意向': { en: 'orders', de: 'Bestellungen', es: 'pedidos' },
    '批量与样品': { en: 'wholesale and samples', de: 'Großhandel und Muster', es: 'volumen y muestras' },
    '物流时效': { en: 'shipping', de: 'Versand', es: 'envíos' },
    '售后保障': { en: 'after-sales', de: 'Gewährleistung', es: 'postventa' },
    '价格折扣': { en: 'pricing', de: 'Preise', es: 'precios' },
    '参数与兼容': { en: 'specs and compatibility', de: 'Technische Daten', es: 'especificaciones' },
    '其他咨询': { en: 'general questions', de: 'allgemeine Fragen', es: 'consultas generales' }
  };

  /* ============ 2. 客户洞察：行为事件 + 会话 → 兴趣度 / 购买意向 / 阶段 ============ */
  var ACT = { view: '浏览商品页', dwell: '页面停留', click: '点击主图/规格', favorite: '加入收藏', cart: '加入购物车', chat: '发起客服咨询', purchase: '完成下单' };

  function tallyEvents(rows) {
    var t = { view: 0, dwell: 0, click: 0, favorite: 0, cart: 0, chat: 0, purchase: 0, sec: 0, pids: {}, last: '' };
    rows.forEach(function (e) {
      t[e.type] = (t[e.type] || 0) + 1;
      if (e.sec) { t.sec += e.sec; }
      if (e.pid) { t.pids[e.pid] = (t.pids[e.pid] || 0) + 1; }
      if (e.at > t.last) t.last = e.at;
    });
    return t;
  }

  function buildInsight(chat, rows, products) {
    var t = tallyEvents(rows);
    var custMsgs = chat.msgs.filter(function (m) { return m.from === 'customer'; });
    var topicCount = {};
    custMsgs.forEach(function (m) {
      var c = classify(m.text);
      c.topics.forEach(function (k) { topicCount[k] = (topicCount[k] || 0) + 1; });
    });
    var dwellMin = t.sec / 60;
    var interest = clamp(18 + t.view * 6 + t.click * 5 + t.favorite * 8 + t.cart * 10 + dwellMin * 4 + custMsgs.length * 5, 0, 99);
    var intentWeight = custMsgs.reduce(function (acc, m) {
      var c = classify(m.text);
      return acc + (c.weight[0] ? c.weight[0].w : 0) * 0.45;
    }, 0);
    var buy = clamp(6 + intentWeight + t.cart * 16 + t.favorite * 7 + t.purchase * 40, 0, 99);
    var stage = t.purchase ? '已成交客户' : buy >= 62 ? '高意向客户' : buy >= 38 ? '对比评估中' : '初步了解';
    var priceHits = topicCount['价格折扣'] || 0;
    var priceSens = custMsgs.length ? priceHits / custMsgs.length : 0;
    var focus = Object.keys(t.pids).sort(function (a, b) { return t.pids[b] - t.pids[a]; }).slice(0, 3)
      .map(function (pid) {
        var p = products.filter(function (x) { return x.id === pid; })[0];
        return { id: pid, name: p ? p.name : pid, hits: t.pids[pid], price: p ? p.price : null };
      });
    var topics = Object.keys(topicCount).map(function (k) {
      return { k: k, n: topicCount[k], share: +(topicCount[k] / Math.max(1, custMsgs.length) * 100).toFixed(0) };
    }).sort(function (a, b) { return b.n - a.n; });

    return {
      id: chat.id, cust: chat.cust, name: chat.name, cn: chat.cn, iso: chat.iso,
      countryCn: DS.name(chat.iso), city: chat.city, flag: chat.flag, channel: chat.channel,
      since: chat.since, state: chat.state, unread: chat.unread, lastAt: chat.msgs.length ? chat.msgs[chat.msgs.length - 1].at : '',
      interest: Math.round(interest), buy: Math.round(buy), stage: stage,
      dwellSec: t.sec, dwellText: Math.floor(t.sec / 60) + '分' + (t.sec % 60) + '秒',
      counts: { view: t.view, click: t.click, favorite: t.favorite, cart: t.cart, chat: custMsgs.length, purchase: t.purchase },
      topics: topics, focus: focus,
      priceSens: priceSens >= 0.34 ? '高' : priceSens >= 0.15 ? '中' : '低',
      priceSensShare: Math.round(priceSens * 100),
      evidence: [
        ev('浏览 / 点击 / 收藏 / 加购', t.view + ' / ' + t.click + ' / ' + t.favorite + ' / ' + t.cart + '（events of 客户 ' + chat.cust + '）'),
        ev('累计页面停留', Math.floor(t.sec / 60) + ' 分 ' + (t.sec % 60) + ' 秒', 'db'),
        ev('客户消息条数', custMsgs.length + ' 条（messages where sender=customer）'),
        ev('咨询话题', topics.length ? topics.map(function (x) { return x.k + ' ' + x.n + ' 次'; }).join('、') : '无', 'derived'),
        ev('订单行为', t.purchase ? '已下单 ' + t.purchase + ' 次' : '未下单', 'db')
      ],
      formula: '兴趣度 = 18 + 浏览×6 + 点击×5 + 收藏×8 + 加购×10 + 停留分钟×4 + 消息条数×5；' +
               '购买意向 = 6 + 话题权重×0.45 + 加购×16 + 收藏×7 + 下单×40（封顶 99）'
    };
  }

  function withAnalysis(rows) {
    return rows.reduce(function (acc, r) {
      var c = classify(r.text);
      r.analysis = {
        intent: c.primary, topics: c.topics,
        interest: clamp(Math.round(40 + c.topics.length * 12), 0, 99),
        buy: clamp(Math.round(6 + (c.weight[0] ? c.weight[0].w : 0) * 2.2), 0, 99),
        suggest: c.primary === '下单意向' ? '建议立刻跟进并锁定库存' :
                 c.primary === '物流时效' ? '建议给出仓源与到货区间' :
                 c.primary === '批量与样品' ? '建议转人工报价并留联系方式' :
                 c.primary === '售后保障' ? '建议先给保障政策再谈价' :
                 c.primary === '价格折扣' ? '建议用参数对比支撑价格' :
                 c.primary === '参数与兼容' ? '建议直接给参数与适配结论' : '建议人工确认诉求'
      };
      acc.push(r); return acc;
    }, []);
  }

  function topicMix(chats, day) {
    var count = {}, total = 0;
    (chats || []).forEach(function (c) {
      (c.msgs || []).forEach(function (m) {
        if (m.from !== 'customer') return;
        if (day && m.at.slice(0, 5) !== day) return;
        var k = classify(m.text).primary;
        count[k] = (count[k] || 0) + 1; total++;
      });
    });
    return Object.keys(count).map(function (k) {
      return { k: k, n: count[k], share: total ? Math.round(count[k] / total * 100) : 0, total: total };
    }).sort(function (a, b) { return b.n - a.n; });
  }

  function chatsInsight() {
    return Promise.all([DS.chats(), DS.events(), DS.products()]).then(function (r) {
      var chats = r[0].items, events = r[1].items, products = r[2].items;
      return chats.map(function (c) {
        var rows = events.filter(function (e) { return e.cust === c.cust; });
        var ins = buildInsight(c, rows, products);
        ins.msgs = withAnalysis(c.msgs.slice());
        return ins;
      });
    });
  }

  /* ============ 3. AI 客服回复 ============ */
  /* 回复要按客户语言输出：固定口径先落成多语言短句，避免西/德/日语正文里混进中文 */
  var PHR = {
    'ship': { zh: 'US 仓 48 小时内出库，本土 3-5 个工作日；欧盟走波兰仓，无进口关税',
              en: 'US warehouse dispatches within 48 h, 3-5 business days domestically; EU orders ship from the Poland warehouse with no import duty',
              de: 'US-Lager versendet binnen 48 Std., 3-5 Werktage; EU-Bestellungen gehen über das Polen-Lager ohne Einfuhrzoll',
              ja: 'US 倉庫は48時間以内に発送、本土3〜5営業日。EU はポーランド倉庫から関税なし',
              es: 'El almacén de EE. UU. envía en 48 h, 3-5 días laborables; los pedidos de la UE salen del almacén de Polonia sin aranceles' },
    'warranty': { zh: '12 个月只换不修，凭订单号 + 15 秒视频补发，无需退回',
                  en: '12-month replacement-only warranty — order number plus a 15 s video is enough, no return needed',
                  de: '12 Monate Austausch statt Reparatur — Bestellnummer plus 15-Sekunden-Video genügt, keine Rücksendung',
                  ja: '12か月の交換保証（修理なし）。注文番号と15秒の動画だけで再発送、返送は不要です',
                  es: 'Garantía de intercambio de 12 meses: basta el número de pedido y un video de 15 s, sin devolución' },
    'bulk': { zh: '批发阶梯价与打样周期需人工确认：【阶梯报价】【打样费】【账期】',
              en: 'Tiered wholesale pricing and sampling lead time need manual confirmation: 【tiers】【sample fee】【payment terms】',
              de: 'Staffelpreise und Musterzeiten sind manuell zu bestätigen: 【Staffeln】【Musterkosten】【Zahlungsziel】',
              ja: '卸価格の段階とサンプル納期は人間確認が必要です：【価格段】【サンプル費】【支払条件】',
              es: 'Los precios por volumen y el plazo de muestras requieren confirmación: 【tramos】【coste de muestra】【condiciones de pago】' },
    '现货 48 小时发货': { en: 'In stock — ships within 48 h', de: 'Auf Lager — Versand in 48 Std.', ja: '在庫あり／48時間以内に発送', es: 'En stock — se envía en 48 h' },
    '现货 24 小时发货': { en: 'In stock — ships within 24 h', de: 'Auf Lager — Versand in 24 Std.', ja: '在庫あり／24時間以内に発送', es: 'En stock — se envía en 24 h' },
    '补货中，预计 10-08 到仓': { en: 'Restocking — expected in warehouse on 10-08', de: 'Nachbestellt — voraussichtlich am 10-08 im Lager', ja: '補充中／10-08 に入荷予定', es: 'En reabastecimiento — previsto en almacén el 10-08' },
    '打样 7 天 / 大货 25 天': { en: 'Sample 7 days / bulk production 25 days', de: 'Muster 7 Tage / Serie 25 Tage', ja: 'サンプル7日／量産25日', es: 'Muestra 7 días / producción 25 días' }
  };
  var STOCK0 = { zh: '缺货 — ', en: 'Out of stock — ', de: 'Ausverkauft — ', ja: '在庫切れ／', es: 'Sin stock — ' };
  var STOCKN = { zh: function (n) { return '库存 ' + n + ' 件'; },
                 en: function (n) { return n + ' units in stock'; }, de: function (n) { return n + ' Stück verfügbar'; },
                 ja: function (n) { return '在庫 ' + n + ' 点'; }, es: function (n) { return n + ' unidades disponibles'; } };
  var PRICE0 = { zh: '当前售价 ', en: 'Current price USD ', de: 'Aktueller Preis USD ', ja: '現在の価格 USD ', es: 'Precio actual USD ' };

  function phrase(zh, lang) {
    var row = PHR[zh];
    /* PHR 里有几条的键本身就是中文（'现货 48 小时发货'），没有 zh 列——中文口径就直接用键，别退到英文 */
    return row ? (row[lang] || (lang === 'zh' ? zh : row.en) || zh) : zh;
  }

  function buildReply(chat, ins, products) {
    var last = null;
    for (var i = chat.msgs.length - 1; i >= 0; i--) {
      if (chat.msgs[i].from === 'customer') { last = chat.msgs[i]; break; }
    }
    if (!last) return { error: '该会话没有待回复的客户消息' };
    var c = classify(last.text);
    var pid = ins.focus.length ? ins.focus[0].id : null;
    var p = products.filter(function (x) { return x.id === pid; })[0] || null;
    /* 2026-09-28 用户定：客服链路只用中文，观众要当场看得懂对话。
       五语措辞留在 PHR / T / pushy 里当素材，恢复按国家出语言只改这一行。 */
    var lang = 'zh';
    var facts = [], used = [];

    if (p) {
      facts.push({ t: 'product', v: p.name || p.nameEn });
      used.push(ev('回复引用商品', p.id + ' · ' + p.name, 'db'));
      if (p.attrs.lead) { facts.push({ t: 'lead', v: phrase(p.attrs.lead, lang) }); used.push(ev('回复引用交期', 'products.' + p.id + '.attrs.lead：' + p.attrs.lead, 'db')); }
      facts.push({ t: 'stock', v: (p.stock === 0 ? STOCK0[lang] : '') + STOCKN[lang](p.stock) });
      used.push(ev('回复引用库存', 'products.' + p.id + '.stock = ' + p.stock + ' 件', 'db'));
    }
    if (c.topics.indexOf('物流时效') >= 0) {
      facts.push({ t: 'ship', v: phrase('ship', lang) });
      used.push(ev('物流口径', '模板口径（js/shop.js PHR.ship），未接入物流商 API', 'mock'));
    }
    if (c.topics.indexOf('售后保障') >= 0) {
      facts.push({ t: 'warranty', v: phrase('warranty', lang) });
      used.push(ev('保障口径', '模板口径（js/shop.js PHR.warranty），需与真实售后政策核对', 'mock'));
    }
    if (c.topics.indexOf('批量与样品') >= 0) {
      facts.push({ t: 'bulk', v: phrase('bulk', lang) });
      used.push(ev('起订口径', p && p.attrs.moq ? 'products.' + p.id + '.attrs.moq：' + p.attrs.moq : '商品档案未登记 MOQ', p && p.attrs.moq ? 'db' : 'gap'));
      used.push(ev('报价字段', '系统内无批发阶梯价，保留占位符', 'gap'));
    }
    if (c.topics.indexOf('价格折扣') >= 0) {
      facts.push({ t: 'price', v: p ? PRICE0[lang] + p.price + (lang === 'zh' ? ' 美元' : '') : '【价格】' });
      used.push(ev('对客户只报售价', p ? 'USD ' + p.price + '（毛利 ' + p.margin + '% 只留在后台，不写进回复）' : '未关联商品', 'derived'));
    }

    var T = {
      zh: ['您问的这几项，我从系统里核对到的如下：', '需要的话我先帮您把货留住，发出后第一时间把物流单号发给您。'],
      en: ['Thanks for the detail — here is what I can confirm:', 'Next step: I can hold the unit and send the tracking number as soon as it ships.'],
      de: ['Danke für die Rückmeldung — das kann ich bestätigen:', 'Wenn Sie möchten, halte ich die Ware zurück und sende Ihnen die Sendungsnummer.'],
      ja: ['ご質問ありがとうございます。確認できた内容は以下の通りです。', 'ご希望でしたら在庫を確保し、発送後に伝票番号をお送りします。'],
      es: ['Gracias por escribir. Esto es lo que puedo confirmar:', 'Si quieres, reservo las unidades y te paso el número de guía en cuanto salga.']
    };
    var wrap = T[lang] || T.en;
    var body = wrap[0] + '\n' + facts.map(function (f, i) { return (i + 1) + '. ' + f.v; }).join('\n') + '\n' + wrap[1];
    var qty = ins.counts.cart ? ins.counts.cart : 1;
    var pushy = {
      zh: '今天这款出得快 — ' + (p ? STOCKN.zh(p.stock) : '数量不多') + '。要不要先给您锁 ' + qty + ' 件，保留 24 小时？',
      en: 'Stock is moving today — ' + (p ? STOCKN.en(p.stock) : 'limited') + '. Want me to lock ' + qty + ' for 24 hours?',
      de: 'Die Ware bewegt sich heute — ' + (p ? STOCKN.de(p.stock) : 'begrenzt') + '. Soll ich ' + qty + ' für 24 Std. reservieren?',
      ja: '本日動いています。' + (p ? STOCKN.ja(p.stock) : '数量限定') + '。' + qty + ' 点を24時間確保しましょうか？',
      es: 'Está saliendo hoy: ' + (p ? STOCKN.es(p.stock) : 'cantidad limitada') + '. ¿Reservo ' + qty + ' unidades por 24 h?' }[lang];
    var human = {
      zh: '这条我转给负责「' + c.primary + '」的同事，30 分钟内回复您。',
      en: 'I am bringing in a colleague who handles ' + TOPIC_L10N[c.primary].en + ' for this market; they will reply within 30 minutes.',
      de: 'Ich hole jemanden aus unserem Team für ' + TOPIC_L10N[c.primary].de + ' dazu; Antwort innerhalb von 30 Minuten.',
      ja: 'この市場担当の同僚に引き継ぎます。30分以内にお返事します。',
      es: 'Paso el caso con un compañero que atiende ' + TOPIC_L10N[c.primary].es + ' en este mercado; responde en 30 min.' }[lang];

    return {
      lang: lang, to: chat.name, chatId: chat.id, intent: c.primary, topics: c.topics,
      reply: body, evidence: used,
      alt: [{ t: '催单版', v: pushy }, { t: '转人工版', v: human }],
      notice: '商品名、交期与库存取自本地数据库里的商品行；物流、保障与批发报价口径为模板值，接入真实平台后由接口覆盖；【】内需人工填写。'
    };
  }

  /* ============ 4. AI 商品优化 / 生成 ============ */
  var TERMS = {
    '38dB 混合降噪': { en: '38 dB hybrid ANC', es: 'ANC híbrido de 38 dB', de: '38 dB hybride ANC', ja: '38dB ハイブリッドANC' },
    '42dB 自适应降噪': { en: '42 dB adaptive ANC', es: 'ANC adaptativo de 42 dB', de: '42 dB adaptive ANC', ja: '42dB 適応型ANC' },
    '单次 8 小时 / 含仓 32 小时': { en: '8 h per charge, 32 h with the case', es: '8 h por carga, 32 h con estuche', de: '8 h pro Ladung, 32 h mit Case', ja: '本体8時間／ケース込み32時間' },
    '45 小时': { en: '45 h battery life', es: '45 h de batería', de: '45 h Akkulaufzeit', ja: '45時間バッテリー' },
    '10 小时': { en: '10 h battery life', es: '10 h de batería', de: '10 h Akkulaufzeit', ja: '10時間バッテリー' },
    '18 小时': { en: '18 h battery life', es: '18 h de batería', de: '18 h Akkulaufzeit', ja: '18時間バッテリー' },
    '14 天典型 / 40 小时 GPS': { en: '14 days typical, 40 h with GPS', es: '14 días típicos, 40 h con GPS', de: '14 Tage typisch, 40 h mit GPS', ja: '通常14日／GPS使用時40時間' },
    '18 天': { en: '18 days of use', es: '18 días de uso', de: '18 Tage Nutzung', ja: '18日間使用可能' },
    'IPX5': { en: 'IPX5 splash resistant', es: 'Resistente a salpicaduras IPX5', de: 'IPX5 spritzwassergeschützt', ja: 'IPX5 生活防水' },
    'IPX7': { en: 'IPX7 waterproof', es: 'Impermeable IPX7', de: 'IPX7 wasserdicht', ja: 'IPX7 防水' },
    'IP68 可游泳': { en: 'IP68, safe for swimming', es: 'IP68, apto para nadar', de: 'IP68, zum Schwimmen geeignet', ja: 'IP68 游泳OK' },
    '5ATM': { en: '5 ATM water resistant', es: 'Resistencia al agua 5 ATM', de: '5 ATM wasserdicht', ja: '5気圧防水' },
    '蓝牙 5.3': { en: 'Bluetooth 5.3', es: 'Bluetooth 5.3', de: 'Bluetooth 5.3', ja: 'Bluetooth 5.3' },
    '游戏模式 65ms': { en: '65 ms low-latency game mode', es: 'Modo juego de 65 ms', de: '65-ms-Spielmodus', ja: 'ゲームモード65ms' },
    '双频 GPS': { en: 'Dual-band GPS', es: 'GPS de doble banda', de: 'Dual-Band-GPS', ja: 'デュアルバンドGPS' },
    '1.43 英寸 AMOLED': { en: '1.43" AMOLED display', es: 'Pantalla AMOLED de 1,43"', de: '1,43-Zoll-AMOLED', ja: '1.43型AMOLED' },
    '150+ 运动模式': { en: '150+ sport modes', es: 'Más de 150 modos deportivos', de: '150+ Sportmodi', ja: '150以上のスポーツモード' },
    '心率 / 血氧 / 睡眠 / 压力': { en: 'Heart rate, SpO2, sleep and stress tracking', es: 'Frecuencia cardíaca, SpO2, sueño y estrés', de: 'Puls, SpO2, Schlaf und Stress', ja: '心拍・SpO2・睡眠・ストレス' },
    '20000mAh / 74Wh': { en: '20,000 mAh / 74 Wh', es: '20 000 mAh / 74 Wh', de: '20.000 mAh / 74 Wh', ja: '20000mAh/74Wh' },
    '65W 双向 PD': { en: '65 W two-way PD charging', es: 'Carga PD bidireccional de 65 W', de: '65-W-bidirektionales PD-Laden', ja: '65W双方向PD' },
    '2C1A': { en: '2× USB-C + 1× USB-A', es: '2 USB-C + 1 USB-A', de: '2× USB-C + 1× USB-A', ja: 'USB-C×2 + USB-A×1' },
    '2×10W 立体声': { en: '2× 10 W stereo', es: 'Estéreo 2× 10 W', de: '2× 10 W Stereo', ja: '2×10Wステレオ' },
    '支持 100 台串联': { en: 'Pairs with up to 100 speakers', es: 'Se enlaza con hasta 100 altavoces', de: 'Koppelt bis zu 100 Lautsprecher', ja: '最大100台連携' },
    '248g': { en: '248 g light', es: 'Solo 248 g', de: 'Nur 248 g', ja: '軽量248g' },
    '28g': { en: 'Only 28 g', es: 'Solo 28 g', de: 'Nur 28 g', ja: 'わずか28g' },
    '开放式不入耳': { en: 'Open-ear, non-intrusive fit', es: 'Diseño abierto, no intraaural', de: 'Open-Ear, nicht im Ohr', ja: 'オープンイヤー型' },
    /* 产业带产地：库里 attrs.产地 存的是中文地名，这里是地名转写，不是猜译 */
    '泉州 · 晋江': { en: 'Made in Jinjiang, Quanzhou', es: 'Fabricado en Jinjiang, Quanzhou', de: 'Hergestellt in Jinjiang, Quanzhou', ja: '泉州・晋江製' },
    '泉州 · 德化': { en: 'Made in Dehua, Quanzhou', es: 'Fabricado en Dehua, Quanzhou', de: 'Hergestellt in Dehua, Quanzhou', ja: '泉州・徳化製' },
    '泉州 · 安溪': { en: 'Made in Anxi, Quanzhou', es: 'Fabricado en Anxi, Quanzhou', de: 'Hergestellt in Anxi, Quanzhou', ja: '泉州・安溪製' },
    '漳州': { en: 'Made in Zhangzhou', es: 'Fabricado en Zhangzhou', de: 'Hergestellt in Zhangzhou', ja: '漳州製' },
    '莆田': { en: 'Made in Putian', es: 'Fabricado en Putian', de: 'Hergestellt in Putian', ja: '莆田製' },
    '福州': { en: 'Made in Fuzhou', es: 'Fabricado en Fuzhou', de: 'Hergestellt in Fuzhou', ja: '福州製' }
  };
  var SCENE = {
    'TWS 耳机': { en: 'for commuting, calls and gaming', es: 'para trayectos, llamadas y juegos', de: 'für Pendeln, Anrufe und Gaming', ja: '通勤・通話・ゲーム向け' },
    '头戴耳机': { en: 'for long-haul flights and focus work', es: 'para vuelos largos y concentración', de: 'für Langstrecke und konzentriertes Arbeiten', ja: '長距離フライト・集中作業向け' },
    '运动耳机': { en: 'for running and swimming', es: 'para correr y nadar', de: 'zum Laufen und Schwimmen', ja: 'ランニング・水泳向け' },
    '蓝牙音箱': { en: 'for outdoors and parties', es: 'para exterior y fiestas', de: 'für draußen und Partys', ja: 'アウトドア・パーティー向け' },
    '智能穿戴': { en: 'for training and daily health', es: 'para entrenar y salud diaria', de: 'für Training und Gesundheit', ja: 'トレーニング・健康管理向け' },
    '充电配件': { en: 'for travel and multi-device setups', es: 'para viajes y varios dispositivos', de: 'für Reisen und mehrere Geräte', ja: '出張・複数デバイス向け' },
    '手机配件': { en: 'for everyday protection', es: 'para la protección diaria', de: 'für den Alltagsschutz', ja: '日常の保護向け' },
    '车载配件': { en: 'for daily driving', es: 'para conducir a diario', de: 'für die tägliche Fahrt', ja: '毎日ドライブ向け' }
  };
  function tr(zh, lang) {
    if (lang === 'zh') return zh;
    var hit = TERMS[zh];
    return hit ? hit[lang] : null;
  }

  function optimizeProduct(p, marketRow) {
    var attrList = Object.keys(p.attrs).map(function (k) { return p.attrs[k]; });
    var spec = attrList.slice(0, 3);
    var scene = SCENE[p.cat] || {};
    var out = { id: p.id, name: p.name, evidence: [], notices: [] };
    /* 商品档案里的参数值是中文原文，英文文案必须过词典；查不到就留空并把原文单独报出来，绝不猜译 */
    var needsEn = [];
    var en = function (s) {
      if (!s) return '';
      var hit = tr(s, 'en') || phrase(s, 'en');
      if (hit && !/[\u4e00-\u9fa5]/.test(hit)) return hit;
      if (needsEn.indexOf(s) < 0) needsEn.push(s);
      return '';
    };
    /* 有值但词典没收录 → 标「待补英文」；库里根本没这个字段 → 才是真的「待补充」 */
    var orEn = function (v, missing) { return en(v) || (v ? '【待补英文】' : missing); };

    out.title = {
      zh: p.name + '｜' + spec[0] + '｜' + (p.cat),
      en: (p.nameEn || p.name) + ' — ' + [spec.map(en).filter(Boolean)[0], scene.en || 'everyday use'].filter(Boolean).join(', '),
      es: (p.nameEn || p.name) + ' — ' + (tr(spec[0], 'es') || spec[0]) + ', ' + (scene.es || 'uso diario'),
      de: (p.nameEn || p.name) + ' — ' + (tr(spec[0], 'de') || spec[0]) + ', ' + (scene.de || 'für den Alltag'),
      ja: (p.nameEn || p.name) + ' — ' + (tr(spec[0], 'ja') || spec[0]) + '、' + (scene.ja || '日常使い')
    };
    out.description = {
      zh: p.name + '。核心参数：' + attrList.join('；') + '。' + (p.issues[0] ? '当前详情页缺口：' + p.issues[0] + '。' : ''),
      en: (p.nameEn || p.name) + ' for ' + (scene.en || 'everyday use') + '. Key specs: ' +
          (spec.map(en).filter(Boolean).join(', ') || '【待补英文】') + '. ' +
          (p.attrs.lead ? 'Availability: ' + orEn(p.attrs.lead, '') + '.' : ''),
      es: (p.nameEn || p.name) + ' ' + (scene.es || '') + '. Claves: ' + spec.map(function (s) { return tr(s, 'es') || s; }).join(', ') + '.',
      de: (p.nameEn || p.name) + ' ' + (scene.de || '') + '. Wichtig: ' + spec.map(function (s) { return tr(s, 'de') || s; }).join(', ') + '.',
      ja: (p.nameEn || p.name) + '（' + (scene.ja || '日常向け') + '）。主な仕様：' + spec.map(function (s) { return tr(s, 'ja') || s; }).join('、') + '。'
    };
    out.bullets = attrList.slice(0, 5).map(function (a) {
      return { zh: a, en: tr(a, 'en') || a, es: tr(a, 'es') || a, de: tr(a, 'de') || a, ja: tr(a, 'ja') || a };
    });
    var specEn = function (s) { return (tr(s, 'en') || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); };
    var extra = [
      specEn(spec[0]) + ' ' + (p.keywords[0] || ''),
      (scene.en || '').replace(/^for /, '') + ' ' + specEn(spec[1]),
      p.id.toLowerCase() + ' ' + (p.keywords[0] || 'review'),
      p.attrs.ipx || p.attrs.water ? 'waterproof ' + specEn(p.attrs.ipx || p.attrs.water).split(' ')[0] : '',
      /小时|battery|h\b/.test(p.attrs.battery || '') ? 'long battery life ' + p.id.toLowerCase() : ''
    ].map(function (s) { return s.trim().replace(/\s+/g, ' '); })
      .filter(function (s) { return s.length > 8 && /^[a-z0-9 .,'-]+$/.test(s); })
      .filter(function (s, i, a) { return a.indexOf(s) === i; });
    out.seo = {
      existing: p.keywords.slice(),
      added: extra,
      note: '关键词由商品参数与品类拼装，未做平台真实搜索量校验；接入 Shopify / Amazon 搜索词报告后再排优先级'
    };
    /* 档案里真写了蓝牙版本才答连接性：鞋服/茶具不硬编一句「Bluetooth 5.x」 */
    out.faq = (p.attrs.bt ? [{ q: 'Does it work with iPhone and Android?', a: 'Yes — ' + orEn(p.attrs.bt, '') + ' pairs with both.' }] : []).concat([
      { q: 'Can I use it in the rain or while swimming?', a: orEn(p.attrs.ipx || p.attrs.water || p.attrs.vent, '【防水等级待补充】') },
      { q: 'How long does the battery last?', a: orEn(p.attrs.battery || p.attrs.power, '【续航待补充】') },
      { q: 'When will it ship?', a: orEn(p.attrs.lead, '【发货时效待补充】') },
      { q: 'What is the warranty?', a: '12 months replacement — 【需与真实售后政策核对】' }
    ]);
    out.tags = [p.cat, p.id, p.target, p.status === 'online' ? 'ready-to-ship' : 'restock'].concat(
      spec.slice(0, 2).map(en).filter(Boolean).map(function (s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-'); })
    );
    out.todo = p.issues.slice();
    out.priceHint = {
      current: p.price, cost: p.cost, margin: p.margin,
      note: '未提供同类竞品真实售价，此处不给调价结论；接入平台比价接口后补充'
    };
    if (marketRow) {
      out.evidence.push(ev('目标市场该品类年度进口额', marketRow.amount + ' 亿美元（' + marketRow.cat + '）', 'mock'));
      if (marketRow.yoy != null) out.evidence.push(ev('品类进口同比', (marketRow.yoy >= 0 ? '+' : '') + marketRow.yoy + '%', 'mock'));
      if (marketRow.suppliers && marketRow.suppliers.length) {
        out.evidence.push(ev('主要供应国', marketRow.suppliers.slice(0, 3).map(function (s) { return s.cn + ' ' + s.share + '%'; }).join(' / '), 'mock'));
      }
    }
    out.evidence.push(ev('商品参数来源', '本地数据库 products.' + p.id + '.attrs', 'db'));
    out.notices.push('文案中的场景词与保障条款为模板拼装，未做平台合规校验；上架前需人工复核，尤其认证与医疗/健康类表述。');
    if (needsEn.length) {
      out.notices.push('英文文案里有 ' + needsEn.length + ' 个参数词典未收录，已留「待补英文」而不是猜译：' + needsEn.join(' / '));
    }
    return out;
  }

  function generateProduct(brief) {
    return load().then(function (tax) {
      var t = String(brief || '');
      var out = { brief: t, fields: {}, missing: [], evidence: [] };
      var catHit = null;
      (tax.categories || []).forEach(function (c) {
        if (!catHit && c.keys.some(function (k) { return t.toLowerCase().indexOf(String(k).toLowerCase()) >= 0; })) catHit = c.cat;
      });
      var isoHit = null;
      Object.keys(tax.countries || {}).forEach(function (w) {
        if (!isoHit && t.toLowerCase().indexOf(w.toLowerCase()) >= 0) isoHit = tax.countries[w];
      });
      var price = t.match(/(usd|\$|美元|价)\s*([0-9]+(?:\.[0-9]+)?)/i);
      var stock = t.match(/(库存|stock|备货)\D{0,4}([0-9]+)/i);
      var specs = (t.match(/[A-Za-z0-9+/.\u4e00-\u9fa5%]{2,}\s*(?:dB|W|mAh|Wh|mm|g|inch|英寸|小时|h|IPX?\d|ATM|5\.3|代)/gi) || []).slice(0, 6);

      out.fields.category = catHit || null;
      out.fields.target = isoHit || null;
      out.fields.price = price ? +price[2] : null;
      out.fields.stock = stock ? +stock[2] : null;
      out.fields.specs = specs;
      out.fields.name = (t.match(/["“]([^"”]{3,40})["”]/) || [])[1] || null;
      ['name', 'category', 'target', 'price', 'stock'].forEach(function (k) {
        if (!out.fields[k]) out.missing.push({ key: k, cn: { name: '商品名', category: '品类', target: '目标市场', price: '售价', stock: '库存' }[k] });
      });
      out.draft = {
        /* 草稿编号只由商品名推导：同一条 brief 换个时间再跑，结果必须一字不差 */
        id: 'NEW-' + (String(out.fields.name || 'sku').toLowerCase().replace(/[^a-z0-9]/g, '') + 'sku').slice(0, 4),
        name: out.fields.name || '【商品名】',
        nameEn: '【英文标题】',
        cat: out.fields.category || '【品类】',
        price: out.fields.price || 0,
        cost: 0, stock: out.fields.stock || 0,
        status: 'draft', target: out.fields.target || 'USA', langs: ['en'],
        attrs: (out.fields.specs || []).reduce(function (a, s, i) { a['spec' + (i + 1)] = s; return a; }, {}),
        keywords: (out.fields.specs || []).slice(0, 3)
      };
      out.evidence.push(ev('解析方式', '词典匹配 data/taxonomy.json + 正则抽取参数', 'derived'));
      out.notice = 'AI 只生成骨架，未提供的字段保留【】占位，不自动编造价格、成本与认证信息。';
      return out;
    });
  }

  /* ============ 5. AI 今日经营分析 + 行动计划 ============ */
  function overview() {
    return Promise.all([DS.daily(30), DS.products(), DS.orders({ status: '退款中', limit: 500 }), DS.chats(), DS.events()]).then(function (r) {
      var rows = r[0].rows, products = r[1].items, refunds = r[2].items, chats = r[3].items, events = r[4].items;
      var today = rows[rows.length - 1], yest = rows[rows.length - 2] || today;
      var last7 = rows.slice(-7);

      function delta(a, b) { return b ? +((a / b - 1) * 100).toFixed(1) : 0; }
      /* 卡片名带上真实数据日期：日报最后一天是哪天就写哪天。
         写死「今日」而数据停在 09-21，大屏挂几天就假几天——数字不许改，能改的只有名。 */
      var day = String(today.d).slice(-5);
      var kpis = [
        { k: day + ' 访客', v: today.vis, u: '', d: delta(today.vis, yest.vis), e: 'store_daily[' + today.d + '].vis' },
        { k: day + ' 咨询', v: today.chat, u: '', d: delta(today.chat, yest.chat), e: 'store_daily[' + today.d + '].chat' },
        { k: day + ' 加购', v: today.cart, u: '', d: delta(today.cart, yest.cart), e: 'store_daily[' + today.d + '].cart' },
        /* 这两个卡带 drill：界面上做成可点入口，点下去就是当天那几笔的逐行明细。
           数字出自 store_daily，而 store_daily 的 ord/rev 由 orders 逐笔汇总，所以明细一定对得上。 */
        { k: day + ' 订单', v: today.ord, u: '', d: delta(today.ord, yest.ord), e: 'store_daily[' + today.d + '].ord', drill: 1 },
        { k: day + ' 销售额', v: today.rev, u: '美元', d: delta(today.rev, yest.rev), e: 'store_daily[' + today.d + '].rev', drill: 1 },
        { k: '下单转化率', v: today.cvr, u: '%', d: +(today.cvr - yest.cvr).toFixed(2), e: 'store_daily[' + today.d + '].ord / .vis' },
        { k: '平均停留', v: today.dwell, u: '秒', d: delta(today.dwell, yest.dwell), e: 'store_daily[' + today.d + '].dwell' },
        { k: '高意向客户', v: today.hot, u: '位', d: delta(today.hot, yest.hot), e: 'store_daily[' + today.d + '].hot' }
      ].map(function (x) {
        x.vText = x.u === '美元' ? x.v.toLocaleString('en-US', { minimumFractionDigits: 2 }) : x.v;
        return x;
      });

      var series = {
        x: rows.map(function (r) { return r.d; }),
        vis: rows.map(function (r) { return r.vis; }),
        views: rows.map(function (r) { return r.pv; }),
        cart: rows.map(function (r) { return r.cart; }),
        ord: rows.map(function (r) { return r.ord; }),
        rev: rows.map(function (r) { return r.rev; }),
        cvr: rows.map(function (r) { return r.cvr; })
      };

      /* 商品侧：浏览涨幅最大 / 转化跌幅最大 / 断货风险 */
      var rising = products.filter(function (p) { return p.d7.views[6] > 0; }).slice().sort(function (a, b) { return b.viewDelta - a.viewDelta; })[0];
      var slipping = products.filter(function (p) { return p.views > 100; }).slice().sort(function (a, b) { return (a.cvrToday - a.cvrPrev) - (b.cvrToday - b.cvrPrev); })[0];
      var cover = function (p) {
        var d = avg(p.d7.ord.slice(-3));
        return d > 0 ? Math.floor(p.stock / d) : (p.stock > 0 ? 999 : 0);
      };
      var stockRisk = products.filter(function (p) { return p.status !== 'draft' && cover(p) <= 30; })
        .sort(function (a, b) { return cover(a) - cover(b); });

      /* 客服侧：今日客户消息话题分布 */
      var todayMix = topicMix(chats, today.d);
      var topTopic = todayMix.length ? todayMix[0].k : '';
      var topTopicShare = todayMix.length ? todayMix[0].share : 0;
      var topicTotal = todayMix.length ? todayMix[0].total : 0;
      var topicCount = todayMix.reduce(function (o, x) { o[x.k] = x.n; return o; }, {});

      /* 会话侧高意向识别 */
      var hotChats = chats.map(function (c) {
        return buildInsight(c, events.filter(function (e) { return e.cust === c.cust; }), products);
      }).filter(function (x) { return x.buy >= 62; });

      /* 退款不问「取回来的这 500 笔里有没有」，而是直接按状态查库：
         库里一天 30 笔、30 天几百笔，任何 limit 都会把某一天的退款单切掉，界面就成了「没有退款」。 */
      var refund = refunds;

      var findings = [];
      if (hotChats.length) findings.push({
        icon: '🔥', level: 'ok', t: '会话侧识别出 ' + hotChats.length + ' 位高意向客户',
        d: '购买意向 ≥62：' + hotChats.map(function (x) { return x.name + '（' + x.buy + '）'; }).join('、'),
        e: [ev('店铺标记高意向数（埋点口径）', 'store_daily[' + today.d + '].hot = ' + today.hot + ' 位'),
            ev('会话洞察识别数（行为+消息口径）', hotChats.length + ' 位', 'derived'),
            ev('两口径差异', (today.hot - hotChats.length) + ' 位，差异来自未咨询直接下单客户', 'derived')],
        act: 'plan:leads'
      });
      if (rising) findings.push({
        icon: '📈', level: 'up', t: rising.id + ' 近 7 日浏览量上涨 ' + rising.viewDelta + '%',
        d: today.d + ' 浏览 ' + rising.d7.views[6] + '，前 6 日均值 ' + Math.round(avg(rising.d7.views.slice(0, 6))) + '；同期下单 ' + rising.d7.ord[6] + ' 单',
        e: [ev('浏览序列', rising.id + ' 近 7 日 ' + rising.d7.views.join(' → '), 'db'),
            ev('订单序列', rising.id + ' 近 7 日 ' + rising.d7.ord.join(' → '), 'db'),
            ev('当前转化率', rising.cvrToday + '%', 'derived')],
        act: 'product:' + rising.id
      });
      if (slipping && slipping.cvrToday < slipping.cvrPrev) findings.push({
        icon: '⚠', level: 'warn', t: slipping.id + ' 转化率下滑：' + slipping.cvrPrev + '% → ' + slipping.cvrToday + '%',
        d: '近 7 日订单 ' + slipping.d7.ord.join(' / ') + '，浏览基本持平（' + slipping.d7.views[0] + ' → ' + slipping.d7.views[6] + '），说明问题在页面而非流量',
        e: [ev('前 6 日均转化', slipping.cvrPrev + '%', 'derived'),
            ev('最新一日转化', slipping.cvrToday + '%', 'derived'),
            ev('页面已知问题', 'products.' + slipping.id + '.issues：' + slipping.issues.join('；'), 'db')],
        act: 'product:' + slipping.id
      });
      if (topTopic) findings.push({
        icon: '💬', level: 'info', t: '今日 ' + topTopicShare + '% 的客服咨询集中在「' + topTopic + '」',
        d: '今日客户消息 ' + topicTotal + ' 条，其中 ' + topicCount[topTopic] + ' 条命中「' + topTopic + '」关键词',
        e: [ev('话题分布', Object.keys(topicCount).map(function (k) { return k + ' ' + topicCount[k]; }).join(' / '), 'derived'),
            ev('识别方式', '多语言关键词词典（en/de/es/ja）', 'derived')],
        act: 'service'
      });
      stockRisk.slice(0, 2).forEach(function (p) {
        findings.push({
          icon: '📦', level: p.stock === 0 ? 'warn' : 'info',
          t: p.id + (p.stock === 0 ? ' 已断货，页面仍在收藏与加购列表中' : ' 库存仅够 ' + cover(p) + ' 天'),
          d: p.stock === 0 ? '近 7 日浏览 ' + p.d7.views.join(' / ') + ' 持续有流量，建议挂预售或下架引导替代款'
                           : '库存 ' + p.stock + ' 件，近 3 日日均销量 ' + n1(avg(p.d7.ord.slice(-3))) + ' 件',
          e: [ev('库存', 'products.' + p.id + '.stock = ' + p.stock + ' 件'), ev('近 3 日销量', 'product_metrics ' + p.id + '：' + p.d7.ord.slice(-3).join(' / ')),
              ev('可售天数', cover(p) + ' 天', 'derived')],
          act: 'product:' + p.id
        });
      });
      if (refund.length) findings.push({
        icon: '↩', level: 'warn', t: '有 ' + refund.length + ' 笔订单处于退款中（' + refund[0].pid + '）',
        d: '订单 ' + refund[0].id + '，金额 USD ' + refund[0].amount + '，' + refund[0].at,
        e: [ev('订单状态', 'orders.' + refund[0].id + '.status = ' + refund[0].status), ev('关联商品已知问题', (products.filter(function (x) { return x.id === refund[0].pid; })[0] || { issues: [] }).issues.join('；') || '无', 'db')],
        act: 'orders'
      });

      var advice = [];
      if (topTopic) advice.push('把「' + topTopic + '」的答复做成详情页固定模块，减少重复咨询');
      if (rising) advice.push('给 ' + rising.id + ' 追加同系列关联位与库存保障，承接上涨流量');
      if (slipping && slipping.cvrToday < slipping.cvrPrev) advice.push('优先改 ' + slipping.id + ' 详情页：补价值支撑与场景图，再看转化是否回到 ' + slipping.cvrPrev + '%');
      if (hotChats.length) advice.push('今日内跟进 ' + hotChats.length + ' 位高意向客户，先催单后报价');

      return {
        kpis: kpis, series: series, findings: findings, advice: advice,
        funnel: [
          { k: '访客', v: today.vis }, { k: '咨询', v: today.chat }, { k: '加购', v: today.cart }, { k: '下单', v: today.ord }
        ],
        meta: r[0].meta, today: today, yest: yest, last7: last7,
        notice: '访客、浏览、加购、订单等指标逐条来自本地数据库（store_daily / products / product_metrics / orders / messages），刷新页面读到的仍是库里那几行；未连接真实店铺后台，也没有向任何平台发过请求。'
      };
    });
  }

  function actionPlan() {
    return overview().then(function (o) {
      var slots = [], hour = [9, 11, 14, 16, 20];
      var used = {};
      function push(act, why, e, tag) { slots.push({ act: act, why: why, e: e, tag: tag }); }
      o.findings.forEach(function (f) {
        if (f.act === 'service' && !used.service) {
          used.service = 1;
          push('把「' + f.t.replace(/^今日\s*\d+%\s*的客服咨询集中在/, '').replace(/[「」]/g, '') + '」类咨询整理成详情页固定说明与快捷回复',
            f.d, f.e, '客服中心');
        } else if (f.act.indexOf('product:') === 0 && f.level === 'warn' && !used[f.act]) {
          used[f.act] = 1;
          push('优化 ' + f.t.split(' ')[0] + ' 商品页（标题 + 价值支撑 + 场景图）', f.d, f.e, '商品管理');
        } else if (f.act === 'plan:leads' && !used.leads) {
          used.leads = 1;
          push('逐个跟进高意向客户，先发催单话术再谈报价', f.d, f.e, '客服中心');
        } else if (f.act.indexOf('product:') === 0 && f.level === 'up' && !used[risingKey(f)]) {
          used[risingKey(f)] = 1;
          push('给 ' + f.t.split(' ')[0] + ' 加关联位并确认库存，承接上涨流量', f.d, f.e, '商品管理');
        } else if (f.act.indexOf('product:') === 0 && !used[f.act]) {
          used[f.act] = 1;
          push('处理 ' + f.t.split(' ')[0] + ' 的库存与页面状态（挂预售或引导替代款）', f.d, f.e, '商品管理');
        } else if (f.act === 'orders' && !used.orders) {
          used.orders = 1;
          push('核对退款订单并回写原因', f.d, f.e, '订单');
        }
      });
      function risingKey(f) { return 'up:' + f.t.split(' ')[0]; }
      push('复盘今日转化数据，标记明日要验证的 1 个改动', '今日 ' + o.today.d + ' 转化 ' + o.today.cvr + '%，7 日均 ' + n1(avg(o.last7.map(function (r) { return r.cvr; }))) + '%',
        [ev('今日转化率', o.today.cvr + '%', 'derived'), ev('近 7 日均值', n1(avg(o.last7.map(function (r) { return r.cvr; }))) + '%', 'derived')], '店铺总览');

      var plan = slots.slice(0, 5).map(function (s, i) {
        return { time: (hour[i] < 10 ? '0' : '') + hour[i] + ':00', act: s.act, why: s.why, e: s.e, tag: s.tag };
      });
      return { plan: plan, notice: '时间与优先级由今日数据推导，非固定模板；接入真实平台数据后每天重算。' };
    });
  }

  /* ============ 6. AI 市场适配 ============ */
  function pickRow(m, cats) {
    var rows = (m && m.cats) || [];
    for (var i = 0; i < (cats || []).length; i++) {
      var hit = rows.filter(function (c) { return c.cat === cats[i]; })[0];
      if (hit) return hit;
    }
    for (var j = 0; j < rows.length; j++) {
      if ((cats || []).some(function (c) { return rows[j].cat.indexOf(c) >= 0 || c.indexOf(rows[j].cat) >= 0; })) return rows[j];
    }
    return null;
  }
  function fitMargin(topShare) {
    if (topShare == null) return 45;
    return topShare >= 70 ? 35 : topShare >= 45 ? 45 : 55;
  }

  function marketFit(input) {
    input = input || {};
    return Promise.all([DS.market(input.iso || 'USA'), load()]).then(function (r) {
      var m = r[0];
      var iso = m.iso;
      if (m.nodata) return { error: '世界银行未收录该经济体，无法给出市场适配结论' };
      return AI.parse(input.product + ' ' + (input.query || '')).then(function (p) {
        var cats = p.cats.length ? p.cats : (input.cats || []);
        var row = pickRow(m, cats);
        var wb = TRADE.stats(iso) || {};
        var sup = row && row.suppliers ? row.suppliers : [];
        var top3v = sup.length ? +sup.slice(0, 3).reduce(function (a, b) { return a + b.share; }, 0).toFixed(1) : null;
        var margin = fitMargin(top3v);
        var out = {
          input: input, iso: iso, country: DS.name(iso), product: input.product, cats: cats,
          audience: input.audience || '', src: m.src, source: m.source, sections: []
        };

        out.sections.push({
          t: '市场需求', v: row ? AI.num(row.amount) + ' 亿美元' : '品类未收录',
          d: row ? '该经济体自全球进口' + row.cat + '的年度规模；中国供应份额越低，替代空间越大'
                : '示例库未收录该品类，可切换品类或接入海关分国别明细',
          e: row ? [ev(DS.name(iso) + '·' + row.cat + ' 进口额', AI.num(row.amount) + ' 亿美元', m.source),
                    ev('中国供应份额', (sup.filter(function (s) { return s.iso === 'CHN'; })[0] || { share: '—' }).share + '%', m.source)]
                 : [ev(DS.name(iso) + '·货物与服务进口总额', AI.num(wb.imp) + ' 亿美元', '世界银行')]
        });
        out.sections.push({
          t: '市场规模', v: AI.num(wb.imp) + ' 亿美元（全品类进口）',
          d: '品类规模 ÷ 全品类进口 = ' + (row && wb.imp ? (row.amount / wb.imp * 100).toFixed(2) + '%' : '—') + '，用于判断该品类在这个经济体的相对权重',
          e: [ev(DS.name(iso) + '·货物与服务进口总额', AI.num(wb.imp) + ' 亿美元', '世界银行 ' + (wb.year || '') ),
              ev('品类占比', row && wb.imp ? (row.amount / wb.imp * 100).toFixed(2) + '%' : '—', 'derived')]
        });
        out.sections.push({
          t: '竞争程度', v: top3v != null ? '前三供应国合计 ' + top3v + '%' : '待接入',
          d: top3v == null ? '无供应国结构数据' : top3v >= 70 ? '渠道被少数供应国把持，正面抢份额成本高，建议做细分差异'
             : top3v >= 45 ? '中度集中，需要靠参数与交付稳定性切入' : '结构分散，切入门槛相对低',
          e: [ev('前三供应国', sup.slice(0, 3).map(function (s) { return s.cn + ' ' + s.share + '%'; }).join(' / ') || '—', m.source),
              ev('集中度口径', row && row.globalSuppliers ? '全球口径，非该国分国别' : '该经济体分国别', 'derived')]
        });
        out.sections.push({
          t: '用户偏好', v: input.audience || '未填写',
          d: input.audience ? '人群描述为人工输入，系统内没有对应的调研或平台行为数据；下面的建议只依据品类结构与价格带推导，人群结论需人工验证'
                            : '未填写目标人群，人群维度不参与推导',
          e: [ev('人群描述来源', '用户输入，无数据支撑', 'input'),
              ev('该国主要进口品类结构', (m.goodsImport || []).slice(0, 3).map(function (x) { return x.name + ' ' + x.share + '%'; }).join(' / '), m.source)],
          warn: true
        });
        var price = input.price ? +input.price : null, cost = input.cost ? +input.cost : null;
        out.sections.push({
          t: '建议售价', v: cost ? 'USD ' + n1(cost / (1 - margin / 100)) : '需先填成本',
          d: cost ? '推算式：成本 ÷ (1 − 目标毛利)。目标毛利按竞争度取值（前三合计越高，可让利空间越小）'
                 : '系统内没有该商品的成本字段，补成本后才能算价，不做无依据报价',
          e: [ev('成本', cost ? 'USD ' + cost : '未填写', cost ? 'input' : 'gap'),
              ev('当前售价', price ? 'USD ' + price : '未填写', price ? 'input' : 'gap'),
              ev('目标毛利', margin + '%（由集中度 ' + (top3v != null ? top3v + '%' : '—') + ' 推得）', 'derived')],
          formula: cost ? 'USD ' + cost + ' ÷ (1 − ' + margin + '%) = USD ' + n1(cost / (1 - margin / 100)) : ''
        });
        out.sections.push({
          t: '竞争产品', v: sup.length ? '对手主要来自 ' + sup.slice(0, 3).map(function (s) { return s.cn; }).join('、') : '待接入',
          d: '系统按供应国份额给出对手来源地，未收录具体品牌与机型；品牌级竞品与售价需接入平台商品接口',
          e: [ev('供应国份额', sup.slice(0, 5).map(function (s) { return s.cn + ' ' + s.share + '%'; }).join(' / ') || '—', m.source)],
          gap: '品牌 / 型号 / 售价：待接入 Amazon、TikTok Shop 商品接口'
        });
        out.sections.push({
          t: '物流因素', v: row && row.yoy != null ? '品类进口同比 ' + AI.pct(row.yoy) : '增速待接入',
          d: '含电池、磁性、液体类目需核对航空与本地运输条款；大件建议走平台仓或海外仓，时效直接影响退货率',
          e: [ev(DS.name(iso) + '·贸易总额同比', AI.pct(wb.yoy), '世界银行'),
              ev('店铺发货时效', input.lead || '未登记', input.lead ? 'input' : 'gap'),
              ev('进口依赖度（进口/贸易总额）', wb && wb.total ? (wb.imp / wb.total * 100).toFixed(1) + '%' : '—', 'derived')]
        });
        out.sections.push({
          t: '合规风险', v: (m.barriers || []).length + ' 项待核对',
          d: (m.barriers || []).join('；') || '示例库未登记该经济体的准入壁垒',
          e: [ev('壁垒条数', (m.barriers || []).length, m.source),
              ev('商品认证字段', input.cert || '商品档案未登记认证信息', input.cert ? 'input' : 'gap')]
        });
        out.sections.push({
          t: '进入方式建议', v: '小单试销 → 看真实转化再放量',
          d: '建议先挂 30-50 单量级测试，观察加购率与客服咨询话题分布，再决定是否进平台仓、找本地分销',
          e: [ev('依据 1：品类需求', row ? AI.num(row.amount) + ' 亿美元' : '—', m.source),
              ev('依据 2：竞争集中度', top3v != null ? top3v + '%' : '—', 'derived'),
              ev('依据 3：店铺今日转化', input.todayCvr ? input.todayCvr + '%' : '未关联店铺商品', input.todayCvr ? 'input' : 'gap')],
          verdict: '不给"能卖 / 不能卖"的绝对结论：人群、成本、合规任一项被证伪，结论都要重算'
        });
        out.notice = '市场规模、结构与增速来自数据层；人群、成本、认证为人工输入项，缺失时系统保留占位不猜测。';
        return out;
      });
    });
  }

  /* ============ 7. 订单与转化分析（锁定在某一天） ============
     库里一天 30 笔、三十天几百笔，「订单分析」必须落在某一天上：4b 的「今日订单」点开
     就是这一天的逐笔，逐笔之和与 store_daily 同一行对齐——两处数字来自同一批明细行。
     day 传 'MM-DD' 或 'YYYY-MM-DD' 都行，不传就取日报最后一天（也就是界面标题上的"今日"）。 */
  function orderAnalysis(input) {
    var want = (input && input.day) ? String(input.day).slice(-5) : '';
    var st = (input && input.status && input.status !== '全部状态') ? input.status : '';
    return DS.daily(30).then(function (dr) {
      var rows = dr.rows;
      var t = (want ? rows.filter(function (x) { return x.d === want; })[0] : null) || rows[rows.length - 1];
      if (!t) return { error: '日报里没有可用的日期行' };
      return Promise.all([
        DS.orders(st ? { day: t.d, status: st, limit: 1000 } : { day: t.d, limit: 1000 }),
        DS.orders({ status: '退款中', limit: 500 }),
        DS.products()
      ]).then(function (r) {
        var orders = r[0].items, refund = r[1].items, products = r[2].items;
        var byPid = {};
        orders.forEach(function (o) {
          byPid[o.pid] = byPid[o.pid] || { pid: o.pid, qty: 0, amount: 0, n: 0 };
          byPid[o.pid].qty += o.qty; byPid[o.pid].amount += o.amount; byPid[o.pid].n++;
        });
        var list = Object.keys(byPid).map(function (k) {
          var p = products.filter(function (x) { return x.id === k; })[0] || {};
          var o = byPid[k];
          return {
            pid: o.pid, name: p.name || o.pid, n: o.n, qty: o.qty, amount: +o.amount.toFixed(2),
            cartRate: p.cartRate, cvr: p.cvr, margin: p.margin, stock: p.stock,
            contribution: 0
          };
        });
        var totalAmt = sum(list.map(function (x) { return x.amount; }));
        list.forEach(function (x) { x.contribution = totalAmt ? +(x.amount / totalAmt * 100).toFixed(1) : 0; });
        list.sort(function (a, b) { return b.amount - a.amount; });
        /* 明细与日报对得上吗：种子导入时一定一致；运行中新写一笔订单就会不一致，界面照实说。
           带状态筛的时候本来就只有全天的一部分，不去谎称"一致"。 */
        var match = !st && r[0].total === t.ord && Math.abs((r[0].sum || 0) - t.rev) <= 0.005;
        var shipped = orders.filter(function (o) { return o.status === '已发货' || o.status === '已完成'; }).length;

        return {
          funnel: [
            { k: '访客', v: t.vis, rate: 100 },
            { k: '加购', v: t.cart, rate: DS.rate(t.cart, t.vis) },
            { k: '下单', v: t.ord, rate: DS.rate(t.ord, t.cart) },
            { k: '已发货', v: shipped, rate: DS.rate(shipped, t.ord) }
          ],
          today: t, orders: orders, orderTotal: r[0].total, orderSum: r[0].sum, match: match,
          status: st,
          byProduct: list, refund: refund,
          evidence: [
            ev('当日逐笔合计', r[0].total + ' 笔 · USD ' + (r[0].sum || 0).toFixed(2), 'db'),
            ev('当日日报行', 'store_daily[' + t.d + '].ord = ' + t.ord + ' · .rev = ' + t.rev, 'db'),
            ev('两边是否一致', match ? '一致' : '不一致：明细与日报有出入，以 orders 逐笔为准', 'derived'),
            ev('客单价', 'USD ' + t.aov + '（销售额 / 订单数）', 'derived'),
            ev('近 7 日订单', rows.slice(-7).map(function (x) { return x.ord; }).join(' / '), 'db')
          ],
          meta: r[0].meta,
          notice: '订单与漏斗逐条来自本地数据库 orders（按 placed_at 那一天筛）；日报的 ord/rev 就是这些明细行的汇总。'
            + '未咨询客服直接下单的买家，库里没有他的客户档案，所以那一列是空的——不是漏填。'
        };
      });
    });
  }

  /* ============ 8. 注册到 API.ai 接缝 ============ */
  function bind(id, fn) { return function (input) { return fn(input); }; }
  API.ai.register('customerInsight', function (input) {
    return chatsInsight().then(function (list) {
      if (input && input.cust) {
        var one = list.filter(function (x) { return x.cust === String(input.cust) || x.id === input.cust; })[0];
        return one || { error: '未找到该客户的会话与行为记录' };
      }
      return { items: list };
    });
  });
  API.ai.register('customerBehavior', function (input) {
    return DS.events(input && input.cust).then(function (res) {
      return {
        items: res.items.map(function (e) {
          return { at: e.at, type: e.type, label: ACT[e.type] || e.type, pid: e.pid, sec: e.sec };
        }),
        meta: res.meta
      };
    });
  });
  API.ai.register('customerService', function (input) {
    input = input || {};
    return Promise.all([chatsInsight(), DS.products()]).then(function (r) {
      var id = input.chatId || input.id;
      if (!id) {
        return { chats: r[0], topicMix: topicMix(r[0]), notice: '会话原文取自本地数据库 messages 表，意图/兴趣度/购买意向全部由 js/shop.js 按公开公式实时推算。' };
      }
      var one = r[0].filter(function (x) { return x.id === id; })[0];
      if (!one) return { error: '未找到该会话' };
      return { chat: one, reply: buildReply(one, one, r[1].items) };
    });
  });
  API.ai.register('storeAnalysis', function () { return overview(); });
  API.ai.register('dailyPlan', function () { return actionPlan(); });
  API.ai.register('orderAnalysis', function (input) { return orderAnalysis(input || {}); });
  API.ai.register('marketFit', function (input) { return marketFit(input || {}); });
  /* 本地数据库的行 → 文案引擎认识的字段形状。传了 product 就以页面给的那行为准，
     不另查快照：新上架的商品只存在于库里，读不到就会退回到旧数据。 */
  function dbRow(p) {
    return {
      id: p.id, name: p.name, nameEn: p.name_en || p.nameEn || p.name, cat: p.category || p.cat,
      attrs: p.attrs || {}, keywords: p.keywords || [], issues: p.issues || [],
      price: p.price, cost: p.cost, margin: p.margin, target: p.target_country || p.target,
      status: p.status
    };
  }
  API.ai.register('productGenerator', function (input) {
    if (input && input.brief) return generateProduct(input.brief);
    var id = input && (input.id || input.productId);
    var given = input && input.product ? dbRow(input.product) : null;
    var load = given ? Promise.resolve(null) : DS.products();
    return Promise.all([load, DS.market((input && input.iso) || 'USA')]).then(function (r) {
      var mk = r[1];
      var p = given || (r[0].items || []).filter(function (x) { return x.id === id; })[0];
      if (!p) return { error: '商品库中未找到 ' + id };
      var row = (mk.cats || []).filter(function (c) { return String(p.cat).indexOf(c.cat) >= 0 || c.cat.indexOf(p.cat) >= 0; })[0] || null;
      var out = optimizeProduct(p, row);
      out.market = { iso: mk.iso, nodata: !!mk.nodata };
      return out;
    });
  });
  API.ai.register('marketAnalysis', function (input) { return AI.marketReport(input || {}); });

  window.SHOP = {
    chatsInsight: chatsInsight,
    classify: classify,
    topicMix: topicMix,
    overview: overview,
    actionPlan: actionPlan,
    orderAnalysis: orderAnalysis,
    optimize: function (id, iso, opts) {
      var input = { id: id, iso: iso };
      /* 引擎与投放口径要一起送进网关：模型得知道写哪种语言、哪个平台、多少字符以内 */
      Object.keys(opts || {}).forEach(function (k) { input[k] = opts[k]; });
      return API.ai.invoke('productGenerator', input);
    },
    reply: function (chatId) { return API.ai.invoke('customerService', { chatId: chatId }); },
    insight: function (cust) { return API.ai.invoke('customerInsight', { cust: cust }); },
    behavior: function (cust) { return API.ai.invoke('customerBehavior', { cust: cust }); },
    fit: function (input) { return API.ai.invoke('marketFit', input); },
    plan: function () { return API.ai.invoke('storeAnalysis', {}); },
    daily: function () { return API.ai.invoke('dailyPlan', {}); }
  };
})();
