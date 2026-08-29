import pw from 'file:///C:/Users/bwf/.workbuddy/binaries/node/workspace/node_modules/playwright/index.js';
import { readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
const { chromium } = pw;

const BASE = 'http://127.0.0.1:5188';
const MAP_POINTS = 'D:/zhuoyouyizhi/lancashire/web/public/data/map_points.json';
const BAK = MAP_POINTS + '.bak_test';

const pageErrors = [];
const consoleErrors = [];

async function listMarkers(page) {
  return await page.evaluate(() => {
    const sc = window.__game.scene.getScene('MapScene');
    return sc.markerObjs.map((m) => ({ city: m.__city, slotIdx: m.__slotIdx }));
  });
}

// 把指定 marker 居中并放大，返回画布 CSS 中心坐标
async function centerOn(page, city, slotIdx, zoom) {
  return await page.evaluate(({ city, slotIdx, zoom }) => {
    const sc = window.__game.scene.getScene('MapScene');
    const c = sc.markerObjs.find((m) => m.__city === city && m.__slotIdx === slotIdx);
    c.setDepth(99999); // 保证抓到的是它（从潜在重叠中抽出）
    const cam = sc.cameras.main;
    cam.setZoom(zoom);
    cam.centerOn(c.x, c.y);
    const rect = sc.game.canvas.getBoundingClientRect();
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
  }, { city, slotIdx, zoom });
}

async function getMarker(page, city, slotIdx) {
  return await page.evaluate(({ city, slotIdx }) => {
    const sc = window.__game.scene.getScene('MapScene');
    const m = sc.markerObjs.find((x) => x.__city === city && x.__slotIdx === slotIdx);
    return { x: m.x, y: m.y, size: m.__size, slotX: m.__slot.x, slotY: m.__slot.y };
  }, { city, slotIdx });
}

// 拖动指定 marker（CSS 像素位移 dx,dy）。返回拖动前后坐标。
async function dragMarker(page, city, slotIdx, dx, dy, zoom = 2.5) {
  await centerOn(page, city, slotIdx, zoom);
  const before = await getMarker(page, city, slotIdx);
  const c = await page.evaluate(({ city, slotIdx }) => {
    const sc = window.__game.scene.getScene('MapScene');
    const m = sc.markerObjs.find((x) => x.__city === city && x.__slotIdx === slotIdx);
    const rect = sc.game.canvas.getBoundingClientRect();
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
  }, { city, slotIdx });
  await page.mouse.move(c.cx, c.cy);
  await page.mouse.down();
  await page.mouse.move(c.cx + dx, c.cy + dy, { steps: 6 });
  await page.mouse.up();
  const after = await getMarker(page, city, slotIdx);
  return { before, after };
}

// 缩放指定 marker（手柄向外 extra 像素）。返回前后尺寸。
async function resizeMarker(page, city, slotIdx, extra, zoom = 3) {
  await centerOn(page, city, slotIdx, zoom);
  const setup = await page.evaluate(({ city, slotIdx }) => {
    const sc = window.__game.scene.getScene('MapScene');
    const m = sc.markerObjs.find((x) => x.__city === city && x.__slotIdx === slotIdx);
    const cam = sc.cameras.main;
    const rect = sc.game.canvas.getBoundingClientRect();
    const sx = rect.width / cam.width, sy = rect.height / cam.height;
    const half = m.__size / 2;
    const off = half * cam.zoom;
    return {
      hx: rect.left + rect.width / 2 + off * sx,
      hy: rect.top + rect.height / 2 + off * sy,
      beforeSize: m.__size, beforeSlot: m.__slot.size,
    };
  }, { city, slotIdx });
  await page.mouse.move(setup.hx, setup.hy);
  await page.mouse.down();
  await page.mouse.move(setup.hx + extra, setup.hy + extra, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(({ city, slotIdx }) => {
    const sc = window.__game.scene.getScene('MapScene');
    const m = sc.markerObjs.find((x) => x.__city === city && x.__slotIdx === slotIdx);
    return { afterSize: m.__size, afterSlot: m.__slot.size };
  }, { city, slotIdx });
  return { before: setup.beforeSize, beforeSlot: setup.beforeSlot, after: after.afterSize, afterSlot: after.afterSlot };
}

function approx(a, b, tol = 1.5) { return Math.abs(a - b) <= tol; }

async function waitReady(page) {
  await page.waitForFunction(() => {
    const sc = window.__game && window.__game.scene.getScene('MapScene');
    return sc && sc.points && Object.keys(sc.points).length > 0 && sc.slots
      && sc.markerObjs && sc.markerObjs.length > 0
      && document.getElementById('map-undo-btn')
      && document.getElementById('map-reset-btn');
  }, { timeout: 20000 });
}

(async () => {
  await copyFile(MAP_POINTS, BAK).catch(() => {});

  const browser = await chromium.launch({
    headless: true,
    proxy: { server: 'direct://' },
    args: ['--no-proxy-server', '--proxy-bypass-list=*'],
  });

  const results = {};
  try {
    // ---------- A. 单独拖动（其他标记不受影响）----------
    {
      const page = await browser.newPage();
      page.on('pageerror', (e) => pageErrors.push('[A] ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[A] ' + m.text()); });
      await page.goto(`${BASE}/?scene=map`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitReady(page);
      const mk = await listMarkers(page);
      const target = mk[0], other = mk[mk.length - 1];
      const otherBefore = await getMarker(page, other.city, other.slotIdx);
      const drag = await dragMarker(page, target.city, target.slotIdx, 120, 80);
      const otherAfter = await getMarker(page, other.city, other.slotIdx);
      const moved = Math.abs(drag.after.x - drag.before.x) > 1 || Math.abs(drag.after.y - drag.before.y) > 1;
      const otherUnchanged = approx(otherBefore.x, otherAfter.x, 0.01) && approx(otherBefore.y, otherAfter.y, 0.01);
      const slotSynced = approx(drag.after.x, drag.after.slotX, 0.01) && approx(drag.after.y, drag.after.slotY, 0.01);
      results.A = { ok: moved && otherUnchanged && slotSynced, moved, otherUnchanged, slotSynced,
        detail: { target, drag } };
      await page.close();
    }

    // ---------- B. 单独缩放（其他标记不受影响）----------
    {
      const page = await browser.newPage();
      page.on('pageerror', (e) => pageErrors.push('[B] ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[B] ' + m.text()); });
      await page.goto(`${BASE}/?scene=map`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitReady(page);
      const mk = await listMarkers(page);
      const target = mk[1], other = mk[2];
      const otherBefore = await getMarker(page, other.city, other.slotIdx);
      const rz = await resizeMarker(page, target.city, target.slotIdx, 90);
      const otherAfter = await getMarker(page, other.city, other.slotIdx);
      const grew = rz.after > rz.before;
      const slotSynced = Math.round(rz.after) === rz.afterSlot;
      const otherUnchanged = approx(otherBefore.size, otherAfter.size, 0.01);
      results.B = { ok: grew && slotSynced && otherUnchanged, grew, slotSynced, otherUnchanged, detail: { target, rz } };
      await page.close();
    }

    // ---------- C. 保存位置 + 重启 → 保持移动后位置/修改后尺寸 ----------
    {
      const page = await browser.newPage();
      page.on('pageerror', (e) => pageErrors.push('[C] ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[C] ' + m.text()); });
      // 用路由直接从磁盘提供 map_points.json，绕过浏览器/服务器 HTTP 缓存，确保 reload 读到刚保存的文件
      await page.route('**/map_points.json', async (route) => {
        try {
          const body = await readFile(MAP_POINTS, 'utf8');
          route.fulfill({ status: 200, contentType: 'application/json', body });
        } catch { route.continue(); }
      });
      await page.goto(`${BASE}/?scene=map`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitReady(page);
      const mk = await listMarkers(page);
      const target = mk[0], other = mk[mk.length - 1];
      const pre = await getMarker(page, target.city, target.slotIdx);
      await dragMarker(page, target.city, target.slotIdx, 140, 90);
      await resizeMarker(page, target.city, target.slotIdx, 80);
      const postEdit = await getMarker(page, target.city, target.slotIdx);
      const changed = Math.abs(postEdit.x - pre.x) > 1 || Math.abs(postEdit.y - pre.y) > 1 || Math.abs(postEdit.size - pre.size) > 1;

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }),
        page.click('#map-save-wrap button'),
      ]);
      const dlPath = await download.path();
      const buf = await readFile(dlPath);
      await writeFile(MAP_POINTS, buf);

      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitReady(page);
      const reloaded = await getMarker(page, target.city, target.slotIdx);
      const otherReloaded = await getMarker(page, other.city, other.slotIdx);
      const persisted = approx(reloaded.x, postEdit.x) && approx(reloaded.y, postEdit.y) && approx(reloaded.size, postEdit.size);
      const notEqualToPre = Math.abs(reloaded.x - pre.x) > 1 || Math.abs(reloaded.y - pre.y) > 1 || Math.abs(reloaded.size - pre.size) > 1;
      results.C = { ok: changed && persisted && notEqualToPre, changed, persisted, notEqualToPre,
        detail: { target, pre, postEdit, reloaded, otherReloaded } };
      await page.close();
    }

    // ---------- D. 移动后撤回 → 回到移动前 ----------
    {
      const page = await browser.newPage();
      page.on('pageerror', (e) => pageErrors.push('[D] ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[D] ' + m.text()); });
      await page.goto(`${BASE}/?scene=map`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitReady(page);
      const mk = await listMarkers(page);
      const target = mk[3];
      const drag = await dragMarker(page, target.city, target.slotIdx, 100, 70);
      await page.click('#map-undo-btn');
      const afterUndo = await getMarker(page, target.city, target.slotIdx);
      const restored = approx(afterUndo.x, drag.before.x) && approx(afterUndo.y, drag.before.y);
      results.D = { ok: restored, restored, detail: { target, before: drag.before, afterDrag: drag.after, afterUndo } };
      await page.close();
    }

    // ---------- E. 缩放后撤回 → 回到修改前尺寸 ----------
    {
      const page = await browser.newPage();
      page.on('pageerror', (e) => pageErrors.push('[E] ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[E] ' + m.text()); });
      await page.goto(`${BASE}/?scene=map`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitReady(page);
      const mk = await listMarkers(page);
      const target = mk[4];
      const rz = await resizeMarker(page, target.city, target.slotIdx, 90);
      await page.click('#map-undo-btn');
      const afterUndo = await getMarker(page, target.city, target.slotIdx);
      const restored = approx(afterUndo.size, rz.before);
      results.E = { ok: restored, restored, detail: { target, before: rz.before, afterResize: rz.after, afterUndo: afterUndo.size } };
      await page.close();
    }

    // ---------- F. 移动两次 + 缩放两次 → 重置 → 回到初始 ----------
    {
      const page = await browser.newPage();
      page.on('pageerror', (e) => pageErrors.push('[F] ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[F] ' + m.text()); });
      await page.goto(`${BASE}/?scene=map`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitReady(page);
      const mk = await listMarkers(page);
      const target = mk[5];
      const initial = await page.evaluate((t) => {
        const sc = window.__game.scene.getScene('MapScene');
        const init = sc.__initial[t.city][t.slotIdx];
        return { x: init.x, y: init.y, size: init.size };
      }, target);
      await dragMarker(page, target.city, target.slotIdx, 80, 50);
      await dragMarker(page, target.city, target.slotIdx, 60, 40);
      await resizeMarker(page, target.city, target.slotIdx, 70);
      await resizeMarker(page, target.city, target.slotIdx, 60);
      const beforeReset = await getMarker(page, target.city, target.slotIdx);
      await page.click('#map-reset-btn');
      const afterReset = await getMarker(page, target.city, target.slotIdx);
      const restored = approx(afterReset.x, initial.x) && approx(afterReset.y, initial.y) && approx(afterReset.size, initial.size);
      const wasChanged = Math.abs(beforeReset.x - initial.x) > 1 || Math.abs(beforeReset.y - initial.y) > 1 || Math.abs(beforeReset.size - initial.size) > 1;
      results.F = { ok: wasChanged && restored, restored, wasChanged, detail: { target, initial, beforeReset, afterReset } };
      await page.close();
    }
  } finally {
    await browser.close();
    try { await copyFile(BAK, MAP_POINTS); } catch (e) { consoleErrors.push('还原 map_points.json 失败: ' + e.message); }
    try { await unlink(BAK); } catch {}
  }

  console.log('===== MARKER ACTIONS VALIDATION =====');
  const labels = { A: '单独拖动', B: '单独缩放', C: '保存位置+重启持久化', D: '移动后撤回', E: '缩放后撤回', F: '两次移动+两次缩放后重置' };
  let allOk = true;
  for (const k of Object.keys(results)) {
    const r = results[k];
    allOk = allOk && r.ok;
    console.log(`[${k}] ${labels[k]}: ${r.ok ? 'PASS ✅' : 'FAIL ❌'} ${JSON.stringify(r.detail)}`);
  }
  console.log('--- runtime errors ---');
  if (pageErrors.length === 0 && consoleErrors.length === 0) console.log('  OK: 无 pageerror / 无 console.error');
  else { pageErrors.forEach((e) => console.log('  ✗ ' + e)); consoleErrors.forEach((e) => console.log('  ✗ ' + e)); }
  const finalOk = allOk && pageErrors.length === 0 && consoleErrors.length === 0;
  console.log('\n===== RESULT: ' + (finalOk ? 'PASS ✅' : 'FAIL ❌') + ' =====');
  process.exit(finalOk ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
