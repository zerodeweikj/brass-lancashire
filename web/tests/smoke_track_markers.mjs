// 轨道标记冒烟：分数标记 + 收入标记（每玩家各一）沿 score_track 坐标渲染。
// 验证：① score_track.json / income_track.json 加载无 404；② GameScene 加载了两份轨数据；
//       ③ 每位玩家都有 score/income 两个标记（trackC 容器有对应子节点，_trackPrev 有键）；
//       ④ 标记坐标落在轨坐标范围内（非原点，已真正画到轨道上）。
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8765/';
const allErrors = [];
const IGNORE_404 = ['card_back', '/markers/', 'player_board', 'remote_market', 'tiles/'];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
page.on('response', (r) => {
  if (r.status() === 404 && !IGNORE_404.some((s) => r.url().includes(s))) allErrors.push('404: ' + r.url());
});

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const st = (fn, arg) => page.evaluate(fn, arg);

// ---- 建房（机器人陪练房） ----
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('轨道测试');
await page.waitForTimeout(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();

await page.waitForFunction(() => {
  const s = window.__app?.session;
  return !!s?.room?.seats?.some((x) => x.isMe);
}, { timeout: 10000 });

const readyBtn = page.getByRole('button', { name: /准备|取消准备/ }).first();
if ((await readyBtn.innerText().catch(() => '')) === '准备') await readyBtn.click();

let playing = false;
for (let i = 0; i < 80; i++) {
  const r = await st(() => {
    const s = window.__app?.session;
    return { status: s?.room?.status, myTurn: !!s?.isMyTurn };
  });
  if (r.status === 'playing' && r.myTurn) { playing = true; break; }
  await page.waitForTimeout(300);
}
assert('满员自动开局且轮到人类', playing);

// 等待 GameScene 就绪且轨数据加载
await page.waitForFunction(() => {
  const sc = window.__game?.scene?.getScene('GameScene');
  return !!sc?.ready && sc?.scoreTrack && sc?.incomeTrack;
}, { timeout: 12000 }).catch(() => {});

// 轨道标记检查
const info = await st(() => {
  const sc = window.__game.scene.getScene('GameScene');
  if (!sc) return { ok: false, reason: 'no scene' };
  const players = window.__app?.session?.state?.players || [];
  const prev = sc._trackPrev || {};
  const keys = Object.keys(prev);
  const onTrack = keys.filter((k) => {
    const c = prev[k];
    return c && (Math.abs(c.x) > 1 || Math.abs(c.y) > 1);
  });
  return {
    ok: true,
    hasScoreTrack: !!sc.scoreTrack && Array.isArray(sc.scoreTrack.positions) && sc.scoreTrack.positions.length === 100,
    hasIncomeTrack: !!sc.incomeTrack && Array.isArray(sc.incomeTrack.positions),
    trackC: sc.trackC ? sc.trackC.length : -1,
    playerCount: players.length,
    scoreKeys: players.map((p) => `${p.id}:score`).filter((k) => k in prev),
    incomeKeys: players.map((p) => `${p.id}:income`).filter((k) => k in prev),
    onTrackCount: onTrack.length,
    sample: keys.slice(0, 6),
  };
});

assert('score_track.json 已加载(100格)', info.hasScoreTrack, JSON.stringify(info).slice(0, 120));
assert('income_track.json 已加载', info.hasIncomeTrack);
assert('trackC 容器含标记(>=玩家数*2)', info.trackC >= info.playerCount * 2,
       `trackC=${info.trackC} players=${info.playerCount}`);
assert('每位玩家都有分数标记键', info.scoreKeys.length === info.playerCount, JSON.stringify(info.scoreKeys));
assert('每位玩家都有收入标记键', info.incomeKeys.length === info.playerCount, JSON.stringify(info.incomeKeys));
assert('标记已落到轨坐标(非原点)', info.onTrackCount >= info.playerCount * 2,
       `onTrack=${info.onTrackCount} sample=${JSON.stringify(info.sample)}`);

// 收入标记应使用彩色圆点图片；分数标记应为正六边形矢量（非图片）
const imgInfo = await st(() => {
  const sc = window.__game.scene.getScene('GameScene');
  if (!sc?.trackC) return { ok: false };
  const players = window.__app?.session?.state?.players || [];
  const out = {};
  for (const p of players) {
    const inc = sc.trackC.list.find((c) => c && c.name === `${p.id}:income`);
    const sc2 = sc.trackC.list.find((c) => c && c.name === `${p.id}:score`);
    const incImg = inc?.list?.find((x) => x.type === 'Image');
    const scG = sc2?.list?.find((x) => x.type === 'Graphics');
    out[p.id] = {
      incomeTexture: incImg ? incImg.texture?.key : null,
      scoreIsHex: !!scG,
    };
  }
  return { ok: true, data: out };
});
const allIncomeImages = imgInfo.ok && Object.values(imgInfo.data).every((v) => v.incomeTexture && /^score_/.test(v.incomeTexture));
const allScoreHex = imgInfo.ok && Object.values(imgInfo.data).every((v) => v.scoreIsHex);
assert('收入标记使用彩色圆点图片', allIncomeImages, JSON.stringify(imgInfo.data));
assert('分数标记为六边形矢量', allScoreHex, JSON.stringify(imgInfo.data));

// 实时移动验证：把某玩家分数+收入各推进，标记应出现 tween 目标变化
const moved = await st(async () => {
  const sc = window.__game.scene.getScene('GameScene');
  const s = window.__app.session.state;
  const p = s.players[0];
  const before = (sc._trackPrev || {})[`${p.id}:score`];
  // 直接改状态并触发一次 render（模拟分数变化）
  s.scores = s.scores || {};
  s.scores[p.id] = { total: ((s.scores?.[p.id]?.total || 0) + 7) };
  p.incomePos = Math.min(99, (p.incomePos || 0) + 5);
  sc.render && sc.render();
  await new Promise((r) => setTimeout(r, 600));
  const after = (sc._trackPrev || {})[`${p.id}:score`];
  return { before, after };
});
const movedOk = moved.before && moved.after
  && (Math.abs(moved.before.x - moved.after.x) > 1 || Math.abs(moved.before.y - moved.after.y) > 1);
assert('分数变化后标记沿轨移动(tween)', movedOk, JSON.stringify(moved));

await browser.close();

const resp404 = allErrors.filter((e) => e.startsWith('404:')).map((e) => e.slice(5));
const unexpected404 = resp404.filter((u) => !IGNORE_404.some((s) => u.includes(s)));
const generic404 = allErrors.filter((e) => e.startsWith('console:') && /Failed to load resource.*404/.test(e));
const realErrors = allErrors.filter((e) => !e.startsWith('404:') && !generic404.includes(e))
  .concat(unexpected404.map((u) => '404: ' + u));
assert('无 score_track/income_track 404', !resp404.some((u) => u.includes('score_track') || u.includes('income_track')),
       resp404.filter((u) => u.includes('score_track') || u.includes('income_track')).join(' | '));
assert('无运行时错误', realErrors.length === 0, realErrors.join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY  CHECKS: ${checks.length}  FAIL: ${failed.length}`);
if (failed.length) { for (const c of failed) console.log('  FAILED: ' + c.name + (c.extra ? '  -- ' + c.extra : '')); process.exit(1); }
console.log('全部通过 ✅');
