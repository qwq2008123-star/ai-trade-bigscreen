/* 点击详情抽屉：只叠加浮层，不改动第一/第二屏既有面板。数据全部来自 DS / TRADE。 */
(function () {
  'use strict';

  var host, panel, kind = null, key = null;

  function num(n, d) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }
  function pct(n) { return n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function bars(rows, unit) {
    if (!rows || !rows.length) return '<li class="d-empty">暂无数据</li>';
    var max = Math.max.apply(null, rows.map(function (r) { return r.v || 0; })) || 1;
    return rows.map(function (r) {
      return '<li><span class="d-k">' + esc(r.k) + '</span>' +
        '<span class="d-track"><i style="width:' + Math.max(2, (r.v / max) * 100).toFixed(1) + '%"></i></span>' +
        '<span class="d-v">' + (r.raw != null ? esc(r.raw) : num(r.v, 1) + (unit || '%')) + '</span></li>';
    }).join('');
  }

  function spark(series, w, h) {
    var vals = series.map(function (p) { return p.v; }).filter(function (v) { return v != null; });
    if (vals.length < 2) return '<div class="d-empty">暂无趋势数据</div>';
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = (max - min) || 1;
    var pts = series.map(function (p, i) {
      var x = 8 + i * (w - 16) / Math.max(1, series.length - 1);
      var y = h - 10 - ((p.v == null ? min : p.v) - min) / span * (h - 24);
      return [x, y, p];
    });
    return '<svg class="d-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<polyline points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>' +
      pts.map(function (p) { return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.6"/>'; }).join('') +
      '</svg><div class="d-axis">' + pts.map(function (p) { return '<span>' + esc(p[2].y) + '</span>'; }).join('') + '</div>';
  }

  function tag(text, cls, source) {
    return '<span class="d-src ' + esc(cls) + '" title="' + esc(source || '') + '">' + esc(text) + '</span>';
  }

  function open() { host.classList.add('on'); }
  function close() { host.classList.remove('on'); kind = key = null; }

  function shell(title, sub, badge, body) {
    panel.innerHTML =
      '<div class="d-head"><div><b>' + esc(title) + '</b><em>' + esc(sub || '') + '</em></div>' +
      '<div>' + (badge || '') + '<button class="d-x" type="button">×</button></div></div>' +
      '<div class="d-body">' + body + '</div>';
    panel.querySelector('.d-x').onclick = close;
    open();
  }

  function kpis(rows) {
    return '<div class="d-kpis">' + rows.map(function (r) {
      return '<div class="d-kpi"><span>' + esc(r.k) + '</span><b>' + esc(r.v) + '</b><i>' + esc(r.u || '') + '</i></div>';
    }).join('') + '</div>';
  }
  function sec(t, inner) { return '<div class="d-sec"><h4>' + esc(t) + '</h4>' + inner + '</div>'; }

  function openCountry(iso) {
    kind = 'country'; key = iso;
    var s = window.TRADE && TRADE.stats(iso);
    shell('加载中…', '', '', '<div class="d-loading">正在读取数据层…</div>');
    DS.market(iso).then(function (m) {
      if (kind !== 'country' || key !== iso) return;
      if (!s || s.nodata) {
        shell((m && m.cn) || iso, '', '', '<div class="d-empty">世界银行未收录该经济体数据</div>');
        return;
      }
      var badge = tag(s.live ? '世行·实时接口' : '世行·内嵌快照', 'live', '世界银行 NE.EXP/IMP.GNFS.CD')
        + tag(m.src === 'derived' ? '结构·推算值' : '结构·示例数据', m.src === 'derived' ? 'derived' : 'mock', m.source);
      var body = kpis([
        { k: '进出口贸易总额', v: num(s.total), u: '亿美元 · ' + s.year },
        { k: '出口', v: num(s.exp), u: '亿美元' },
        { k: '进口', v: num(s.imp), u: '亿美元' },
        { k: '中国与该国贸易额', v: m.china.nodata ? '—' : num(m.china.total), u: m.china.nodata ? '暂无双边数据' : '亿美元' }
      ]);
      if (!m.china.nodata && m.china.hist && m.china.hist.length) {
        body += sec('中国与该国贸易趋势', spark(m.china.hist.map(function (h) { return { y: h.y, v: h.amt }; }), 520, 96));
      } else if (m.china.reason) {
        body += sec('中国与该国贸易趋势', '<div class="d-empty">' + esc(m.china.reason) + '</div>');
      }
      body += sec('贸易增长趋势（世界银行·亿美元）', spark((s.hist || []).map(function (h) { return { y: h.y, v: h.amt }; }), 520, 96));
      body += '<div class="d-cols">' +
        sec('主要进口商品', '<ul class="d-bars">' + bars(m.goodsImport.map(function (g) { return { k: g.name, v: g.share }; })) + '</ul>') +
        sec('主要出口商品', '<ul class="d-bars">' + bars(m.goodsExport.map(function (g) { return { k: g.name, v: g.share }; })) + '</ul>') + '</div>';
      body += sec('主要贸易伙伴', '<ul class="d-bars">' + bars(m.partners.map(function (p) { return { k: p.cn, v: p.share }; })) + '</ul>');
      if (m.cats && m.cats.length) {
        body += sec('品类市场（自全球进口·亿美元）', '<ul class="d-cats">' + m.cats.map(function (c) {
          return '<li><b>' + esc(c.cat) + '</b><span>' + num(c.amount) + '</span><em class="' + (c.yoy == null ? '' : c.yoy >= 0 ? 'up' : 'down') + '">' +
            (c.yoy == null ? '增速待接入' : pct(c.yoy)) + '</em><i>' + (c.suppliers || []).map(function (p) { return p.cn + ' ' + p.share + '%'; }).join(' / ') +
            (c.globalSuppliers ? '（全球供应结构）' : '') + '</i></li>';
        }).join('') + '</ul>');
      }
      if (m.barriers && m.barriers.length) {
        body += sec('市场进入注意事项', '<ul class="d-list">' + m.barriers.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>');
      }
      if (m.note) body += '<p class="d-note">' + esc(m.note) + '</p>';
      shell(s.cn, (s.en || '') + ' · ' + iso, badge, body);
    }).catch(function (e) {
      shell('数据读取失败', String(e && e.message || e), '', '<div class="d-empty">请确认 data/countries.json 可访问</div>');
    });
  }

  function openRegion(adcode) {
    kind = 'region'; key = String(adcode);
    shell('加载中…', '', '', '<div class="d-loading">正在读取数据层…</div>');
    DS.region(adcode).then(function (r) {
      if (kind !== 'region' || key !== String(adcode)) return;
      if (r.nodata) {
        shell('未收录地区', 'adcode ' + adcode, '', '<div class="d-empty">该地区暂无产业与贸易结构数据，待接入统计口径</div>');
        return;
      }
      var a = r.amounts;
      var body = kpis(a ? [
        { k: '进出口总额', v: num(a.total), u: a.unit + (a.from === 'SD' ? ' · 第二屏口径' : '') },
        { k: '出口', v: num(a.exp), u: a.unit },
        { k: '进口', v: num(a.imp), u: a.unit }
      ] : [{ k: '进出口总额', v: '—', u: '待接入地区海关数据' }]);
      body += sec('主要产业', '<ul class="d-bars">' + bars(r.industries.map(function (x) { return { k: x.name, v: x.share }; })) + '</ul>');
      body += sec('主要出口商品', '<ul class="d-bars">' + bars(r.exports.map(function (x) { return { k: x.name, v: x.share }; })) + '</ul>');
      body += sec('主要贸易国家', '<ul class="d-bars">' + bars(r.partners.map(function (x) { return { k: x.cn, v: x.share }; })) + '</ul>');
      if (r.cities && r.cities.length) {
        body += sec('下辖地市', '<div class="d-chips">' + r.cities.map(function (c) {
          return '<button type="button" data-code="' + esc(c.adcode) + '">' + esc(c.name) + '</button>';
        }).join('') + '</div>');
      }
      if (r.note) body += '<p class="d-note">' + esc(r.note) + '</p>';
      body += '<p class="d-note">口径：' + esc(r.source) + '</p>';
      shell((r.parent ? r.parent + ' · ' : '') + r.name, (r.level === 'province' ? '省级' : '市级') + ' · adcode ' + r.adcode, tag('示例数据', 'mock', r.source), body);
      panel.querySelectorAll('.d-chips button').forEach(function (b) {
        b.onclick = function () { openRegion(b.dataset.code); };
      });
    }).catch(function (e) {
      shell('数据读取失败', String(e && e.message || e), '', '<div class="d-empty">请确认 data/regions.json 可访问</div>');
    });
  }

  function refresh(iso) { if (kind === 'country') openCountry(iso); }
  function refreshRegion(code) { if (kind === 'region') openRegion(code); }
  function isOpen() { return !!kind; }

  function init() {
    var stage = document.getElementById('stage');
    host = document.createElement('div');
    host.id = 'detailHost';
    panel = document.createElement('aside');
    panel.id = 'detailPanel';
    host.appendChild(panel);
    stage.appendChild(host);
    host.addEventListener('click', function (e) { if (e.target === host) close(); });
    addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', init);
  else init();

  window.Detail = { openCountry: openCountry, openRegion: openRegion, refresh: refresh, refreshRegion: refreshRegion, close: close, isOpen: isOpen };
})();
