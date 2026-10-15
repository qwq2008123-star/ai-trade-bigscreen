const THREE = window.THREE;
const Globe = window.ThreeGlobe;
const TRADE = window.TRADE;

const DEG = Math.PI / 180;
const CN = '中国';

/* ---------- 1920x1080 自适应缩放：按宽度铺满。
   外壳左栏菜单占掉一条宽度后，1920 的窗口已经比 16:9 更窄：
   再按 cover 放大就会把右侧的数据列裁掉，所以宁可上下留一条同色背景带。 ---------- */
function fitStage() {
  /* 优先按宽度铺满；窗口比 16:9 矮时改按高度缩，否则舞台上下各顶出屏幕一截，
     而 html,body 是 overflow:hidden，那几十像素永远滚不回来。 */
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  document.getElementById('stage').style.transform = `scale(${s})`;
}
addEventListener('resize', fitStage);
fitStage();

/* ---------- 状态 ---------- */
const state = { iso: 'USA', tab: 'all', list: [], geo: null, picked: null };

let barChart, worldChart, globe, renderer, scene, camera, labelBox, globeEl;
const orient = { rx: 38 * DEG, ry: -98 * DEG, zoom: 355, targetZoom: 355 };
let lastInteract = 0;
let demoIdx = 0;

const fmtInt = n => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('en-US');

/* ---------- 世界地图 topojson ---------- */
/* 大屏挂在现场：库与底图全部走本地 vendor/，CDN 抖动不该让地球白屏 */
const WORLD_URL = 'vendor/countries-110m.json';

async function loadWorld() {
  const res = await fetch(WORLD_URL);
  const topo = await res.json();
  return topojson.feature(topo, topo.objects.countries);
}

function featureById(geo, id) {
  return geo.features.find(f => String(f.id) === id);
}

function ringContains(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* 命中测试：同一国家的多边形可能在 0°/±360° 两侧，两个副本都试 */
function featContains(feat, lng, lat) {
  const polys = feat.geometry.type === 'Polygon'
    ? [feat.geometry.coordinates] : feat.geometry.coordinates;
  for (const d of [0, 360, -360]) {
    const L = lng + d;
    if (L < -180 || L > 540) continue;
    for (const poly of polys) {
      if (!ringContains(poly[0], L, lat)) continue;
      let holed = false;
      for (let h = 1; h < poly.length; h++) if (ringContains(poly[h], L, lat)) { holed = true; break; }
      if (!holed) return true;
    }
  }
  return false;
}

function countryAt(lng, lat) {
  const feats = state.geo.features;
  for (const f of feats) {
    const bb = bboxOf(f);
    if (!bb) continue;
    for (const d of [0, 360, -360]) {
      const L = lng + d;
      if (L < bb[0] - 1 || L > bb[2] + 1 || lat < bb[1] - 1 || lat > bb[3] + 1) continue;
      if (featContains(f, L, lat)) return f;
    }
  }
  return null;
}

const bbCache = new WeakMap();
function bboxOf(feat) {
  if (bbCache.has(feat)) return bbCache.get(feat);
  let r = null;
  const polys = feat.geometry.type === 'Polygon'
    ? [feat.geometry.coordinates] : feat.geometry.coordinates;
  polys.forEach(poly => poly[0].forEach(([lng, lat]) => {
    if (lat == null || lng == null) return;
    r = r ? [Math.min(r[0], lng), Math.min(r[1], lat), Math.max(r[2], lng), Math.max(r[3], lat)]
          : [lng, lat, lng, lat];
  }));
  bbCache.set(feat, r);
  return r;
}

/* 国家剪影 SVG（等距投影，按包围盒缩放，仅保留主体多边形） */
function silhouetteSvg(feat) {
  let shift = feat.id === '643';
  let polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
  const area = p => {
    let a = 0;
    p[0].forEach(([x1, y1], i) => {
      const [x2, y2] = p[0][(i + 1) % p[0].length];
      a += x1 * y2 - x2 * y1;
    });
    return Math.abs(a / 2);
  };
  const maxA = Math.max(...polys.map(area));
  polys = polys.filter(p => area(p) === maxA);
  const coords = [];
  polys.forEach(p => p.forEach(ring => coords.push(ring)));
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  coords.forEach(ring => ring.forEach(([lng, lat]) => {
    const L = shift && lng < 0 ? lng + 360 : lng;
    minLng = Math.min(minLng, L); maxLng = Math.max(maxLng, L);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }));
  const w = maxLng - minLng, h = maxLat - minLat;
  const S = 100, pad = 4;
  const k = (S - pad * 2) / Math.max(w, h);
  const ox = (S - w * k) / 2, oy = (S - h * k) / 2;
  const px = (lng, lat) => {
    const L = shift && lng < 0 ? lng + 360 : lng;
    return [ox + (L - minLng) * k, oy + (maxLat - lat) * k];
  };
  let d = '';
  polys.forEach(poly => poly.forEach(ring => {
    ring.forEach(([lng, lat], i) => {
      const [x, y] = px(lng, lat);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    });
    d += 'Z';
  }));
  return `<svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}"><path d="${d}"/></svg>`;
}

/* ---------- 左侧国家列表（真实数据 Top 榜） ---------- */
function buildCountryList() {
  if (!state.geo) return;
  state.list = TRADE.top(8).map(r => ({
    iso: r.iso, val: r.val,
    id: TRADE.atlasIdOf(r.iso),
    cn: r.cn,
    en: (TRADE.stats(r.iso) || {}).en || r.iso,
  }));
  document.getElementById('countryList').innerHTML = state.list.map(c => {
    const feat = c.id && featureById(state.geo, c.id);
    return `
    <div class="country-item ${c.iso === state.iso ? 'active' : ''}" data-iso="${c.iso}" title="${c.cn} ${c.en}">
      <span class="country-name"><span class="en">${c.en}</span>/<span class="cn">${c.cn}</span></span>
      <span class="silhouette">${feat ? silhouetteSvg(feat) : ''}</span>
    </div>`;
  }).join('');
}

/* ---------- 右侧 ECharts ---------- */
function barGradient(hl) {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, hl ? [
    { offset: 0, color: '#fff6d8' }, { offset: 0.35, color: '#ffd76a' }, { offset: 1, color: 'rgba(255,182,77,.05)' },
  ] : [
    { offset: 0, color: '#cfe4ff' }, { offset: 0.35, color: '#5f9bea' }, { offset: 1, color: 'rgba(45,90,170,.05)' },
  ]);
}

function initBarChart() {
  barChart = echarts.init(document.getElementById('barChart'));
  barChart.on('click', p => { if (p.data && p.data.iso) pickCountry(p.data.iso); });
}

function renderBar() {
  const rank = TRADE.ranking(state.tab);
  const rows = rank.slice(0, 7);
  const sel = rows.find(r => r.iso === state.iso);
  if (!sel && state.iso !== 'CHN') {
    const s = TRADE.stats(state.iso);
    if (s && !s.nodata) {
      rows.push({ iso: state.iso, cn: s.cn,
        val: state.tab === 'import' ? s.imp : state.tab === 'export' ? s.exp : s.total });
    }
  }
  rows.sort((a, b) => b.val - a.val);
  const max = Math.max(...rows.map(r => r.val), 1);

  barChart.setOption({
    grid: { left: 44, right: 10, top: 26, bottom: 24 },
    animationDuration: 620,
    xAxis: {
      type: 'category', data: rows.map(r => r.cn),
      axisLine: { lineStyle: { color: 'rgba(110,150,210,.4)' } },
      axisTick: { show: false },
      axisLabel: { color: '#8fb0d9', fontSize: 12, interval: 0 },
    },
    yAxis: {
      type: 'value', max: Math.ceil(max * 1.18 / 1000) * 1000,
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: 'rgba(80,120,180,.15)' } },
      axisLabel: { color: '#8fb0d9', fontSize: 11 },
    },
    series: [{
      type: 'bar',
      data: rows.map(r => ({
        value: Math.round(r.val), iso: r.iso,
        itemStyle: { color: barGradient(r.iso === state.iso), borderRadius: [2, 2, 0, 0] },
      })),
      barWidth: 10,
      label: { show: true, position: 'top', color: '#cfe3ff', fontSize: 12,
        formatter: p => fmtInt(p.value) },
    }],
  });
}

function atlasName(iso) {
  if (!state.geo) return null;
  const id = TRADE.atlasIdOf(iso);
  const f = id && featureById(state.geo, id);
  return f ? f.properties.name : null;
}

function initWorldMap() {
  echarts.registerMap('world', state.geo);
  worldChart = echarts.init(document.getElementById('worldMap'));
  worldChart.setOption({
    geo: {
      map: 'world', roam: false,
      left: 4, right: 4, top: 10, bottom: 4,
      aspectScale: 0.9,
      itemStyle: { areaColor: '#5a6e8b', borderColor: '#7d93b0', borderWidth: 0.5 },
      emphasis: { itemStyle: { areaColor: '#93b6e8' }, label: { show: false } },
      regions: [],
    },
  });
  worldChart.on('click', p => {
    if (!p.name) return;
    const f = state.geo.features.find(x => x.properties.name === p.name);
    const iso = f && TRADE.isoOf(f.id);
    if (iso) pickCountry(iso);
  });
}

function renderWorldMap() {
  if (!worldChart) return;
  const nm = atlasName(state.iso);
  worldChart.setOption({
    geo: {
      regions: nm ? [{ name: nm, itemStyle: {
        areaColor: '#4d8dff', borderColor: '#9cc4ff', borderWidth: 1,
        shadowColor: 'rgba(77,141,255,.8)', shadowBlur: 12 } }] : [],
    },
  });
}

/* ---------- 面板 ---------- */
function renderPanels(s) {
  const total = document.getElementById('ovTotal');
  const growth = document.getElementById('ovGrowth');
  const arrow = document.getElementById('ovArrow');
  if (!s || s.nodata) {
    total.textContent = '暂无数据';
    growth.textContent = '—';
    document.getElementById('tcName').textContent = s ? s.cn : '—';
    document.getElementById('tcImport').textContent = '—';
    document.getElementById('tcExport').textContent = '—';
    document.getElementById('tcYear').textContent = '';
    document.getElementById('yearBars').innerHTML =
      `<li class="empty">世界银行未收录该经济体近年贸易数据</li>`;
    arrow.style.transform = 'none';
    arrow.style.opacity = '.35';
    growth.parentElement.classList.remove('down');
    return;
  }
  total.textContent = fmtInt(s.total);
  const up = s.yoy == null || s.yoy >= 0;
  growth.textContent = s.yoy == null ? '—' : Math.abs(s.yoy).toFixed(1);
  growth.parentElement.classList.toggle('down', !up);
  arrow.style.transform = up ? 'none' : 'scaleY(-1)';
  arrow.style.opacity = up ? '1' : '.9';
  document.getElementById('tcName').textContent = s.cn;
  document.getElementById('tcYear').textContent = s.year + '年';
  document.getElementById('tcImport').textContent = fmtInt(s.imp);
  document.getElementById('tcExport').textContent = fmtInt(s.exp);

  const maxPct = Math.max(...s.hist.map(h => h.pct), 1);
  const last = s.hist.length - 1;
  document.getElementById('yearBars').innerHTML = s.hist.map((h, i) => `
    <li class="${i === last ? 'hl' : ''}">
      <span class="y">${h.y}</span>
      <span class="track"><span class="fill" style="width:${(h.pct / maxPct * 100).toFixed(1)}%"></span><span class="dot" style="left:${(h.pct / maxPct * 100).toFixed(1)}%"></span></span>
      <span class="pct">${h.pct.toFixed(1)}%</span>
      <span class="amt">${fmtInt(h.amt)}亿美元</span>
    </li>`).join('');
}

/* ---------- 选中一个国家 ---------- */
let selectSeq = 0;
function select(iso, opts) {
  opts = opts || {};
  const s = TRADE.stats(iso);
  state.iso = iso;
  state.picked = s && !s.nodata ? s : null;
  renderPanels(s);
  renderBar();
  renderWorldMap();
  document.querySelectorAll('.country-item').forEach(el =>
    el.classList.toggle('active', el.dataset.iso === iso));
  if (state.picked && state.picked.ll && opts.fly !== false) flyTo(state.picked.ll[0], state.picked.ll[1]);
  updateGlobeLayers();
  if (window.Detail) Detail.refresh(iso);
  demoIdx = state.list.findIndex(c => c.iso === iso);
  /* 内嵌快照里没有这个经济体的数据时，实时向接口要一次 */
  if (s && s.nodata && !opts.fetched && !TRADE.probed(iso)) {
    const seq = ++selectSeq;
    TRADE.refresh(iso).then(entry => {
      if (entry && seq === selectSeq && state.iso === iso) select(iso, { fetched: true });
    });
  }
}

/* 首次点击保持原来的选中联动；再点一次已选中的国家才打开详情抽屉 */
function pickCountry(iso) {
  if (state.iso === iso) { Detail.openCountry(iso); return; }
  select(iso);
}

/* ---------- 3D 地球 ---------- */
const SPIN = 0.0012;          // rad/frame，约 87 秒一圈
const IDLE_MS = 2600;

function arcPairs() {
  const cn = TRADE.stats('CHN');
  const out = [];
  if (!cn || !cn.ll) return out;
  const add = (iso, strong) => {
    const s = TRADE.stats(iso);
    if (!s || s.nodata || !s.ll || s.iso === 'CHN') return;
    out.push({ a: cn.ll, b: s.ll, strong });
  };
  if (state.iso !== 'CHN') add(state.iso, true);
  TRADE.top(3).forEach(r => { if (r.iso !== state.iso) add(r.iso, false); });
  return out;
}

function initGlobe() {
  globeEl = document.getElementById('globe');
  labelBox = document.getElementById('globe-labels');

  globe = new Globe()
    .globeImageUrl('vendor/earth-dark.jpg')
    .bumpImageUrl('vendor/earth-topology.png')
    .showAtmosphere(true)
    .atmosphereColor('#5b9dff')
    .atmosphereAltitude(0.16)
    .showGraticules(true)
    .pointRadius(0.08)
    .pointAltitude(d => d.alt)
    .pointColor(d => d.color)
    .ringMaxRadius(1.9)
    .ringPropagationSpeed(1.5)
    .ringRepeatPeriod(1700)
    .ringColor(() => t => `rgba(255,215,106,${Math.max(0, .85 - t * .85)})`)
    .arcColor(d => d.strong ? ['rgba(255,232,160,.1)', 'rgba(255,215,106,.9)', 'rgba(255,248,222,.95)']
                            : ['rgba(150,200,255,0)', 'rgba(175,212,255,.3)', 'rgba(215,236,255,.62)'])
    .arcAltitude(d => d.strong ? 0.42 : 0.3)
    .arcDashLength(d => d.strong ? 0.4 : 0.28)
    .arcDashGap(d => d.strong ? 0.16 : 0.3)
    .arcDashAnimateTime(d => d.strong ? 2600 : 5200)
    .arcStroke(d => d.strong ? 0.8 : 0.3);

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  globeEl.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.add(globe);
  scene.add(new THREE.AmbientLight(0xbcd2ff, Math.PI * 1.05));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6 * Math.PI);
  sun.position.set(-260, 240, 320);
  scene.add(sun);

  const gm = globe.globeMaterial();
  gm.specular = new THREE.Color(0x0a1220);
  gm.shininess = 2;

  globe.traverse(o => {
    if (o.isLineSegments && o.material && o.material.isLineBasicMaterial) {
      o.material.opacity = 0.75;
      o.material.color = new THREE.Color(0xdfeaff);
    }
  });

  camera = new THREE.PerspectiveCamera(35, 1, 1, 2000);
  camera.position.z = orient.zoom;

  globe.position.set(10, -33, 0);

  /* 透明拾取球：只用于点击命中，不参与渲染 */
  const pick = new THREE.Mesh(
    new THREE.SphereGeometry(globe.getGlobeRadius ? globe.getGlobeRadius() : 100, 32, 24),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  globe.add(pick);

  initGlobeInput(pick);
  updateGlobeLayers();
  resize();
  addEventListener('resize', resize);
  animate();
}

function updateGlobeLayers() {
  if (!globe) return;
  const pairs = arcPairs();
  globe.arcsData(pairs.map(p => ({
    startLat: p.a[0], startLng: p.a[1], endLat: p.b[0], endLng: p.b[1], strong: p.strong,
  })));

  const pts = [], rings = [];
  TRADE.ranking('all').slice(0, 18).forEach((r, i) => {
    const s = TRADE.stats(r.iso);
    if (!s || !s.ll) return;
    const hot = s.iso === state.iso;
    pts.push({ lat: s.ll[0], lng: s.ll[1], rank: i,
      alt: 0.008 + 0.05 * Math.min(1, r.val / 74000),
      color: hot ? 'rgba(255,222,120,.95)' : 'rgba(120,190,255,.72)' });
    if (hot || i < 5) rings.push({ lat: s.ll[0], lng: s.ll[1], speed: hot ? 1.4 : 0.9, color: hot });
  });
  const cn = TRADE.stats('CHN');
  if (cn && cn.ll) rings.push({ lat: cn.ll[0], lng: cn.ll[1], speed: 1.1, color: true });
  globe.pointsData(pts).ringsData(rings);
  refreshLabels();
}

function refreshLabels() {
  if (!labelBox) return;
  const show = [];
  const cn = TRADE.stats('CHN');
  if (cn && cn.ll) show.push({ ll: cn.ll, name: CN, cls: 'base' });
  if (state.picked && state.picked.ll && state.iso !== 'CHN')
    show.push({ ll: state.picked.ll, name: state.picked.cn, cls: 'sel' });
  TRADE.top(6).forEach(r => {
    if (r.iso === state.iso || show.length > 4) return;
    const s = TRADE.stats(r.iso);
    if (!s || !s.ll) return;
    const near = show.some(o => Math.hypot(o.ll[0] - s.ll[0], o.ll[1] - s.ll[1]) < 16);
    if (!near) show.push({ ll: s.ll, name: s.cn, cls: '' });
  });
  labelBox.innerHTML = show.map(d =>
    `<div class="g-label ${d.cls}"><span class="ring"><i></i></span>${d.name}</div>`).join('');
  labelBox._items = [...labelBox.children].map((el, i) => ({ el, d: show[i] }));
}

function initGlobeInput(pickMesh) {
  const dom = renderer.domElement;
  const ray = new THREE.Raycaster();
  let down = null, dragging = false, pid = null;

  dom.addEventListener('pointerdown', e => {
    down = { x: e.clientX, y: e.clientY, t: Date.now() };
    dragging = false; pid = e.pointerId;
    lastInteract = Date.now();
    dom.setPointerCapture(pid);
  });

  dom.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!dragging && Math.hypot(dx, dy) > 6) { dragging = true; globeEl.classList.add('dragging'); }
    if (!dragging) return;
    const k = 1 / (1920 / Math.max(1, innerWidth));   // 缩放后手感一致
    orient.ry += (e.movementX || dx) * 0.0058 * k;
    orient.rx = Math.max(-1.15, Math.min(1.15, orient.rx + (e.movementY || dy) * 0.0042 * k));
    down.x = e.clientX; down.y = e.clientY;
    lastInteract = Date.now();
  });

  const up = e => {
    globeEl.classList.remove('dragging');
    if (dragging) { dragging = false; down = null; return; }
    if (!down) return;
    const quick = Date.now() - down.t < 500;
    down = null;
    if (!quick) return;
    const rect = dom.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera({ x: nx, y: ny }, camera);
    const hit = ray.intersectObject(pickMesh, false)[0];
    if (!hit) return;
    globe.updateMatrixWorld(true);
    const lp = globe.worldToLocal(hit.point.clone());
    const r = lp.length();
    const lat = Math.asin(lp.y / r) / DEG;
    const lng = Math.atan2(lp.x, lp.z) / DEG;
    const f = countryAt(lng, lat);
    const iso = f && TRADE.isoOf(f.id);
    if (iso) pickCountry(iso);
  };
  dom.addEventListener('pointerup', up);
  dom.addEventListener('pointercancel', () => { down = null; dragging = false; globeEl.classList.remove('dragging'); });

  dom.addEventListener('wheel', e => {
    e.preventDefault();
    orient.targetZoom = Math.max(250, Math.min(520, orient.targetZoom + e.deltaY * 0.28));
    lastInteract = Date.now();
  }, { passive: false });

  // 作为 index.html 的一屏嵌入时，地球之外的滚轮交给外壳翻页（捕获阶段：ECharts 会拦截冒泡）
  if (top !== window) {
    addEventListener('wheel', e => {
      if (e.target !== dom && !e.ctrlKey) parent.postMessage({ swipe: e.deltaY }, '*');
    }, { passive: true, capture: true });
    // 键盘事件不会跨 iframe 冒泡，方向键要手动转给外壳
    addEventListener('keydown', e => {
      if (/^Arrow(Up|Down)$|^Page(Up|Down)$/.test(e.key)) parent.postMessage({ navKey: e.key }, '*');
    });
  }
}

function bindUI() {
  document.getElementById('countryList').addEventListener('click', e => {
    const it = e.target.closest('.country-item');
    if (it && it.dataset.iso) pickCountry(it.dataset.iso);
  });
  document.getElementById('tcName').addEventListener('click', () => Detail.openCountry(state.iso));
  document.getElementById('tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.key;
    renderBar();
  });
}

/* 飞行到某个经纬度：把该点转到视野中心（rotation.x = lat, rotation.y = -lng） */
let fly = null;
function flyTo(lat, lng) {
  const trxD = lat * DEG;
  let tryD = -lng * DEG;
  const cur = orient.ry % (Math.PI * 2);
  let d = ((tryD - cur) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  fly = { fromX: orient.rx, toX: trxD, fromY: orient.ry, toY: orient.ry + d, t0: performance.now(), dur: 1150 };
}

function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

function resize() {
  const w = globeEl.clientWidth, h = globeEl.clientHeight;
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = h + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function updateLabels() {
  const items = labelBox._items;
  if (!items) return;
  const w = globeEl.clientWidth, h = globeEl.clientHeight;
  globe.updateMatrixWorld();
  for (const { el, d } of items) {
    const c = globe.getCoords(d.ll[0], d.ll[1], 0.02);
    const world = new THREE.Vector3(c.x, c.y, c.z).applyMatrix4(globe.matrixWorld);
    const normal = world.clone().normalize();
    const toCam = camera.position.clone().sub(world).normalize();
    const front = normal.dot(toCam) > 0.12;
    const ndc = world.clone().project(camera);
    el.style.display = front ? 'flex' : 'none';
    if (front) {
      el.style.left = ((ndc.x + 1) / 2 * w) + 'px';
      el.style.top = ((1 - ndc.y) / 2 * h - 18) + 'px';
    }
  }
}

/* 作为 index.html 的一屏嵌入时，非当前屏暂停渲染 */
let paused = false;
addEventListener('message', e => { if (e.data && 'active' in e.data) paused = !e.data.active; });

function animate() {
  if (paused) { requestAnimationFrame(animate); return; }
  const now = performance.now();
  if (fly) {
    const t = Math.min(1, (now - fly.t0) / fly.dur);
    const e = ease(t);
    orient.rx = fly.fromX + (fly.toX - fly.fromX) * e;
    orient.ry = fly.fromY + (fly.toY - fly.fromY) * e;
    if (t >= 1) fly = null;
  } else if (!lastInteract || now - lastInteract > IDLE_MS) {
    orient.ry += SPIN;
  }
  orient.zoom += (orient.targetZoom - orient.zoom) * 0.12;
  camera.position.z = orient.zoom;
  globe.rotation.set(orient.rx, orient.ry, 0);
  renderer.render(scene, camera);
  updateLabels();
  requestAnimationFrame(animate);
}

/* ---------- 顶栏时钟 + 演示轮播 ---------- */
function startClock() {
  const el = document.getElementById('clock');
  const p = n => String(n).padStart(2, '0');
  const step = () => {
    const d = new Date();
    el.textContent = `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  step();
  setInterval(step, 1000);
}

let demoTimer = null, demoOff = false;
function startDemo() {
  if (new URLSearchParams(location.search).has('nodemo')) { demoOff = true; return; }
  demoTimer = setInterval(() => {
    if (demoOff || document.hidden) return;
    if (Date.now() - lastInteract < 12000) return;
    demoIdx = (demoIdx + 1) % state.list.length;
    select(state.list[demoIdx].iso);
  }, 9000);
}

/* ---------- 数据刷新：分批请求换回全球最新值，失败则保留内嵌快照 ---------- */
function liveRefresh() {
  if (new URLSearchParams(location.search).has('offline')) return;
  const tag = document.getElementById('srcTag');
  tag.textContent = 'World Bank 同步中…';
  tag.dataset.busy = '1';
  const all = TRADE.isos();
  const chunks = [];
  for (let i = 0; i < all.length; i += 55) chunks.push(all.slice(i, i + 55));
  Promise.all(chunks.map(c => TRADE.refreshMany(c)))
    .then(res => {
      const ok = new Set(res.flat()).size;
      delete tag.dataset.busy;
      if (ok) tag.dataset.live = '1';
      tag.textContent = ok ? `World Bank 实时 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
                           : 'World Bank · 内嵌快照';
      buildCountryList();
      updateGlobeLayers();
      renderBar();
      renderPanels(TRADE.stats(state.iso));
    })
    .catch(() => { tag.textContent = 'World Bank · 内嵌快照'; });
}

/* ---------- 全球经贸新闻 ----------
   条目一律来自 data/news.json（接了真实资讯接口后由 js/api.js 覆盖同一份契约）。
   以前这三条是写死在 screen1.html 里的 2023-08-06 旧闻，而且同一条重复了两遍。 */
function renderNews() {
  const box = document.getElementById('newsList');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const one = txt => { box.innerHTML = `<li class="news-item dim"><div class="news-head"><span class="news-text">${txt}</span></div></li>`; };
  DS.news(3).then(items => {
    if (!items || !items.length) return one('暂无资讯：data/news.json 里没有条目');
    /* 最新一条展开正文，其余单行省略——面板高度与参考稿一致 */
    box.innerHTML = items.map((n, i) => {
      const head = `<div class="news-head"><span class="news-text">${esc(n.title)}</span>` +
        `<span class="news-date">${esc(n.date)}</span></div>`;
      return i === 0 ? `<li class="news-item active">${head}<p class="news-desc">${esc(n.desc)}</p></li>`
                     : `<li class="news-item dim">${head}</li>`;
    }).join('');
    const meta = (DS.provenance() || {}).news || {};
    document.getElementById('newsSrc').textContent = meta.note || 'data/news.json';
  }).catch(() => one('资讯未加载：data/news.json 读不到'));
}

/* ---------- 启动 ---------- */
(async () => {
  initBarChart();
  startClock();
  document.getElementById('srcTag').textContent = 'World Bank 内嵌快照';
  renderNews();
  try {
    state.geo = await loadWorld();
    initWorldMap();
    buildCountryList();
  } catch (e) { console.error('world data failed:', e); }
  try { initGlobe(); } catch (e) { console.error('globe failed:', e); }
  bindUI();
  select(state.iso, { fly: false });
  startDemo();
  liveRefresh();
})();
