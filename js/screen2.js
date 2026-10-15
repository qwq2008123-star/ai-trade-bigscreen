/* 第二屏：福建省 3D 挤出地图 + 右侧图表 */
const THREE = window.THREE;
const FJ = window.FJ;
const DEG = Math.PI / 180;

/* ---------- 1920x1080 自适应缩放：按宽度铺满，窗口比 16:9 更扁时上下各裁掉一点 ---------- */
function fitStage() {
  /* 优先按宽度铺满：左栏菜单挤掉的那条宽度不该由右侧数据列来承担；窗口比 16:9 矮时改按高度缩，
     否则舞台上下会各顶出屏幕一截，而 html,body 是 overflow:hidden，那几十像素永远滚不回来。 */
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  document.getElementById('stage').style.transform = `scale(${s})`;
}
addEventListener('resize', fitStage);
fitStage();

/* ---------- 地理 -> 平面投影（单位：世界坐标） ---------- */
/* 福建省 bbox：经 115.853~120.726，纬 23.549~28.312，接近正方形（约 488km x 529km） */
const GEO_C = { lng: 118.289, lat: 25.931 };
const KX = 111.32 * Math.cos(GEO_C.lat * DEG) * 1.75;
const KY = 111 * 1.75;
const projX = lng => (lng - GEO_C.lng) * KX;
const projY = lat => (lat - GEO_C.lat) * KY;   // 本地 +y 朝北；世界 z = -y

/* ---------- 相机 ---------- */
const DEPTH = 40;
const TOP = DEPTH + 2;   // bevelThickness 会把顶面再抬高 2
const CAM = { fov: 33, dist: 1760, elev: 49 * DEG, ox: 250, oy: -70 };

/* ---------- 状态 ---------- */
const state = {
  tab: 'all',
  month: null,           // null = 全年（默认，画面与设计稿一致）；0~7 = 回放到第几个月
  geo: null, outline: null, china: null,
  cities: [],            // { adcode, name, mesh, mat, center:[lng,lat] }
  pillars: [],           // { adcode, group, beam, rings[], label }
  selected: 350200,
  layer: 'factories',
  layerItems: [],
  bounds: null,
  yaw: 0, yawTarget: 0, tilt: 0, tiltTarget: 0, zoom: 1, zoomTarget: 1
};

let renderer, scene, camera, mapGroup, labelBox, glowMesh;
let pickList = [];

/* ---------- 数据加载 ---------- */
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' -> ' + res.status);
  return res.json();
}

/* ---------- 几何工具 ---------- */
function ringToV2(ring) {
  const n = ring.length;
  const last = ring[n - 1], first = ring[0];
  const cut = (Math.abs(last[0] - first[0]) < 1e-9 && Math.abs(last[1] - first[1]) < 1e-9) ? n - 1 : n;
  const pts = [];
  for (let i = 0; i < cut; i++) pts.push(new THREE.Vector2(projX(ring[i][0]), projY(ring[i][1])));
  return pts;
}

function geomToShapes(geom) {
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const out = [];
  polys.forEach(rings => {
    if (!rings.length || rings[0].length < 4) return;
    const s = new THREE.Shape(ringToV2(rings[0]));
    for (let i = 1; i < rings.length; i++) s.holes.push(new THREE.Path(ringToV2(rings[i])));
    out.push(s);
  });
  return out;
}

function geomToRings(geom) {
  if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const out = [];
  polys.forEach(rings => { if (rings.length) out.push(rings[0]); });
  return out;
}

/* ---------- 程序化纹理 ---------- */
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) & 0x7fffffff) / 0x7fffffff;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < 5; i++) { s += amp * vnoise(x * f, y * f); amp *= 0.5; f *= 2.07; }
  return s;
}

/* 福建主要山系：[经度, 纬度, 强度, 半径(世界单位)]，让起伏落在真实位置 */
const MASSIFS = [
  [117.95, 27.72, 1.00, 120],  // 武夷山北段（闽赣界山）
  [118.85, 27.28, 0.82, 95],   // 洞宫山
  [119.05, 26.98, 0.66, 75],   // 鹫峰山
  [120.18, 27.13, 0.50, 55],   // 太姥山（东北海岸）
  [118.10, 25.65, 0.95, 110],  // 戴云山（中枢）
  [117.55, 25.95, 0.60, 85],   // 尤溪—大田低山
  [117.30, 25.15, 0.58, 80],   // 博平岭
  [116.85, 25.35, 0.62, 85],   // 玳瑁山
  [117.05, 26.30, 0.48, 70],   // 闽西北低山
  [118.55, 24.95, 0.40, 55],   // 泉州—南安丘陵
  [117.35, 24.35, 0.42, 65],   // 漳州西北低山
  [118.05, 26.85, 0.55, 70]    // 建溪—富屯溪山地
];
function massifAt(wx, wy) {
  let s = 0;
  for (let i = 0; i < MASSIFS.length; i++) {
    const m = MASSIFS[i];
    const dx = wx - projX(m[0]), dy = wy - projY(m[1]);
    const d2 = (dx * dx + dy * dy) / (m[3] * m[3]);
    if (d2 > 9) continue;
    const v = m[2] * Math.exp(-d2);
    if (v > s) s = v;
  }
  return s > 1 ? 1 : s;
}

/* 福建地表：暗色卫星影像质感 */
function terrainTexture(b) {
  const W = 1024, H = Math.max(320, Math.round(W * (b.maxY - b.minY) / (b.maxX - b.minX)));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const e = new Float32Array(W * H), mv = new Float32Array(W * H);
  const cl = v => v < 0 ? 0 : v > 1 ? 1 : v;
  for (let j = 0; j < H; j++) {
    const wy = b.maxY - (j + 0.5) / H * (b.maxY - b.minY);
    for (let i = 0; i < W; i++) {
      const wx = b.minX + (i + 0.5) / W * (b.maxX - b.minX);
      const L = massifAt(wx, wy);
      const base = fbm(wx * 0.0095 + 4.2, wy * 0.0095 - 1.7);
      const m = cl((base - (0.64 - 0.36 * L)) * 3.4);
      const ridge = 1 - Math.abs(fbm(wx * 0.0105, wy * 0.0105) * 2 - 1);
      const fine = fbm(wx * 0.032 + 9.5, wy * 0.032 + 3.1);
      const k = j * W + i;
      mv[k] = m;
      e[k] = base * 0.52 + L * 0.20 + (ridge * 0.36 + fine * 0.14) * (0.10 + 0.90 * m);
    }
  }
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let j = 0; j < H; j++) {
    const jp = Math.max(0, j - 1) * W, jn = Math.min(H - 1, j + 1) * W, jc = j * W;
    for (let i = 0; i < W; i++) {
      const ip = Math.max(0, i - 1), ix = Math.min(W - 1, i + 1);
      const k = jc + i;
      const hs = cl(0.5 + (-(e[jc + ix] - e[jc + ip]) - (e[jn + i] - e[jp + i]))
        * 22 * (0.10 + 0.90 * mv[k]));
      const el = cl((e[k] - 0.34) * 1.6);
      const v = 0.10 + el * 0.34 + hs * 0.52 * (0.10 + 0.90 * mv[k]);
      const lv = v * 200;
      d[k * 4] = lv > 2 ? lv + 2 : 0;
      d[k * 4 + 1] = lv + 12;
      d[k * 4 + 2] = 31 + lv;
      d[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // 轻微模糊：设计稿的山地是柔和起伏，不是硬边噪斑
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  tmp.getContext('2d').drawImage(cv, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.filter = 'blur(0.7px)';
  ctx.drawImage(tmp, 0, 0);
  ctx.filter = 'none';
  const tex = new THREE.CanvasTexture(cv);
  applyMapUV(tex, b);
  return tex;
}

function applyMapUV(tex, b) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / (b.maxX - b.minX), 1 / (b.maxY - b.minY));
  tex.offset.set(-b.minX / (b.maxX - b.minX), -b.minY / (b.maxY - b.minY));
}

/* 选中市的浅色渐变 */
function highlightTexture(b) {
  const cv = document.createElement('canvas'); cv.width = 4; cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#c2d8f2');
  g.addColorStop(0.55, '#8fb4de');
  g.addColorStop(1, '#5d87bd');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(cv);
  applyMapUV(tex, b);
  return tex;
}

/* 光柱贴图 */
function beamTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 256, 0, 0);
  g.addColorStop(0, 'rgba(255,255,255,.95)');
  g.addColorStop(0.12, 'rgba(226,242,255,.9)');
  g.addColorStop(0.72, 'rgba(160,205,255,.55)');
  g.addColorStop(1, 'rgba(140,195,255,0)');
  ctx.fillStyle = g;
  ctx.filter = 'blur(5px)';
  ctx.fillRect(24, 6, 16, 250);
  ctx.filter = 'blur(1.6px)';
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.fillRect(29, 8, 6, 248);
  ctx.filter = 'none';
  const t = new THREE.CanvasTexture(cv);
  t.needsUpdate = true;
  return t;
}

/* 省界发光贴图：在平面上多次描边 */
function glowTexture(b, features) {
  const W = 1900, H = 1290;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  // 向外扩 12%，避免光晕被贴图边界裁掉
  const ex = (b.maxX - b.minX) * 0.12, ey = (b.maxY - b.minY) * 0.12;
  const x0 = b.minX - ex, y1 = b.maxY + ey;
  const sx = W / (b.maxX - b.minX + ex * 2), sy = H / (b.maxY - b.minY + ey * 2);
  const path = new Path2D();
  features.forEach(f => {
    geomToRings(f.geometry).forEach(ring => {
      ring.forEach((pt, i) => {
        const x = (projX(pt[0]) - x0) * sx, y = (y1 - projY(pt[1])) * sy;
        if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
      });
      path.closePath();
    });
  });
  ctx.lineJoin = ctx.lineCap = 'round';
  const passes = [
    [62, 'rgba(28,92,205,.10)', 70],
    [34, 'rgba(46,124,232,.17)', 46],
    [16, 'rgba(88,164,252,.34)', 24],
    [6, 'rgba(150,208,255,.68)', 10],
    [2.6, 'rgba(214,238,255,.95)', 4]
  ];
  passes.forEach(p => {
    ctx.save();
    ctx.shadowColor = 'rgba(70,150,255,.85)'; ctx.shadowBlur = p[2];
    ctx.lineWidth = p[0]; ctx.strokeStyle = p[1];
    ctx.stroke(path);
    ctx.restore();
  });
  const t = new THREE.CanvasTexture(cv);
  t.needsUpdate = true;
  return t;
}

/* ---------- 地图构建 ---------- */
function computeBounds() {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  state.geo.features.forEach(f => {
    geomToRings(f.geometry).forEach(r => r.forEach(pt => {
      const x = projX(pt[0]), y = projY(pt[1]);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }));
  });
  const padX = (maxX - minX) * 0.06, padY = (maxY - minY) * 0.09;
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

function buildCities(b) {
  const sideMat = new THREE.MeshPhongMaterial({ color: 0x081a33, specular: 0x14365f, shininess: 20, emissive: 0x030c1a });
  const topMat = new THREE.MeshPhongMaterial({
    map: terrainTexture(b), color: 0xffffff, specular: 0x0e1620, shininess: 4,
    emissive: 0x06111f, emissiveIntensity: 0.7
  });
  const hlMat = new THREE.MeshPhongMaterial({
    map: highlightTexture(b), color: 0xd6e4f5, specular: 0x1a2838, shininess: 8,
    emissive: 0x0e1c30, emissiveIntensity: 0.35
  });

  state.geo.features.forEach(f => {
    const shapes = geomToShapes(f.geometry);
    if (!shapes.length) return;
    const geo = new THREE.ExtrudeGeometry(shapes, {
      depth: DEPTH, bevelEnabled: true, bevelThickness: 2, bevelSize: 2, bevelSegments: 1, curveSegments: 1
    });
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, [topMat, sideMat]);
    mesh.userData.adcode = f.properties.adcode;
    mapGroup.add(mesh);
    pickList.push(mesh);
    state.cities.push({
      adcode: f.properties.adcode,
      name: f.properties.name,
      center: f.properties.center || f.properties.centroid,
      mesh, baseMat: topMat, hlMat
    });
    // 市界
    const ringPts = geomToRings(f.geometry);
    ringPts.forEach(r => {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          r.map(pt => new THREE.Vector3(projX(pt[0]), TOP + 1.4, -projY(pt[1]))).concat(
            [new THREE.Vector3(projX(r[0][0]), TOP + 1.4, -projY(r[0][1]))]
          )
        ),
        new THREE.LineBasicMaterial({ color: 0xbcd9f7, transparent: true, opacity: 0.3 })
      );
      mapGroup.add(line);
    });
  });

  // 外发光：贴在地表平面上的描边纹理，与投影严格对齐
  const gw = b.maxX - b.minX, gh = b.maxY - b.minY;
  const cx = (b.minX + b.maxX) / 2, cz = -(b.minY + b.maxY) / 2;
  const gTex = glowTexture(b, state.outline.features);
  const mkGlow = (sx, sy, op) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(gw * sx, gh * sy),
      new THREE.MeshBasicMaterial({
        map: gTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, opacity: op
      })
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  };
  glowMesh = mkGlow(1.24, 1.24, 0.5);
  glowMesh.position.set(cx, TOP + 0.6, cz);
  mapGroup.add(glowMesh);
}

/* 底图：周边省市暗色轮廓，营造卫星底图层次 */
function featureBBox(geom) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  const walk = c => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1];
      return;
    }
    c.forEach(walk);
  };
  if (geom) walk(geom.coordinates);
  return [x0, y0, x1, y1];
}

function buildBase() {
  const mat = new THREE.MeshBasicMaterial({ color: 0x0a1421, transparent: true, opacity: 0.95 });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x5f86b8, transparent: true, opacity: 0.12 });
  const group = new THREE.Group();
  state.china.features.forEach(f => {
    const p = f.properties || {};
    if (p.adcode === 350000) return;                       // 福建本体由挤出层负责
    const bb = featureBBox(f.geometry);
    if (bb[2] < 108 || bb[0] > 125 || bb[3] < 19 || bb[1] > 32) return;  // 只保留视野内的省份（闽浙赣粤台海）
    const shapes = geomToShapes(f.geometry);
    if (!shapes.length) return;
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shapes, 1), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = -6;
    group.add(m);
    geomToRings(f.geometry).forEach(r => {
      const v = r.map(pt => new THREE.Vector3(projX(pt[0]), -5, -projY(pt[1])));
      v.push(v[0].clone());
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), lineMat));
    });
  });
  scene.add(group);
  return group;
}

/* ---------- 光柱 ---------- */
let beamTex;

/* 光柱读哪一组数：全年 = 各市年额（与设计稿一致）；回放某月 = FJ.monthRank 摊出来的月值。
   peak 一起换，所以柱子高矮在任何口径下都严格按金额排，不会出现「月份切换后矮的反而大」。 */
function pillarData() {
  if (!monthOn()) {
    const rank = FJ.ranking(state.tab);
    return { peak: rank[0][state.tab], items: rank.map(c => ({ adcode: c.adcode, name: c.name, v: c[state.tab] })) };
  }
  return FJ.monthRank(state.tab, state.month);
}

function clearPillars() {
  state.pillars.forEach(p => {
    mapGroup.remove(p.group);
    p.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    if (p.label) p.label.remove();
    if (p.lead) p.lead.remove();
  });
  state.pillars = [];
}

function buildPillars() {
  clearPillars();
  const pd = pillarData();
  const list = pd.items.slice(0, FJ.maxPillars);
  const mo = monthOn() ? FJ.months[state.month] : '';
  list.forEach((c, i) => {
    const city = state.cities.find(x => x.adcode === c.adcode);
    if (!city) return;
    const ratio = Math.pow(c.v / pd.peak, 0.5);
    const h = 92 + 96 * ratio;
    const x = projX(city.center[0]), z = -projY(city.center[1]);
    const g = new THREE.Group();
    g.position.set(x, TOP, z);

    const isSel = c.adcode === state.selected;
    const beamGeo = new THREE.PlaneGeometry(44, h);
    const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      map: beamTex, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
      color: isSel ? 0xffd06a : 0xbcd9ff,
      side: THREE.DoubleSide
    }));
    beam.position.y = h / 2;
    g.add(beam);

    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(isSel ? 5 : 4, 12, 10),
      new THREE.MeshBasicMaterial({ color: isSel ? 0xfff0cc : 0xeaf6ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    cap.position.y = h;
    g.add(cap);

    const rings = [];
    for (let k = 0; k < 2; k++) {
      const rg = new THREE.Mesh(
        new THREE.RingGeometry(10, 12, 40),
        new THREE.MeshBasicMaterial({
          color: isSel ? 0xffd76a : 0xaad4ff, transparent: true, opacity: 0.7,
          side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false
        })
      );
      rg.rotation.x = -Math.PI / 2;
      rg.position.y = 1.5 + k * 0.6;
      rg.userData.phase = k * 0.5;
      g.add(rg); rings.push(rg);
    }
    const dot = new THREE.Mesh(
      new THREE.CircleGeometry(6, 24),
      new THREE.MeshBasicMaterial({ color: isSel ? 0xfff3d4 : 0xdceeff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    dot.rotation.x = -Math.PI / 2; dot.position.y = 1;
    g.add(dot);

    mapGroup.add(g);

    const el = document.createElement('div');
    el.className = 'm-label' + (isSel ? ' sel' : '');
    el.innerHTML = `<span class="rank">${i + 1}</span>` +
      `<span class="chip"><span class="cn">${c.name}</span><span class="amt">${FJ.fmt(c.v)}${FJ.unit}${mo ? ' · ' + mo : ''}</span></span>`;
    labelBox.appendChild(el);

    const lead = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    lead.setAttribute('class', 'm-lead' + (isSel ? ' sel' : ''));
    leadsBox().appendChild(lead);

    state.pillars.push({ group: g, beam, beamGeo, cap, rings, label: el, lead, labelW: el.offsetWidth, h, top: new THREE.Vector3(x, TOP + h, z) });
  });
}

/* ---------- 供应链图层 ---------- */
function renderLayerBtns() {
  document.getElementById('layerBtns').innerHTML = FJ.layerDefs.map(d =>
    `<button class="sd-layer${d.key === state.layer ? ' on' : ''}" data-layer="${d.key}">${d.label}</button>`
  ).join('');
}

function buildLayer() {
  labelBox.querySelectorAll('.layer-item').forEach(el => el.remove());
  const L = FJ.layer(state.layer);
  state.layerItems = L.items.map(it => {
    const city = state.cities.find(x => x.adcode === it.adcode);
    if (!city) return null;
    const el = document.createElement('div');
    el.className = 'layer-item' + (it.value ? '' : ' none') + (it.adcode === state.selected ? ' sel' : '');
    el.dataset.adcode = it.adcode;
    /* 点的大小按「本层最大值」归一，只表达相对密度，不额外造数 */
    const k = L.max ? 0.55 + 1.15 * Math.sqrt(it.value / L.max) : 0.55;
    el.innerHTML = `<i class="ld" style="transform:scale(${k.toFixed(2)})"></i><span class="lt">${it.text}</span>` +
      (it.sub ? `<em>${it.sub}</em>` : '');
    labelBox.appendChild(el);
    return { el, pos: new THREE.Vector3(projX(city.center[0]), TOP + 2, -projY(city.center[1])) };
  }).filter(Boolean);
  document.getElementById('layerInfo').innerHTML =
    `${L.label}合计 <b>${FJ.fmt(L.total)}</b>${L.unit} · 覆盖 <b>${L.covered}/${L.items.length}</b> 个设区市<br>` +
    `<span class="src">来源 ${L.src} · ${L.tag}</span>`;
}

function refreshLayerLabels() {
  state.layerItems.forEach(it => {
    tmpV.copy(it.pos).applyMatrix4(mapGroup.matrixWorld).project(camera);
    it.el.style.transform = `translate(${Math.round(tmpV.x * 960 + 960) - 6}px, ${Math.round(-tmpV.y * 540 + 540) + 15}px) translate(-100%, -50%)`;
    it.el.style.opacity = tmpV.z < 1 ? '' : '0';
  });
}

/* ---------- 拾取 / 选中 ---------- */
function applySelection() {
  state.cities.forEach(c => {
    const on = c.adcode === state.selected;
    c.mesh.material[0] = on ? c.hlMat : c.baseMat;
  });
  labelBox.querySelectorAll('.layer-item').forEach(el => {
    el.classList.toggle('sel', +el.dataset.adcode === state.selected);
  });
}

function setSelected(adcode) {
  if (!adcode || state.selected === adcode) return;
  state.selected = adcode;
  applySelection();
  buildPillars();
  if (window.Detail) Detail.refreshRegion(adcode);
}

/* 首次点击保持原来的选中联动；再点一次已选中的城市才打开详情抽屉 */
function pickRegion(adcode) {
  if (state.selected === adcode) { if (window.Detail) Detail.openRegion(adcode); return; }
  setSelected(adcode);
}

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function pickAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(pickList, false)[0];
  return hit ? hit.object.userData.adcode : null;
}

/* ---------- 场景 ---------- */
function initScene() {
  const el = document.getElementById('map3d');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(1920, 1080, false);
  renderer.domElement.style.width = '1920px';
  renderer.domElement.style.height = '1080px';
  el.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(CAM.fov, 1920 / 1080, 1, 12000);
  camera.setViewOffset(1920, 1080, CAM.ox, CAM.oy, 1920, 1080);
  labelBox = document.getElementById('map-labels');

  scene.add(new THREE.AmbientLight(0xa8c0dd, 0.55));
  const dir = new THREE.DirectionalLight(0xdceaff, 0.72);
  dir.position.set(-400, 1200, 900);
  scene.add(dir);
  const rim = new THREE.DirectionalLight(0x4d8dff, 0.35);
  rim.position.set(700, 400, -800);
  scene.add(rim);

  mapGroup = new THREE.Group();
  scene.add(mapGroup);
}

function updateCamera() {
  const e = CAM.elev + state.tilt;
  const d = CAM.dist / state.zoom;
  camera.position.set(Math.sin(state.yaw) * d * Math.cos(e), d * Math.sin(e), Math.cos(state.yaw) * d * Math.cos(e));
  camera.lookAt(0, 0, 0);
}

/* ---------- HTML 标签投影 ---------- */
const tmpV = new THREE.Vector3();

/* 引导线画布：标注被挤离自己那根光柱时，用一条折线把两者连起来 */
let leadLayer = null;
function leadsBox() {
  if (!leadLayer) {
    leadLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    leadLayer.setAttribute('class', 'm-leads');
    leadLayer.setAttribute('viewBox', '0 0 1920 1080');
    (labelBox || (labelBox = document.getElementById('map-labels'))).appendChild(leadLayer);
  }
  return leadLayer;
}

/* 相机一直在自转，光柱顶端的投影会互相压字（厦门那条 6,400亿元 尤其容易和上下的撞）。
   这里把每条标注当成 22px 高的盒子，横向有重叠就自上而下顶开，被顶开的补一条引导线。
   最小间距按 30px 留：光让出「不叠字」还嫌挤（用户点的就是莆田/泉州那种挤），
   默认全年视角最紧的一对本来就有 38px，所以这条线一动基准画面还是一个像素不变。
   挪的只是屏幕位置，金额还是 regions.json 那条算式出来的。 */
const LABEL_H = 22, LABEL_GAP = 8;
function refreshLabels() {
  const rectW = 1920, rectH = 1080;
  const es = [];
  state.pillars.forEach(p => {
    tmpV.copy(p.top).applyMatrix4(mapGroup.matrixWorld).project(camera);
    const x = (tmpV.x * 0.5 + 0.5) * rectW, y = (-tmpV.y * 0.5 + 0.5) * rectH;
    const on = tmpV.z < 1;
    p.label.style.opacity = on ? '1' : '0';
    if (!on) {
      p.label.style.transform = `translate(${Math.round(x + 12)}px, ${Math.round(y)}px) translateY(-50%)`;
      p.lead.setAttribute('points', '');
      return;
    }
    es.push({ p, ax: x, ay: y, x: x + 12, y, w: p.labelW || 160 });
  });

  es.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < es.length; i++) {
      for (let j = 0; j < i; j++) {
        const a = es[j], b = es[i];
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) <= 0) continue;
        const need = LABEL_H + LABEL_GAP - (b.y - a.y);
        if (need > 0) b.y += need;
      }
    }
  }
  const spill = (es.length ? es[es.length - 1].y : 0) - (rectH - 44);
  if (spill > 0) es.forEach(e => { e.y -= spill; });

  es.forEach(e => {
    const x = Math.round(e.x), y = Math.round(e.y);
    e.p.label.style.transform = `translate(${x}px, ${y}px) translateY(-50%)`;
    e.p.lead.setAttribute('points', Math.abs(y - e.ay) > 3
      ? `${Math.round(e.ax + 2)},${Math.round(e.ay)} ${x - 10},${y} ${x - 1},${y}` : '');
  });
}

/* 底图省份名 */
const BASE_LABELS = [
  ['浙江省', 120.15, 29.35], ['江西省', 115.35, 27.35], ['广东省', 113.35, 23.15]
];
function buildBaseLabels() {
  BASE_LABELS.forEach(([name, lng, lat]) => {
    const el = document.createElement('div');
    el.className = 'base-label';
    el.textContent = name;
    el.dataset.lng = lng; el.dataset.lat = lat;
    labelBox.appendChild(el);
  });
}
function refreshBaseLabels() {
  labelBox.querySelectorAll('.base-label').forEach(el => {
    tmpV.set(projX(+el.dataset.lng), -8, -projY(+el.dataset.lat)).applyMatrix4(scene.matrixWorld).project(camera);
    el.style.transform = `translate(${Math.round(tmpV.x * 960 + 960)}px, ${Math.round(-tmpV.y * 540 + 540)}px) translate(-50%,-50%) skewX(-8deg)`;
    el.style.opacity = tmpV.z < 1 ? '' : '0';
  });
}

/* ---------- 交互 ---------- */
let drag = null, lastInteract = 0;
function bindInput() {
  const dom = renderer.domElement;
  dom.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, yaw: state.yaw, tilt: state.tilt, moved: 0 };
    lastInteract = performance.now();
    document.getElementById('map3d').classList.add('dragging');
    dom.setPointerCapture(e.pointerId);
  });
  dom.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
    state.yawTarget = drag.yaw + dx * 0.0016;
    state.tiltTarget = Math.max(-0.22, Math.min(0.22, drag.tilt - dy * 0.0012));
    state.yawTarget = Math.max(-0.5, Math.min(0.5, state.yawTarget));
  });
  dom.addEventListener('pointerup', e => {
    document.getElementById('map3d').classList.remove('dragging');
    if (drag && drag.moved < 6) {
      const code = pickAt(e.clientX, e.clientY);
      if (code) pickRegion(code);
    }
    drag = null;
  });
  dom.addEventListener('dblclick', () => { state.yawTarget = 0; state.tiltTarget = 0; state.zoomTarget = 1; });
  dom.addEventListener('wheel', e => {
    e.preventDefault();
    state.zoomTarget = Math.max(0.72, Math.min(1.7, state.zoomTarget * (1 - e.deltaY * 0.0009)));
    lastInteract = performance.now();
  }, { passive: false });

  // 作为 index.html 的一屏嵌入时，地图之外的滚轮交给外壳翻页（捕获阶段：ECharts 会拦截冒泡）
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
  document.getElementById('sdTabs').addEventListener('click', e => {
    const btn = e.target.closest('.sd-tab');
    if (!btn || btn.dataset.tab === state.tab) return;
    document.querySelectorAll('.sd-tab').forEach(b => b.classList.toggle('active', b === btn));
    state.tab = btn.dataset.tab;
    buildPillars();
  });
  document.getElementById('layerBtns').addEventListener('click', e => {
    const btn = e.target.closest('.sd-layer');
    if (!btn || btn.dataset.layer === state.layer) return;
    state.layer = btn.dataset.layer;
    renderLayerBtns();
    buildLayer();
  });
}

/* ---------- 左侧 KPI ---------- */
function renderKpi() {
  const mo = monthOn() ? ' · ' + FJ.months[state.month] : '';
  /* 全年取整显示；回放某月改一位小数，否则「271 + 327」看着等于 598，跟地图上厦门那根 597 的光柱打架 */
  const f = monthOn() ? FJ.fmt1 : FJ.fmt;
  document.getElementById('sdKpi').innerHTML = FJ.kpis(state.month).map(k =>
    `<div class="kpi"><div class="k-label">${k.label}${mo}</div>` +
    `<div class="k-value"><b>${f(k.value)}</b><span>${k.unit}</span></div></div>`
  ).join('');
}

/* ---------- 右侧图表 ---------- */
let shareChart = null;
function initShareChart() {
  const chart = shareChart = echarts.init(document.getElementById('shareChart'));
  chart.setOption({
    animationDuration: 900,
    series: [{
      type: 'pie', radius: ['58%', '76%'], center: ['50%', '50%'],
      startAngle: 90, minAngle: 4,
      itemStyle: { borderColor: '#0a1424', borderWidth: 4, borderRadius: 6 },
      label: { show: false }, labelLine: { show: false },
      // 顺序即 js/fujian.js 里 CAT_GROUPS 的顺时针顺序，图例与扇区共用同一份数据
      data: shareData(FJ.catShare())
    }]
  });
  renderShareLegend();
  return chart;
}

function shareData(share) {
  return share.map(c => ({
    name: c.name, value: c.pct,
    itemStyle: { color: c.color, shadowBlur: 14, shadowColor: c.color }
  }));
}

/* 环形图与图例读同一份占比：回放某月时占比也会浮动（系数见 regions.json 的 exports_season） */
function renderShareLegend() {
  const share = FJ.catShare(state.month);
  shareChart.setOption({ series: [{ data: shareData(share) }] });
  document.getElementById('shareLegend').innerHTML = share.map(c =>
    `<li><span class="sw" style="background:${c.color};color:${c.color}"></span>` +
    `<span class="nm">${c.name}</span>` +
    `<span class="amt">${FJ.fmt2(c.amt)}${FJ.unit}</span>` +
    `<span class="pct">${c.pct}%</span></li>`
  ).join('');
}

function initMonthChart() {
  const chart = echarts.init(document.getElementById('monthChart'));
  const cur = FJ.monthCursor;
  const series = FJ.monthSeries();
  const cityName = FJ.monthName();
  /* 轴上界随金额变：数据换了量级不会出现曲线贴顶或被压成一条直线 */
  const peak = Math.max.apply(null, series.province.concat(series.city));
  const step = Math.pow(10, String(Math.round(peak / 4)).length - 1);
  const interval = Math.ceil(peak / 4 / step) * step;
  const mk = (name, data, line, fill, glow) => ({
    name, type: 'line', data, smooth: 0.42, symbol: 'none', color: line,
    lineStyle: { width: 2.4, color: line, shadowBlur: 16, shadowColor: glow },
    areaStyle: {
      color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: fill[0] }, { offset: 1, color: fill[1] }
      ])
    }
  });
  chart.setOption({
    animationDuration: 1000,
    grid: { left: 44, right: 14, top: 34, bottom: 26 },
    legend: {
      right: 4, top: 2, icon: 'rect', itemWidth: 7, itemHeight: 7, itemGap: 18,
      textStyle: { color: '#c3d6f2', fontSize: 12 },
      data: ['全省', cityName]
    },
    xAxis: {
      type: 'category', boundaryGap: false, data: FJ.months,
      axisLine: { lineStyle: { color: 'rgba(120,165,225,.28)' } },
      axisTick: { show: false },
      axisLabel: { color: '#8fa9cc', fontSize: 12, margin: 10 }
    },
    yAxis: {
      type: 'value', max: interval * 4, interval,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: '#8fa9cc', fontSize: 12 },
      splitLine: { lineStyle: { color: 'rgba(90,130,190,.08)' } }
    },
    series: [
      Object.assign(mk('全省', series.province, '#bcd9ff', ['rgba(96,158,240,.55)', 'rgba(20,44,88,.05)'], 'rgba(140,195,255,.9)'), {
        markLine: {
          symbol: ['circle', 'none'], symbolSize: [8, 0], silent: true, animation: false,
          itemStyle: { color: '#fff', shadowBlur: 16, shadowColor: '#9cc9ff' },
          lineStyle: { color: 'rgba(230,244,255,.7)', width: 1.5, type: 'solid' },
          label: { show: false },
          data: [{ xAxis: FJ.months[cur] }]
        },
        markPoint: {
          symbol: 'circle', symbolSize: 9, silent: true,
          itemStyle: { color: '#fff', shadowBlur: 14, shadowColor: '#9cc9ff' },
          label: { show: true, position: 'right', distance: 6, color: '#eaf4ff', fontSize: 13, formatter: p => p.value + FJ.unit },
          data: [{ coord: [FJ.months[cur], series.province[cur]], value: series.province[cur] }]
        }
      }),
      Object.assign(mk(cityName, series.city, '#ffe3a0', ['rgba(255,206,110,.5)', 'rgba(70,48,10,.04)'], 'rgba(255,214,130,.9)'), {
        markPoint: {
          symbol: 'circle', symbolSize: 8, silent: true,
          itemStyle: { color: '#fff6dd', shadowBlur: 14, shadowColor: '#ffcf6e' },
          label: { show: true, position: 'right', distance: 6, color: '#eaf4ff', fontSize: 13, formatter: p => p.value + FJ.unit },
          data: [{ coord: [FJ.months[cur], series.city[cur]], value: series.city[cur] }]
        }
      })
    ]
  });
  return chart;
}

/* ---------- 月度回放 ---------- */
/* 默认 state.month = null（全年）：光柱与标签就是各市年额，画面与没加这条时间轴之前逐像素一致。
   点某月才换成「年额 / 12 × 全省季节系数」——与月度曲线同一条算式（js/fujian.js 的 buildMonths），
   不另造一套系数、不掺随机，所以回放出来的数与右侧曲线、下方品类表谁都不打架。 */
let monthChart = null, playTimer = 0, SRC_BASE = '';

const monthOn = () => state.month !== null;

function renderScrub() {
  const box = document.getElementById('monthScrub');
  /* 骨架只建一次：回放时每 900ms 就刷一遍，整块 innerHTML 重建会把正好按下去的那一下丢掉，
     hover 高亮也会跟着闪没——所以后面只改类名和 ▶/⏸ 那一格的字。 */
  if (!box.childElementCount) {
    box.innerHTML = `<button class="ms-play" data-act="ms-play" type="button"></button>`
      + `<button class="ms-mo" data-mo="-1" type="button">全年</button>`
      + FJ.months.map((m, i) => `<button class="ms-mo" data-mo="${i}" type="button">${m}</button>`).join('');
  }
  const play = box.querySelector('.ms-play');
  play.className = 'ms-play' + (playTimer ? ' run' : '');
  play.textContent = playTimer ? '⏸ 暂停' : '▶ 回放';
  box.querySelectorAll('[data-mo]').forEach(b => {
    const mo = +b.dataset.mo;
    b.classList.toggle('on', monthOn() ? mo === state.month : mo < 0);
  });
}

/* 口径写在地图左下角那行示例数据标注里：切到某月就说清这是派生值、系数多少。
   这行在月模式下加宽到 700px（.wide），两行装完，才不会长到第三行压住下面的指北针。 */
function renderSrc() {
  const el = document.getElementById('mapSrc');
  if (!monthOn()) { el.className = 'map-src'; el.textContent = SRC_BASE; return; }
  const k = FJ.seasonK(state.month), s = FJ.monthSeries();
  el.className = 'map-src wide';
  el.innerHTML = SRC_BASE + `<br><b class="cur">当前 ${FJ.months[state.month]}</b> · 全省 ${s.province[state.month].toFixed(1)}${FJ.unit}`
    + ` · 系数 ${k}（${k >= 1 ? '+' : ''}${Math.round((k - 1) * 100)}%）`
    + ` · 整屏金额=年额÷12×系数（厦门用本市系数 ${FJ.seasonKFor(FJ.topCity, state.month)}）`
    + ` · 占比再乘品类系数(exports_season)`;
}

function paintCursor() {
  if (!monthChart) return;
  const i = monthOn() ? state.month : FJ.monthCursor, s = FJ.monthSeries();
  monthChart.setOption({
    series: [
      { markLine: { data: [{ xAxis: FJ.months[i] }] },
        markPoint: { data: [{ coord: [FJ.months[i], s.province[i]], value: s.province[i] }] } },
      { markPoint: { data: [{ coord: [FJ.months[i], s.city[i]], value: s.city[i] }] } }
    ]
  });
}

function setMonth(i) {
  state.month = i;
  buildPillars();
  paintCursor();
  renderScrub();
  renderSrc();
  /* 整屏的钱一起换月：左边三条 KPI、右边图例金额与品类表，全走同一条算式 */
  renderKpi();
  renderShareLegend();
  renderTable();
  markMonthTitles();
}

function stopPlay() { if (playTimer) { clearInterval(playTimer); playTimer = 0; renderScrub(); } }
function startPlay() {
  playTimer = setInterval(() => {
    if (!paused) setMonth(monthOn() ? (state.month + 1) % FJ.months.length : 0);
  }, 900);
  setMonth(monthOn() ? state.month : 0);
}

function bindScrub() {
  document.getElementById('monthScrub').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'ms-play') { playTimer ? stopPlay() : startPlay(); return; }
    stopPlay();
    const mo = +b.dataset.mo;
    setMonth(mo < 0 ? null : mo);
  });
  /* 曲线整条都能点：落在网格上方那块（图例）不算切月，那是 ECharts 自己的开关 */
  monthChart.getZr().on('click', e => {
    if (e.offsetY < 40) return;
    const px = monthChart.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]);
    if (!px) return;
    stopPlay();
    setMonth(Math.max(0, Math.min(FJ.months.length - 1, Math.round(px[0]))));
  });
  addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const n = FJ.months.length, fwd = e.key === 'ArrowRight';
    stopPlay();
    setMonth(monthOn() ? (state.month + (fwd ? 1 : n - 1)) % n : (fwd ? 0 : n - 1));
  });
}

function renderTable() {
  document.getElementById('sdTableBody').innerHTML = FJ.catTable(state.month).map((r, i) =>
    `<tr><td class="i">${i + 1}</td><td>${r.name}</td><td class="num">${FJ.fmt2(r.pct)}</td><td class="num">${FJ.fmt2(r.amt)}</td></tr>`
  ).join('');
}

/* 两块品类面板的标题挂一个月份角标：表里的钱换成了当月的，标题不写就看着像全年数。
   月度面板本来就是按月的，跳过不打标。 */
function markMonthTitles() {
  const mo = monthOn() ? FJ.months[state.month] : '';
  document.querySelectorAll('.sd-panel .section-title').forEach((el, i) => {
    if (i === 1) return;
    let tag = el.querySelector('.st-mo');
    if (mo) {
      if (!tag) { tag = document.createElement('span'); tag.className = 'st-mo'; el.appendChild(tag); }
      tag.textContent = mo;
    } else if (tag) tag.remove();
  });
}

function startClock() {
  const el = document.getElementById('clock');
  const p = n => String(n).padStart(2, '0');
  const step = () => {
    const d = new Date();
    el.textContent = `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  step(); setInterval(step, 1000);
}

/* ---------- 渲染循环 ---------- */
/* 作为 index.html 的一屏嵌入时，非当前屏暂停渲染 */
let paused = false;
addEventListener('message', e => { if (e.data && 'active' in e.data) paused = !e.data.active; });

function animate(t) {
  if (paused) { requestAnimationFrame(animate); return; }
  state.yaw += (state.yawTarget - state.yaw) * 0.1;
  state.tilt += (state.tiltTarget - state.tilt) * 0.1;
  state.zoom += (state.zoomTarget - state.zoom) * 0.1;
  updateCamera();

  if (glowMesh) glowMesh.material.opacity = 0.5 + 0.14 * Math.sin(t * 0.0016);
  state.pillars.forEach((p, i) => {
    const wp = p.group.position;
    p.beam.rotation.y = Math.atan2(camera.position.x - wp.x, camera.position.z - wp.z);
    p.rings.forEach(rg => {
      const ph = ((t * 0.0008 + rg.userData.phase) % 1);
      const k = 1 + ph * 1.7;
      rg.scale.set(k, k, 1);
      rg.material.opacity = 0.5 * (1 - ph);
    });
    p.cap.scale.setScalar(1 + 0.18 * Math.sin(t * 0.004 + i));
  });

  renderer.render(scene, camera);
  refreshLabels();
  refreshLayerLabels();
  refreshBaseLabels();
  requestAnimationFrame(animate);
}

/* 读不到数据时必须在屏幕上说清楚，而不是留一块空白让人以为功能坏了 */
function fatal(msg, detail) {
  const el = document.createElement('div');
  el.className = 'map-fatal';
  el.innerHTML = `<b>${msg}</b><span>${detail || ''}</span>`;
  document.getElementById('stage').appendChild(el);
}

/* ---------- 启动 ---------- */
(async function boot() {
  startClock();
  let geo, outline, china, region, supply, chainDoc;
  try {
    [geo, outline, china, region, supply, chainDoc] = await Promise.all([
      getJSON('data/fujian.json'),
      getJSON('data/fujian-outline.json'),
      getJSON('data/china.json'),
      API.request('trade.region', { adcode: FJ.province.adcode }),
      getJSON('data/supply.json?v=1'),
      API.request('chain.byRegion', {})
    ]);
  } catch (e) {
    console.error('第二屏数据加载失败:', e);
    fatal('第二屏数据加载失败', String(e && e.message || e));
    return;
  }
  try {
    FJ.applyRegion(region.data && region.data.raw);
    FJ.applyChains(chainDoc.data || []);
    FJ.applySupply(supply);
  } catch (e) {
    console.error('福建金额数据校验失败:', e);
    fatal('福建金额数据不一致', String(e && e.message || e));
    return;
  }

  renderKpi();
  const share = initShareChart();
  const month = monthChart = initMonthChart();
  renderTable();
  addEventListener('resize', () => { share.resize(); month.resize(); });

  state.geo = geo; state.outline = outline; state.china = china;
  const b = computeBounds();
  state.bounds = b;
  initScene();
  beamTex = beamTexture();
  buildBase();
  buildCities(b);
  buildBaseLabels();
  applySelection();
  buildPillars();
  bindInput();
  bindUI();
  /* 全年那行标注原样存下来：切回「全年」时一个字都不许多，画面要回到基线 */
  SRC_BASE = document.getElementById('mapSrc').textContent;
  renderScrub();
  bindScrub();
  renderLayerBtns();
  buildLayer();
  updateCamera();
  requestAnimationFrame(animate);
  window.__FJ_READY = true;
})();
