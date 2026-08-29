import pw from 'file:///C:/Users/bwf/.workbuddy/binaries/node/workspace/node_modules/playwright/index.js';
const { chromium } = pw;

const BASE = 'http://127.0.0.1:5188';
const IMG_SIZE = 1936;

const errors = [];
const pageErrors = [];

async function checkScene(browser, route, sceneKey) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${route}] console.error: ${m.text()}`); });
  page.on('pageerror', (e) => pageErrors.push(`[${route}] pageerror: ${e.message}`));
  page.on('requestfailed', (req) => errors.push(`[${route}] requestfailed: ${req.url()} :: ${req.failure() ? req.failure().errorText : '?'}`));
  page.on('response', (res) => { if (res.status() >= 400) errors.push(`[${route}] http ${res.status()}: ${res.url()}`); });

  let navStatus = 'n/a';
  try {
    const resp = await page.goto(`${BASE}/?scene=${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    navStatus = resp ? resp.status() : 'no-resp';
  } catch (e) {
    navStatus = 'GOTO-THREW: ' + e.message;
  }
  console.log(`  [diag ${route}] navStatus=${navStatus}`);

  let sceneActive = false;
  try {
    await page.waitForFunction((s) => window.__game && window.__game.scene && window.__game.scene.isActive(s), sceneKey, { timeout: 20000 });
    sceneActive = true;
  } catch (e) {
    pageErrors.push(`[${route}] scene not active within 20s: ${e.message}`);
  }

  const diag = await page.evaluate((s) => {
    const g = window.__game;
    const out = { hasGame: !!g };
    if (g) {
      out.sceneKeys = g.scene.scenes.map((sc) => ({ key: sc.sceneKey, active: sc.scene.isActive(), visible: sc.scene.isVisible() }));
      out.activeNow = g.scene.getScenes(true).map((sc) => sc.sceneKey);
      out.hasCanvas = !!g.canvas;
      const t = g.scene.getScene(s);
      out.targetExists = !!t;
      if (t) out.targetMapFailed = !!t.mapFailed;
    }
    out.loc = { href: location.href, search: location.search };
    return out;
  }, sceneKey);
  console.log(`  [diag ${route}] ${JSON.stringify(diag)}`);

  // 等待场景异步 create() 真正把数据加载完（isActive 在 await fetch 前就为 true）
  try {
    await page.waitForFunction((s) => {
      const sc = window.__game && window.__game.scene.getScene(s);
      if (!sc) return false;
      if (s === 'MapScene') return sc.points && Object.keys(sc.points).length > 0;
      if (s === 'MapCalibrateScene') return Array.isArray(sc.locations) && sc.locations.length > 0;
      return false;
    }, sceneKey, { timeout: 10000 });
  } catch (e) {
    pageErrors.push(`[${route}] data not loaded within 10s: ${e.message}`);
  }

  let info = null;
  if (sceneActive) {
    info = await page.evaluate((s) => {
      const g = window.__game;
      const sc = g.scene.getScene(s);
      const base = { hasCanvas: !!g.canvas, canvasW: g.canvas ? g.canvas.width : 0, canvasH: g.canvas ? g.canvas.height : 0, mapFailed: !!sc.mapFailed };
      if (s === 'MapScene') return { ...base, points: sc.points ? Object.keys(sc.points).length : 0 };
      if (s === 'MapCalibrateScene') return { ...base, cities: sc.locations ? sc.locations.length : 0 };
      return base;
    }, sceneKey);
  }

  const json = await page.evaluate(async () => {
    const out = {};
    try {
      const r1 = await fetch('data/map_points.json');
      out.mapPointsOk = r1.ok;
      if (r1.ok) out.mapPoints = await r1.json();
      const r2 = await fetch('data/locations.json');
      out.locationsOk = r2.ok;
      if (r2.ok) out.locations = await r2.json();
    } catch (e) { out.fetchError = e.message; }
    return out;
  });

  await page.close();
  return { scene: route, sceneActive, info, json };
}

function validateData(mp) {
  const issues = [];
  if (!mp) { issues.push('map_points.json 缺失'); return issues; }
  const locs = mp.locations || {};
  const pts = mp.points || {};
  const locIds = Object.keys(locs);
  const ptIds = Object.keys(pts);
  if (locIds.length !== 25) issues.push(`locations 数量=${locIds.length}，期望25`);
  if (ptIds.length !== 25) issues.push(`points 数量=${ptIds.length}，期望25`);
  // 坐标范围 + NaN 检查
  for (const id of ptIds) {
    const p = pts[id];
    if (!Array.isArray(p) || p.length !== 2) { issues.push(`${id} 坐标格式错误: ${JSON.stringify(p)}`); continue; }
    if (!isFinite(p[0]) || !isFinite(p[1])) issues.push(`${id} 含非有限值: ${JSON.stringify(p)}`);
    else if (p[0] < 0 || p[0] > IMG_SIZE || p[1] < 0 || p[1] > IMG_SIZE) issues.push(`${id} 坐标越界: ${JSON.stringify(p)}`);
  }
  // locations 与 points 的城市集合应一致
  const onlyLoc = locIds.filter((x) => !ptIds.includes(x));
  const onlyPt = ptIds.filter((x) => !locIds.includes(x));
  if (onlyLoc.length) issues.push(`仅在 locations: ${onlyLoc.join(',')}`);
  if (onlyPt.length) issues.push(`仅在 points: ${onlyPt.join(',')}`);
  return issues;
}

// 验证地图场景「有建筑城市显示建筑像素 / 无建筑城市不变 / 切换按钮生效」
async function checkMapModes(browser) {
  const page = await browser.newPage();
  let err = null;
  page.on('pageerror', (e) => { err = e.message; });
  let navStatus = 'n/a';
  try {
    const resp = await page.goto(`${BASE}/?scene=map`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    navStatus = resp ? resp.status() : 'no-resp';
  } catch (e) { navStatus = 'GOTO-THREW: ' + e.message; }
  console.log(`  [diag mapModes] navStatus=${navStatus}`);
  try {
    await page.waitForFunction(() => {
      const sc = window.__game && window.__game.scene.getScene('MapScene');
      return sc && sc.points && Object.keys(sc.points).length > 0 && sc.slots
        && sc.markerObjs && sc.markerObjs.length > 0
        && document.getElementById('map-mode-toggle');
    }, { timeout: 20000 });
  } catch (e) {
    await page.close();
    return { ok: false, error: 'MapScene 数据/标记未就绪: ' + e.message };
  }

  const initial = await page.evaluate(() => {
    const sc = window.__game.scene.getScene('MapScene');
    const markers = sc.markerObjs;
    // 默认尺寸下任意两个方块不应重叠（AABB 重叠判定）
    let overlapPairs = 0;
    for (let i = 0; i < markers.length; i++) {
      for (let j = i + 1; j < markers.length; j++) {
        const a = markers[i], b = markers[j];
        const ha = a.__size / 2, hb = b.__size / 2;
        if (Math.abs(a.x - b.x) < ha + hb && Math.abs(a.y - b.y) < ha + hb) overlapPairs++;
      }
    }
    return {
      slotCities: Object.keys(sc.slots || {}).length,
      markerCount: markers.length,
      interactive: markers.filter((m) => m.input && m.input.enabled).length,
      withFlag: markers.filter((m) => m.__isMarker).length,
      withHandle: markers.filter((m) => m.__handle).length,
      defaultSize: markers[0].__size,
      overlapPairs,
      linkCount: (sc.linkObjs || []).length, // 连接槽位渲染数（独立于建筑标记）
      showBuildings: sc.showBuildings,
      hasToggle: !!document.getElementById('map-mode-toggle'),
      hasSave: !!document.getElementById('map-save-wrap'),
    };
  });

  // 拖动标记 → 底层坐标应改变（验证可单独移动）
  // 先把相机对准 markerObjs[0] 并放大，使点击点落在标记簇中心，用真实鼠标拖动
  const setup = await page.evaluate(() => {
    const sc = window.__game.scene.getScene('MapScene');
    const m0 = sc.markerObjs[0];
    const cam = sc.cameras.main;
    cam.setZoom(2);
    cam.centerOn(m0.x, m0.y);
    const rect = sc.game.canvas.getBoundingClientRect();
    return { cssX: rect.left + rect.width / 2, cssY: rect.top + rect.height / 2 };
  });
  await page.mouse.move(setup.cssX, setup.cssY);
  await page.mouse.down();
  // 按下后，读取实际被抓取的那个标记（可能是一簇重叠标记里置顶的那个）
  const grabbed = await page.evaluate(() => {
    const sc = window.__game.scene.getScene('MapScene');
    const d = sc.__drag;
    if (!d) return null;
    return { city: d.container.__city, slotIdx: d.container.__slotIdx,
             beforeX: d.container.x, beforeY: d.container.y };
  });
  await page.mouse.move(setup.cssX + 60, setup.cssY + 40, { steps: 5 });
  await page.mouse.up();
  const drag = await page.evaluate((g) => {
    const sc = window.__game.scene.getScene('MapScene');
    const m = sc.markerObjs.find((x) => x.__city === g.city && x.__slotIdx === g.slotIdx);
    return {
      before: { x: g.beforeX, y: g.beforeY, slotX: m.__slot.x, slotY: m.__slot.y },
      after: { x: m.x, y: m.y, slotX: m.__slot.x, slotY: m.__slot.y },
    };
  }, grabbed);

  // 单独缩放：选一个未被拖动的标记，居中放大，拖其右下角手柄向外 → 尺寸应增大且写回槽位
  const rsetup = await page.evaluate(() => {
    const sc = window.__game.scene.getScene('MapScene');
    // 选离其他标记最远的那个，避免手柄被别家盖住
    const ms = sc.markerObjs;
    let best = ms[0], bestMin = -1;
    for (const m of ms) {
      let mn = 1e9;
      for (const o of ms) if (o !== m) mn = Math.min(mn, Math.hypot(m.x - o.x, m.y - o.y));
      if (mn > bestMin) { bestMin = mn; best = m; }
    }
    const cam = sc.cameras.main;
    cam.setZoom(3);
    cam.centerOn(best.x, best.y);
    const rect = sc.game.canvas.getBoundingClientRect();
    const sx = rect.width / cam.width, sy = rect.height / cam.height;
    const half = best.__size / 2;
    const off = half * cam.zoom; // 手柄距中心（画布像素）
    return {
      cssX: rect.left + rect.width / 2 + off * sx,
      cssY: rect.top + rect.height / 2 + off * sy,
      city: best.__city, slotIdx: best.__slotIdx,
      beforeSize: best.__size,
      beforeSlotSize: best.__slot.size,
    };
  });
  await page.mouse.move(rsetup.cssX, rsetup.cssY);
  await page.mouse.down();
  await page.mouse.move(rsetup.cssX + 90, rsetup.cssY + 90, { steps: 6 });
  await page.mouse.up();
  const resize = await page.evaluate((g) => {
    const sc = window.__game.scene.getScene('MapScene');
    const m = sc.markerObjs.find((x) => x.__city === g.city && x.__slotIdx === g.slotIdx);
    return { before: g.beforeSize, after: m.__size, beforeSlot: g.beforeSlotSize, afterSlot: m.__slot.size };
  }, rsetup);

  // 点击切换按钮 → 应翻转为 false（城市点模式，标记清空）
  await page.click('#map-mode-toggle');
  const afterClick1 = await page.evaluate(() => {
    const sc = window.__game.scene.getScene('MapScene');
    return {
      showBuildings: sc.showBuildings,
      markerCount: sc.markerObjs.length,
      gfxCmds: sc.cityGfx ? sc.cityGfx.commandBuffer.length : -1,
    };
  });
  // 再点回 true（重建标记）
  await page.click('#map-mode-toggle');
  const afterClick2 = await page.evaluate(() => {
    const sc = window.__game.scene.getScene('MapScene');
    return { showBuildings: sc.showBuildings, markerCount: sc.markerObjs.length };
  });

  await page.close();
  const gotGrabbed = !!drag && !!drag.before;
  const moved = gotGrabbed && (Math.abs(drag.after.x - drag.before.x) > 1 || Math.abs(drag.after.y - drag.before.y) > 1);
  const slotSynced = grabbed && drag.after.slotX === drag.after.x && drag.after.slotY === drag.after.y;
  const ok = !err
    && initial.slotCities === 19        // 25 城中有 6 城无建筑 → 19 城有建筑
    && initial.markerCount === 43       // 全部建筑槽位都生成标记
    && initial.interactive === 43       // 每个标记都可交互（可拖动）
    && initial.withFlag === 43          // 每个标记带 __isMarker（相机不会误平移）
    && initial.withHandle === 43        // 每个标记带缩放手柄
    && initial.overlapPairs === 0       // 默认尺寸下互不重叠
    && initial.defaultSize < 72         // 默认边长 < 最小槽位间距，保证不重叠
    && initial.linkCount === 36         // 36 条连接槽位全部渲染
    && initial.showBuildings === true
    && initial.hasToggle === true
    && initial.hasSave === true
    && gotGrabbed                   // 鼠标按下确实抓到了一个标记
    && moved                          // 拖动确实改变了坐标
    && slotSynced                     // 拖动实时写回底层槽位坐标
    && afterClick1.showBuildings === false
    && afterClick1.markerCount === 0  // 城市点模式：标记清空
    && afterClick1.gfxCmds > 0        // 城市点模式：画了圆点
    && afterClick2.showBuildings === true
    && afterClick2.markerCount === 43   // 切回：标记重建
    && resize.after > resize.before     // 拖手柄确实放大了该方块
    && Math.round(resize.after) === resize.afterSlot; // 缩放尺寸写回底层槽位(取整)
  return {
    ok,
    error: err || undefined,
    detail: { initial, drag, resize, afterClick1, afterClick2 },
  };
}

// 验证「校准页导出同时带 points」：灌满所有落点 → 调用 _export() → 拦截 Blob → 解析断言
async function checkExport(browser, mp) {
  const page = await browser.newPage();
  let err = null;
  page.on('pageerror', (e) => { err = e.message; });
  await page.goto(`${BASE}/?scene=calibrate`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForFunction(() => window.__game && window.__game.scene.getScene('MapCalibrateScene') && Array.isArray(window.__game.scene.getScene('MapCalibrateScene').locations) && window.__game.scene.getScene('MapCalibrateScene').locations.length > 0, { timeout: 20000 });
  } catch (e) { await page.close(); return { ok: false, error: 'calibrate 未就绪: ' + e.message }; }

  const out = await page.evaluate(async (mpData) => {
    const sc = window.__game.scene.getScene('MapCalibrateScene');
    // 用 map_points.json 的 locations 反推场景内部 points 结构（{point}|{slots:[[x,y]...]}）
    sc.points = {};
    for (const [cid, loc] of Object.entries(mpData.locations)) {
      if (loc.point) sc.points[cid] = { point: loc.point };
      else if (loc.slots) sc.points[cid] = { slots: loc.slots.map((s) => [s.x, s.y]) };
    }
    // 拦截下载 Blob
    let blobText = null;
    const origCreate = URL.createObjectURL;
    const origClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (b) => { window.__capBlob = b; return 'blob:fake'; };
    HTMLAnchorElement.prototype.click = function () {};
    try { sc._export(); } finally {
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
    }
    if (window.__capBlob) blobText = await window.__capBlob.text();
    return blobText;
  }, mp);

  await page.close();
  if (err) return { ok: false, error: 'pageerror: ' + err };
  if (!out) return { ok: false, error: '_export 未产生下载 Blob' };
  try {
    const parsed = JSON.parse(out);
    const hasPoints = parsed.points && Object.keys(parsed.points).length === 25;
    const hasLocations = parsed.locations && Object.keys(parsed.locations).length === 25;
    const sample = parsed.points ? parsed.points.MANCHESTER : null;
    return { ok: hasPoints && hasLocations, hasPoints, hasLocations, sampleType: Array.isArray(sample) ? 'array' : typeof sample };
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败: ' + e.message };
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: 'direct://' },
    args: ['--no-proxy-server', '--proxy-bypass-list=*'],
  });
  const results = {};
  for (const [route, key] of [['map', 'MapScene'], ['calibrate', 'MapCalibrateScene']]) {
    results[route] = await checkScene(browser, route, key);
  }
  // 校准页导出带 points 验证（用已校验的 map_points.json 作为输入）
  const exportRes = await checkExport(browser, results.map.json.mapPoints);
  // 地图场景显示模式（建筑像素 / 城市点 切换）验证
  const modeRes = await checkMapModes(browser);
  await browser.close();

  const mp = results.map.json.mapPoints;
  const dataIssues = validateData(mp);

  console.log('===== HEADLESS VALIDATION =====');
  for (const scene of ['map', 'calibrate']) {
    const r = results[scene];
    console.log(`\n[${scene}] sceneActive=${r.sceneActive}`);
    console.log(`  info=${JSON.stringify(r.info)}`);
    console.log(`  map_points.json ok=${r.json.mapPointsOk} | locations.json ok=${r.json.locationsOk}`);
  }
  console.log('\n--- data validation (map_points.json) ---');
  if (dataIssues.length === 0) console.log('  OK: 25城 / 坐标全部合法且在版图内 / locations与points城市集合一致');
  else dataIssues.forEach((i) => console.log('  ✗ ' + i));

  console.log('\n--- runtime errors ---');
  if (errors.length === 0 && pageErrors.length === 0) console.log('  OK: 无 console.error / 无 pageerror');
  else { errors.forEach((e) => console.log('  ✗ ' + e)); pageErrors.forEach((e) => console.log('  ✗ ' + e)); }

  console.log('\n--- 校准页导出带 points 验证 ---');
  if (exportRes.ok) console.log(`  OK: 导出含 points(25城) + locations(25城) | MANCHESTER points 类型=${exportRes.sampleType}`);
  else console.log('  ✗ 导出验证失败: ' + (exportRes.error || JSON.stringify(exportRes)));

  console.log('\n--- 地图场景标记（拖动 / 缩放 / 无重叠）验证 ---');
  if (modeRes.ok) {
    const d = modeRes.detail;
    console.log(`  OK: 有建筑城市=${d.initial.slotCities}（期望19） | 标记数=${d.initial.markerCount} | 默认边长=${d.initial.defaultSize}`);
    console.log(`      可交互=${d.initial.interactive} | 带手柄=${d.initial.withHandle} | 默认无重叠(overlapPairs=${d.initial.overlapPairs}) | 连接槽位=${d.initial.linkCount}（期望36）`);
    console.log(`      拖动坐标改变=${d.drag.after.x !== d.drag.before.x || d.drag.after.y !== d.drag.before.y} | 写回槽位✓`);
    console.log(`      单独缩放: ${d.resize.before} → ${d.resize.after}（写回槽位size=${d.resize.afterSlot}）✓`);
    console.log(`      切换: 点1→showBuildings=${d.afterClick1.showBuildings}(标记清空) | 点2→${d.afterClick2.showBuildings}(标记重建) ✓`);
  } else {
    console.log('  ✗ 标记验证失败: ' + (modeRes.error || JSON.stringify(modeRes.detail)));
  }

  const allGood = dataIssues.length === 0 && errors.length === 0 && pageErrors.length === 0
    && results.map.sceneActive && results.calibrate.sceneActive
    && results.map.info && results.map.info.points === 25
    && results.map.info.mapFailed === false
    && results.calibrate.info.cities === 25
    && exportRes.ok && modeRes.ok;
  console.log('\n===== RESULT: ' + (allGood ? 'PASS ✅' : 'FAIL ❌') + ' =====');
  process.exit(allGood ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
