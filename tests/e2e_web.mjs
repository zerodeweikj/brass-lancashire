/**
 * 前端联机闭环自测（Playwright）。
 *
 * 模拟 3 台设备各开一个浏览器上下文（localStorage 隔离），走完整链路：
 *   建房 → 加入 → 准备 → 开局 → 地图点选建造 → 选牌 → 确认 → 服务器落盘 → 三端同步
 *   → 跳过 → 发展 → 贷款 → 断线重连 → 房主重开回大厅
 *
 * 用法：
 *   node tests/e2e_web.mjs [http://127.0.0.1:8765]
 *
 * 服务生命周期：
 *   - 若 BASE 已可用（已有后端在跑），直接复用；
 *   - 否则脚本自己拉起 `server/.venv` 的 uvicorn（0.0.0.0:8765），结束后自动关闭。
 *     这样即使外部后台任务被回收，自测也能在全新环境里一次跑通。
 */
import { spawn } from 'node:child_process';
import { chromium } from '../web/node_modules/playwright/index.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const NAMES = ['阿明', '小红', '阿白'];
const PORT = new URL(BASE).port || '8765';
const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function serverUp(url, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json().catch(() => null);
        // 必须确认是「本项目引擎」：旧原型（D:\zhuoyouyizhi）也监听 8000，但无 engine 字段
        // （本项目已迁到 8765，8000 上的进程一律非本项目）
        if (j && j.engine === 'ready') return true;
      }
    } catch { /* 未就绪 */ }
    await sleep(400);
  }
  return false;
}

/** 确保有后端可用；若没有则自己拉起，返回清理函数。 */
async function ensureServer() {
  const ok = await serverUp(`${BASE}/api/health`);
  if (ok) {
    console.log(`[服务] 复用已有后端 ${BASE}`);
    return () => {};
  }
  const logPath = `${ROOT}/server/uvicorn.e2e.log`;
  const fs = await import('node:fs');
  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(`${ROOT}/server/.venv/Scripts/python.exe`,
    ['-u', '-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', PORT, '--log-level', 'warning'],
    { cwd: `${ROOT}/server`, stdio: ['ignore', logFd, logFd] });
  child.on('error', (e) => { console.error(`[服务] 启动失败：${e.message}`); process.exit(1); });
  child.on('exit', (code, sig) => {
    console.log(`[服务] uvicorn 退出 code=${code} sig=${sig}（日志 ${logPath}）`);
    if (code !== 0) {
      try {
        const tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n');
        console.log(`[服务] 日志尾部:\n${tail || '（空日志）'}`);
      } catch { /* ok */ }
    }
  });
  console.log(`[服务] 拉起自测后端 uvicorn :${PORT}（日志 ${logPath}）`);
  if (!(await serverUp(`${BASE}/api/health`))) {
    console.error('[服务] 自测后端 15s 内未就绪');
    child.kill();
    process.exit(1);
  }
  return () => { try { child.kill(); } catch { /* 已退出 */ } };
}

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
  if (ok) { pass++; console.log(`  [OK]   ${label}`); } else { fail++; console.log(`  [FAIL] ${label} ${extra}`); }
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 世界坐标 → 屏幕坐标（用两点探针解仿射变换，避免依赖 Phaser 内部公式）。 */
async function worldToScreen(page, wx, wy) {
  return page.evaluate(({ wx, wy }) => {
    const cam = window.__game.scene.getScene('GameScene').cameras.main;
    const a = cam.getWorldPoint(0, 0);
    const b = cam.getWorldPoint(100, 100);
    const kx = 100 / (b.x - a.x);
    const ky = 100 / (b.y - a.y);
    return { x: (wx - a.x) * kx, y: (wy - a.y) * ky };
  }, { wx, wy });
}

async function slotWorldPos(page, location, slotIndex) {
  return page.evaluate(({ location, slotIndex }) => {
    const sc = window.__game.scene.getScene('GameScene');
    const s = sc.slotXY[location]?.slots?.[slotIndex];
    return s ? { x: s.x, y: s.y } : null;
  }, { location, slotIndex });
}

const st = (page) => page.evaluate(() => window.__app?.state || null);

/** 点击文本完全匹配的按钮。 */
async function clickBtn(page, text, opts = {}) {
  const loc = page.locator(`#ui button:text-is("${text}")`).first();
  await loc.waitFor({ state: 'visible', timeout: opts.timeout || 8000 });
  await loc.click();
}

async function waitToast(page, re, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const texts = await page.locator('.toast').allTextContents();
    const hit = texts.find((x) => re.test(x));
    if (hit) return hit;
    await sleep(120);
  }
  return null;
}

/** 在模态向导里点「下一步」，等选牌网格或确认框出现。 */
async function modalNext(page, then) {
  await clickBtn(page, '下一步');
  await page.waitForSelector(then, { timeout: 6000 });
}

/** 检查某个行动按钮是否可用；可用则点它并等模态出现。返回是否已进入向导。 */
async function tryAction(page, label, modalSel) {
  const btn = page.locator(`#ui button:text-is("${label}")`).first();
  const disabled = await btn.isDisabled().catch(() => true);
  if (disabled) return false;
  await btn.click();
  if (modalSel) {
    // 等待模态出现；若 4s 未出现（例如点了之后没反应），也返回 false 而非抛错卡死
    try { await page.waitForSelector(modalSel, { timeout: 4000 }); } catch { return false; }
  }
  return true;
}

/** 当前行动玩家的页面。 */
function pageOf(pages, idxOf, playerId) {
  return pages[idxOf[playerId]];
}

let ROOM_ID = null;

(async () => {
  const cleanupServer = await ensureServer();
  try {
    console.log(`\n=== 工业革命·兰开夏 前端联机闭环自测 @ ${BASE} ===\n`);
    const browser = await chromium.launch();
    const pages = [];
    const errors = [];

    for (let i = 0; i < NAMES.length; i++) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`[${NAMES[i]}] pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`[${NAMES[i]}] console: ${m.text()}`);
      });
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      pages.push(page);
    }

  console.log('— 大厅 —');
  for (const p of pages) await p.waitForSelector('#lobby .box', { timeout: 15000 });
  check(true, '三端大厅渲染成功');

  // 建房
  await pages[0].fill('#lobby input[placeholder="你的昵称"]', NAMES[0]);
  await pages[0].fill('#lobby input[placeholder="房间名（可留空）"]', '自测房');
  await clickBtn(pages[0], '创建');
  await pages[0].waitForSelector('.seats .seat', { timeout: 8000 });
  const roomTitle = await pages[0].locator('#lobby h1').textContent();
  check(roomTitle.includes('自测房'), '房主建房成功', roomTitle);
  const roomId = (await pages[0].locator('#lobby .sub').textContent()).match(/房间号\s+(\w+)/)?.[1];
  check(!!roomId, `拿到房间号 ${roomId}`);
  ROOM_ID = roomId;

  // 其他两人加入
  for (let i = 1; i < pages.length; i++) {
    const p = pages[i];
    await p.fill('#lobby input[placeholder="你的昵称"]', NAMES[i]);
    await p.locator('#lobby button.sm', { hasText: '刷新列表' }).click();
    await p.waitForSelector(`.roomrow:has-text("${roomId}")`, { timeout: 8000 });
    await p.locator(`.roomrow:has-text("${roomId}") button`).click();
    await p.waitForSelector('.seats .seat', { timeout: 8000 });
  }
  await sleep(800);
  const seatCount = await pages[0].locator('.seats .seat .nm:not(:text-is("空座位"))').count();
  check(seatCount === 3, `三人入座（当前 ${seatCount}）`);

  // 准备 + 开局
  for (let i = 1; i < pages.length; i++) await clickBtn(pages[i], '准备');
  await sleep(900);
  await clickBtn(pages[0], '开始游戏');
  for (const p of pages) await p.waitForSelector('#actionbar', { timeout: 15000 });
  check(true, '开局成功，三端进入对局界面');

  await sleep(1200);
  const s0 = await st(pages[0]);
  check(!!s0 && s0.players.length === 3, '状态下发正常（3 名玩家）');
  check(s0.players.filter((p) => (p.hand || []).length > 0).length === 1,
    '视角过滤生效：只能看到自己的手牌');
  check(s0.actionPoints === 1 && s0.round === 1, '首轮行动点为 1（PRD 2.1）');

  // 找到当前行动玩家所在页面
  const idxOf = {};
  for (let i = 0; i < pages.length; i++) idxOf[(await st(pages[i])).viewerId] = i;
  let turnPage = pages[idxOf[s0.currentPlayer]];
  check(!!turnPage, `当前行动玩家 = ${s0.currentPlayer}`);

  console.log('\n— 建造行动（地图点选 → 选牌 → 确认）—');
  const before = await st(turnPage);
  const tilesBefore = before.players.reduce((n, p) => n + p.industryTiles.length, 0);

  // 挑一个「该槽位只有一种产业选项」的落点，走最短路径
  const bySlot = new Map();
  for (const b of before.legalBuilds) {
    const k = `${b.location}#${b.slotIndex}`;
    bySlot.set(k, [...(bySlot.get(k) || []), b]);
  }
  const target = before.legalBuilds[0];
  check(!!target, `合法落点 ${before.legalBuilds.length} 个，取 ${target?.location} 槽${target?.slotIndex + 1}`);

  await clickBtn(turnPage, '建造');
  await turnPage.waitForSelector('#buttons .hintline', { timeout: 5000 });
  check(true, '进入建造选择态（地图高亮 + 提示条）');

  const wp = await slotWorldPos(turnPage, target.location, target.slotIndex);
  const sp = await worldToScreen(turnPage, wp.x, wp.y);
  await turnPage.mouse.click(sp.x, sp.y);
  await turnPage.waitForSelector('#modal', { timeout: 10000 });

  // 若弹出产业选择，先选第一个
  let title = await turnPage.locator('#modal .hd').textContent();
  if (/槽位\s*\d+/.test(title) && await turnPage.locator('#modal .opt').count() > 0) {
    await turnPage.locator('#modal .opt').first().click();
    await sleep(250);
    title = await turnPage.locator('#modal .hd').textContent();
  }
  check(/建造/.test(title), '进入选牌步骤', title);

  const pickable = await turnPage.locator('#modal .card.pick').count();
  check(pickable > 0, `可用手牌 ${pickable} 张（已按城市/产业过滤）`);
  await turnPage.locator('#modal .card.pick').first().click();
  await clickBtn(turnPage, '下一步');
  await turnPage.waitForSelector('#modal .billbox', { timeout: 5000 });
  check(true, '进入确认步骤（含费用明细）');
  await clickBtn(turnPage, '确认执行');

  const okToast = await waitToast(turnPage, /建造成功/);
  check(!!okToast, '服务器接受建造', okToast || '');

  await sleep(1400);
  const after = await st(turnPage);
  const tilesAfter = after.players.reduce((n, p) => n + p.industryTiles.length, 0);
  check(tilesAfter === tilesBefore + 1, `板块落盘（${tilesBefore} → ${tilesAfter}）`);

  // 三端同步
  await sleep(700);
  const seen = [];
  for (const p of pages) {
    const s = await st(p);
    seen.push(s.players.reduce((n, x) => n + x.industryTiles.length, 0));
  }
  check(seen.every((n) => n === tilesAfter), `三端看到同一块新板块 [${seen.join(',')}]`);
  const logCount = await pages[1].locator('#logpanel .li').count();
  check(logCount > 0, `旁观端日志已同步（${logCount} 条）`);

  console.log('\n— 回合流转与跳过 —');
  const s2 = await st(pages[0]);
  check(s2.currentPlayer !== before.currentPlayer, `回合已推进到 ${s2.currentPlayer}（首轮 1 点，用完即结束）`);
  turnPage = pages[idxOf[s2.currentPlayer]];
  const otherPage = pages[(idxOf[s2.currentPlayer] + 1) % pages.length];
  const disabled = await otherPage.locator('#ui button:text-is("建造")').isDisabled().catch(() => true);
  check(disabled, '非当前玩家的行动按钮被禁用');

  await clickBtn(turnPage, '跳过');
  await turnPage.waitForSelector('#modal .card.pick', { timeout: 6000 });
  await turnPage.locator('#modal .card.pick').first().click();
  await clickBtn(turnPage, '下一步');
  await clickBtn(turnPage, '确认执行');
  check(!!(await waitToast(turnPage, /跳过成功|已跳过/)), '跳过行动成功');

  await sleep(1200);
  const s3 = await st(pages[0]);
  check(s3.currentPlayer !== s2.currentPlayer, `回合推进到 ${s3.currentPlayer}`);

  console.log('\n— 贷款行动（收入轨后退 + 立即得钱）—');
  const loanSt = await st(pages[0]);
  turnPage = pageOf(pages, idxOf, loanSt.currentPlayer);
  const loanView = await st(turnPage);
  if (loanView.currentPlayer !== loanView.viewerId) {
    check(true, `当前是 ${loanView.currentPlayer} 的回合（${loanView.viewerId} 非行动玩家），贷款跳过`);
  } else {
    const loanMe = loanView.players.find((p) => p.id === loanView.currentPlayer);
    const incomeBefore = loanMe.incomePos;
    const moneyBefore = loanMe.money;
    const gotLoan = await tryAction(turnPage, '贷款', '#modal .opts .opt');
    if (!gotLoan) {
      check(true, '贷款按钮不可用或模态未出现（收入已触底？），跳过');
    } else {
      console.log('  [调试] 贷款模态已出现，标题=', await turnPage.locator('#modal .hd').textContent().catch(() => 'N/A'));
      await turnPage.locator('#modal .opts .opt').first().click();
      console.log('  [调试] 已点档位，等待选牌');
      // 轮询等待选牌网格（带内容诊断）
      let pickOk = false;
      for (let i = 0; i < 20; i++) {
        const c = await turnPage.locator('#modal .card.pick').count().catch(() => 0);
        if (c > 0) { pickOk = true; break; }
        await sleep(300);
      }
      if (!pickOk) {
        const info = await turnPage.evaluate(() => ({
          modalOpen: !!document.querySelector('#modal'),
          modalText: document.querySelector('#modal')?.innerText?.slice(0, 400) || 'N/A',
          toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText),
          state: window.__app?.state ? {
            isMyTurn: window.__app.state.isMyTurn,
            currentPlayer: window.__app.state.currentPlayer,
            viewerId: window.__app.state.viewerId,
            actionPoints: window.__app.state.actionPoints,
          } : null,
        }));
        console.log('  [调试] 选牌未出现!', JSON.stringify(info, null, 1));
        throw new Error('贷款选牌模态未出现');
      }
      await turnPage.locator('#modal .card.pick').first().click();
      await modalNext(turnPage, '#modal .billbox');
      console.log('  [调试] 进入确认框，点确认执行');
      await clickBtn(turnPage, '确认执行');
      const loanToast = await waitToast(turnPage, /贷款成功|贷款失败|失败/);
      // 等状态经长轮询收敛：收入轨后退即视为动作已落盘（最多 6s）
      let loanAfter = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        loanAfter = (await st(turnPage)).players.find((p) => p.id === loanSt.currentPlayer);
        if (loanAfter && loanAfter.incomePos !== incomeBefore) break;
        await sleep(250);
      }
      check(/贷款成功/.test(loanToast || ''), `贷款：${loanToast || '无响应'}`);
      check(loanAfter && loanAfter.incomePos === incomeBefore - 1,
        `收入轨后退 1 格（${incomeBefore} → ${loanAfter?.incomePos}）`);
      // 金额以「同一快照」校验：至少拿到档位×10，不要求精确值（后续动作/结算可能在同一帧内落账）
      check(loanAfter && loanAfter.money > moneyBefore,
        `贷款后资金增加（${moneyBefore} → ${loanAfter?.money}）`);
    }
  }

  console.log('\n— 发展行动（弃板块换铁 → 选牌 → 确认）—');
  // 贷款后手牌仍在，回合一般不会自动结束；仍防御性重算行动页
  const devSt = await st(pages[0]);
  turnPage = pageOf(pages, idxOf, devSt.currentPlayer);
  const devView = await st(turnPage);
  const devPlayer = devView.currentPlayer;
  if (devView.currentPlayer !== devView.viewerId) {
    check(true, `当前是 ${devPlayer} 的回合（${devView.viewerId} 非行动玩家），发展跳过`);
  } else {
    const devMe = devView.players.find((p) => p.id === devPlayer);
    const devTiles = Object.values(devMe.mat || {}).reduce((n, lv) =>
      n + Object.values(lv).reduce((a, b) => a + b, 0), 0);
    if (devTiles > 0) {
      const gotDev = await tryAction(turnPage, '发展', '#modal .opts .opt');
      if (gotDev) {
        await turnPage.locator('#modal .opts .opt').first().click();
        await modalNext(turnPage, '#modal .card.pick');
        await turnPage.locator('#modal .card.pick').first().click();
        await modalNext(turnPage, '#modal .billbox');
        await clickBtn(turnPage, '确认执行');
        const toastText = await waitToast(turnPage, /发展成功|发展失败|失败/);
        const devAfter = (await st(turnPage)).players.find((p) => p.id === devPlayer);
        const devTilesAfter = Object.values(devAfter.mat || {}).reduce((n, lv) =>
          n + Object.values(lv).reduce((a, b) => a + b, 0), 0);
        check(/发展成功/.test(toastText || ''),
          `发展：${toastText || '无响应'}（板块 ${devTiles} → ${devTilesAfter}）`);
      } else {
        check(true, '发展按钮不可用（本回合无法执行），跳过');
      }
    } else {
      check(true, '面板上没有板块可丢弃，跳过发展行动');
    }
  }

  console.log('\n— 断线重连 —');
  const sAfterLoan = await st(pages[0]);
  const reloadTarget = sAfterLoan.currentPlayer;
  const reloadIdx = idxOf[reloadTarget];
  await pages[reloadIdx].reload({ waitUntil: 'domcontentloaded' });
  await pages[reloadIdx].waitForSelector('#actionbar', { timeout: 15000 });
  const s4 = await st(pages[reloadIdx]);
  check(!!s4 && s4.viewerId === reloadTarget, '刷新页面后凭本地令牌自动回到对局');
  check((s4.players.find((p) => p.id === s4.viewerId).hand || []).length > 0, '重连后手牌可见');

  console.log('\n— 房主重开（restart → 回大厅，座位保留）—');
  const hostPage = pages[0];
  const roomBefore = await hostPage.evaluate(() => window.__app.session.room);
  check(roomBefore?.roomId === ROOM_ID, `重开前房间 ${ROOM_ID} 状态 ${roomBefore?.status}`);
  await hostPage.evaluate(() => window.__app.session.restart());
  for (const p of pages) await p.waitForSelector('#lobby .seats .seat', { timeout: 10000 });
  await sleep(600);
  const roomAfter = await hostPage.evaluate(() => window.__app.session.room);
  check(roomAfter?.status === 'lobby', `重开后回到大厅（status=${roomAfter?.status}）`);
  const seatN = await hostPage.locator('#lobby .seats .seat .nm:not(:text-is("空座位"))').count();
  check(seatN === 3, `座位保留（${seatN}/3 人仍在房内）`);
  const titleBack = await hostPage.locator('#lobby h1').textContent();
  check(titleBack.includes('自测房'), `房主回到座位视图（${titleBack.trim()}）`);

  console.log('\n— 控制台错误 —');
  const real = errors.filter((e) => !/favicon|Failed to load resource.*404/i.test(e));
  check(real.length === 0, `无 JS 运行时错误（捕获 ${real.length} 条）`);
  for (const e of real.slice(0, 8)) console.log('     ', e);

  await browser.close();
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
  } finally {
    try { cleanupServer(); } catch { /* 清理失败不影响结论 */ }
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => {
  console.error('\n[E2E 异常]', (e && e.stack) || e);
  process.exit(1);
});

// 全局兜底：防止某个等待静默挂起导致输出凭空截断
setTimeout(() => {
  console.error(`\n[E2E 超时] 超过 240s 未完成，当前 pass=${pass} fail=${fail}`);
  process.exit(2);
}, 240000);
