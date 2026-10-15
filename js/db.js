/* 前端数据库客户端：页面所有店铺数据的读写都走这里（对应 tools/store-api.mjs）。
   关键约定：拿不到真实数据就报错，绝不静默换成 mock——「本地数据库未启动」必须显示在页面上。
   window.DB.shop / products / chats / kb ... 返回 Promise；失败时 reject(new Error(接口返回的中文原因))。 */
(function () {
  'use strict';

  var BASE = '';                       // 同源；由 tools/proxy.mjs 提供 /api/db/*
  var state = { checked: false, ok: false, info: null, snapshot: false };

  /* 部署版（公网）没有 proxy 进程：GET 改读 tools/snap-bake.mjs 烘好的静态快照，写操作直接拒。
     只读演示不能伪装成真的改了数据——页面会把这句话显示出来。
     局域网 IP 也算本机：大屏那台机器是用 192.168.x.x 打开的，那里真的有 proxy 和库。 */
  var LOCAL = /^(localhost|127\.|\[::1\]|0\.0\.0\.0$)|^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./;
  /* ?snapshot=1 让本机的 site/ 产物也能按公网那份只读快照跑一遍，不用等发布。
     Node 里没有 location：proxy.mjs / test-shop.mjs 会 eval 这个文件复用引擎，按本机算。 */
  var LOC = typeof location === 'undefined' ? { hostname: 'localhost', search: '' } : location;
  var HOSTED = !LOCAL.test(LOC.hostname) || /[?&]snapshot=1/.test(LOC.search);
  var SNAP = 'data/snap/';
  var snapIdx = null;

  function snapKey(p, query) {
    var qs = query ? Object.keys(query).filter(function (k) {
      return query[k] !== undefined && query[k] !== null && query[k] !== '';
    }).sort().map(function (k) { return k + '=' + query[k]; }).join('&') : '';
    return 'GET ' + p + (qs ? '?' + qs : '');
  }
  function snapIndex() {
    if (!snapIdx) snapIdx = fetch(SNAP + 'index.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw err('只读快照索引读不到（HTTP ' + r.status + '）', r.status);
      return r.json();
    }).catch(function (e) { snapIdx = null; throw e; });
    return snapIdx;
  }
  function snapSend(p, query) {
    return snapIndex().then(function (idx) {
      var key = snapKey(p, query), name = idx.keys[key];
      /* 快照里没烘 jobs（本机这两张表本来就是 0 条）：公网也确实一条都没提交过，按空列表回 */
      if (!name) {
        if (p === '/api/video/jobs' || p === '/api/image/jobs') {
          return { data: { items: [], total: 0 }, meta: { src: 'snapshot', source: OFF } };
        }
        throw err('部署版是只读快照，这一项没有烘进快照：' + key, 404);
      }
      return fetch(SNAP + name).then(function (r) {
        if (!r.ok) throw err('快照文件读不到：' + name, r.status);
        return r.json();
      }).then(function (body) {
        snapFix(p, body);
        body.meta = Object.assign({}, body.meta, { snapshot: idx.generated_at });
        return body;
      });
    });
  }
  /* 快照是在本机隔离服务上抓的，里面写的「连不上 127.0.0.1:9」「key 在 tools/video.env」
     是调试机的事。部署版访客真正遇到的原因是这里根本没有后端，得换成这一句实话。 */
  var OFF = '部署版是只读快照：模型网关与数据库都没有随页面部署，这一项在公网不可用';
  function snapFix(p, body) {
    var d = body && body.data;
    if (!d) return;
    if (p === '/api/db/health') d.file = 'data/snap/';
    if (p === '/api/ai/engines') (d.items || []).forEach(function (e) {
      if (e.key === 'local') { e.model = 'js/shop.js 拼装机 + 只读快照'; return; }
      e.on = false; e.model = '未部署'; e.note = OFF;
    });
    if (p === '/api/video/status' || p === '/api/image/status') { d.on = false; d.note = OFF; }
  }

  function err(msg, status, body) { var e = new Error(msg); e.status = status; e.body = body; return e; }

  function send(method, path, payload, query) {
    if (HOSTED) {
      if (method !== 'GET') {
        return Promise.reject(err('部署版是只读快照，没有后端可写：' + method + ' ' + path, 405));
      }
      return snapSend(path, query);
    }
    var url = BASE + path + (query ? '?' + Object.keys(query).filter(function (k) {
      return query[k] !== undefined && query[k] !== null && query[k] !== '';
    }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); }).join('&') : '');
    var opt = { method: method, headers: { Accept: 'application/json' } };
    if (payload !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(payload); }
    return fetch(url, opt).then(function (r) {
      return r.text().then(function (t) {
        var body = null;
        try { body = t ? JSON.parse(t) : null; } catch (e) { body = { error: '返回非 JSON：' + t.slice(0, 80) }; }
        if (r.status === 503 || r.status === 500) { state.ok = false; throw err((body && body.error) || '本地数据库未启动', r.status, body); }
        if (!r.ok) throw err((body && body.error) || (method + ' ' + path + ' HTTP ' + r.status), r.status, body);
        return body;
      });
    });
  }
  var get = function (p, q) { return send('GET', p, undefined, q); };
  var post = function (p, b) { return send('POST', p, b || {}); };
  var put = function (p, b) { return send('PUT', p, b || {}); };
  var del = function (p) { return send('DELETE', p); };
  var data = function (pr) { return pr.then(function (r) { return r.data; }); };

  /* 启动探活：决定页面顶部是否挂「本地数据库未启动」横幅 */
  function probe() {
    state.snapshot = HOSTED;
    return get('/api/db/health').then(function (r) {
      state.checked = true; state.ok = !!(r.data && r.data.ok && r.data.seeded_at); state.info = r.data;
      return state;
    }).catch(function (e) {
      state.checked = true; state.ok = false; state.info = { error: e.message };
      return state;
    });
  }

  window.DB = {
    status: function () { return state; },
    probe: probe,
    /* 部署版判定与它的直接后果：页面凡是想直接 fetch /api/* 的地方，都改成走这两个口 */
    hosted: HOSTED,
    offNote: OFF,
    raw: function (p, q) { return get(p, q); },
    rawPost: function (p, b) { return post(p, b || {}); },

    health: function () { return data(get('/api/db/health')); },
    shop: function () { return data(get('/api/db/shop')); },
    /* 电商平台接缝：只读，报告每个平台缺哪些凭据；填没填都不会向外部发请求 */
    platforms: function () { return data(get('/api/db/platforms')); },

    products: function (q) { return data(get('/api/db/products', q)); },
    product: function (id) { return data(get('/api/db/products/' + encodeURIComponent(id))); },
    createProduct: function (p) { return data(post('/api/db/products', p)); },
    draftProduct: function (brief) { return data(post('/api/db/products/draft', brief)); },
    scan: function () { return data(get('/api/db/store/scan')); },
    tidy: function (ids) { return data(post('/api/db/store/tidy', { ids: ids || [] })); },
    patchProduct: function (id, patch) { return data(put('/api/db/products/' + encodeURIComponent(id), patch)); },
    productStatus: function (id, action) { return data(post('/api/db/products/' + encodeURIComponent(id) + '/status', { action: action })); },
    productStock: function (id, delta, reason) { return data(post('/api/db/products/' + encodeURIComponent(id) + '/stock', { delta: delta, reason: reason })); },
    productSyncKb: function (id) { return data(post('/api/db/products/' + encodeURIComponent(id) + '/sync-kb', {})); },
    applyCopy: function (id, copy) { return data(post('/api/db/products/' + encodeURIComponent(id) + '/apply-copy', copy)); },
    deleteProduct: function (id) { return data(del('/api/db/products/' + encodeURIComponent(id))); },

    /* with: 'msgs' 时每个会话带完整消息明细（AI 分析读的就是这份） */
    chats: function (q) { return data(get('/api/db/chats', q)); },
    thread: function (cust) { return data(get('/api/db/chats/' + encodeURIComponent(cust))); },
    /* AI 建议回复：draft 只算不写，reply 才真的落一条 messages（改了文本就按人工发送记账） */
    csDraft: function (cust) { return data(get('/api/db/chats/' + encodeURIComponent(cust) + '/draft')); },
    csReply: function (cust, text) { return data(post('/api/db/chats/' + encodeURIComponent(cust) + '/reply', text == null ? {} : { text: text })); },
    /* 演示对话：GET 看还剩几步（提问 / 追问 / 收尾）与已留痕的步数，POST 走一步（真写两条 messages），DELETE 按 ai_ops 反向删 */
    chatDemo: function (cust) { return data(get('/api/db/chats/' + encodeURIComponent(cust) + '/demo')); },
    demoTurn: function (cust) { return data(post('/api/db/chats/' + encodeURIComponent(cust) + '/demo', {})); },
    demoClear: function (cust) { return data(del('/api/db/chats/' + encodeURIComponent(cust) + '/demo')); },
    send: function (m) { return data(post('/api/db/messages', m)); },
    editMessage: function (id, patch) { return data(put('/api/db/messages/' + encodeURIComponent(id), patch)); },
    deleteMessage: function (id) { return data(del('/api/db/messages/' + encodeURIComponent(id))); },
    convUpdate: function (convId, patch) { return data(post('/api/db/chats/' + encodeURIComponent(convId), patch)); },

    customers: function () { return data(get('/api/db/customers')); },
    customer: function (id) { return data(get('/api/db/customers/' + encodeURIComponent(id))); },
    patchCustomer: function (id, patch) { return data(put('/api/db/customers/' + encodeURIComponent(id), patch)); },
    /* 主动跟进：followups 只算不写；sendFollowup 才落一条 messages（改过文本按人工发送记账） */
    followups: function () { return data(get('/api/db/followups')); },
    sendFollowup: function (cust, text) { return data(post('/api/db/customers/' + encodeURIComponent(cust) + '/followup', text == null ? {} : { text: text })); },

    kb: function (q) { return data(get('/api/db/kb', q)); },
    addKb: function (d) { return data(post('/api/db/kb', d)); },
    orders: function (q) { return data(get('/api/db/orders', q)); },
    daily: function (days) { return data(get('/api/db/daily', { days: days })); },
    events: function (cust, q) { return data(get('/api/db/events', Object.assign({ customer_id: cust }, q || {}))); },
    aiOps: function (q) { return data(get('/api/db/ai-ops', q)); },
    logOp: function (o) { return data(post('/api/db/ai-ops', o)); },

    /* 页面统一用它把接口错误转成可见文案 */
    downMessage: function (e) {
      var m = (e && (e.message || e)) + '';
      return e && e.status === 503 ? '本地数据库未启动：' + m : m;
    }
  };
})();
