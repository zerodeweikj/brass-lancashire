// 强制拆板抵债（收入为负且无力支付）真实鼠标 e2e（2026-08-12）：
//   规则（用户拍板）：轮末收入为负且没钱 → 强制点击自己的产业板块拆除抵债，
//   建造费用的一半（向下取整）用于还债，多余归玩家；一间不够继续拆；
//   拆光仍有欠债 → 1 分=1 钱 扣分；分数扣到 0 仍不足 → 一笔勾销 + 弹窗「算你好彩」。
// Part A（真实服务端全链路）：机器人房开局 → 作弊 → 双牌建煤厂(WIGAN) →
//   贷 1 档（收入后退 1 格=−1，得 +£10）→ 作弊把金钱清零 → 结束回合 →
//   引擎结算触发 pendingForeclose（debtor=本人，有 1 块煤厂）→ 真实点击地图上高亮煤厂 →
//   服务端 do_foreclose_tile：repay=成本5//2=2 ≥ 欠款1 → 余额 1 归玩家、煤厂移除、pending 清除。
// Part B（UI 接线）：直接调用 checkForecloseForgiven 验证「算你好彩」弹窗与「国补干嘛不薅？」按钮。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const st = (fn, arg) => page.evaluate(fn, arg);
const waitFor = async (fn, timeout = 12000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await page.evaluate(fn)) return true; } catch { /* ignore */ }
    await page.waitForTimeout(160);
  }
  console.log('  [warn] 等待超时:', label);
  return false;
};

// ---- 真实鼠标点击辅助 ----
const clickTop = async (text) => {
  const pt = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('#topbar button')].find((b) => b.textContent.includes(t) && !b.disabled);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  return true;
};
const clickModal = async (text) => {
  const pt = await page.evaluate((t) => {
    const root = document.querySelector('#actionstrip');
    if (!root || window.getComputedStyle(root).display === 'none') return null;
    const els = [...root.querySelectorAll('.as-opt, .as-btn')]
      .filter((b) => !b.disabled && !b.classList.contains('disabled'));
    const el = els.find((b) => b.textContent.includes(t));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  return true;
};
const confirmExec = async (label = '确认执行') => {
  await page.waitForTimeout(350);
  const clicked = await clickModal(label);
  await page.waitForTimeout(500);
  return clicked;
};
const pickNCardsAndNext = async (n) => {
  let guard = 0;
  while (guard++ < n * 4) {
    const idx = await st(() => {
      const els = [...document.querySelectorAll('#handcards .hcard.pickable')];
      return els.findIndex((c) => !c.classList.contains('sel'));
    });
    if (idx < 0) break;
    const pt = await st((i) => {
      const el = document.querySelectorAll('#handcards .hcard')[i];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, idx);
    if (!pt) break;
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(180);
    if (await st((n2) => document.querySelectorAll('#handcards .hcard.sel').length >= n2, n)) break;
  }
  await page.waitForTimeout(120);
  await clickModal('下一步');
};
const slotPt = async (loc, idx) => page.evaluate(([l, i]) => {
  const sc = window.__app.scene;
  const pos = sc._slotPos(l, i); if (!pos) return null;
  const cam = sc.cameras.main;
  const w0 = cam.getWorldPoint(0, 0), w1 = cam.getWorldPoint(cam.width, cam.height);
  const sx = (pos.x - w0.x) / (w1.x - w0.x) * cam.width;
  const sy = (pos.y - w0.y) / (w1.y - w0.y) * cam.height;
  const rect = document.querySelector('#game canvas').getBoundingClientRect();
  return { x: rect.left + sx, y: rect.top + sy };
}, [loc, idx]);
const waitSubmitOk = async (type, fromIdx = 0, timeout = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const subs = await st(() => window.__submits || []);
    const fresh = subs.slice(fromIdx);
    if (fresh.some((x) => x.t === type && x.ok)) return true;
    if (fresh.some((x) => x.t === type && !x.ok)) return false;
    await page.waitForTimeout(160);
  }
  return false;
};
const subsLen = () => st(() => (window.__submits || []).length);
const myTurn = async () => waitFor(() => window.__app?.state?.isMyTurn === true, 20000, '等我的回合');
const snap = () => st(() => {
  const s = window.__app?.state; if (!s) return null;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  return { ap: s.actionPoints, hand: me?.hand?.length ?? -1, money: me?.money,
           income: me?.incomePos, tiles: me?.industryTiles?.length ?? -1,
           pending: s.pendingForeclose || null };
});

// ================ ① 大厅：机器人房开局 ================
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('拆板抵债测试');
await page.waitForTimeout(120);
await st(() => { const c = document.querySelector('label.chk input[type=checkbox]'); if (c && !c.checked) c.click(); });
await st(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建'); if (b) b.click(); });
await waitFor(() => !!window.__app?.session?.room?.seats?.some((x) => x.isMe), 10000, '进房');
await st(() => { const r = [...document.querySelectorAll('button')].find((b) => /准备/.test(b.textContent)); if (r && !r.disabled) r.click(); });
await waitFor(() => window.__app?.session?.room?.status === 'playing', 15000, '开局');
await myTurn();
await waitFor(() => window.__app?.scene?.ready === true, 20000, '场景就绪');

// ================ ② 作弊 + 拦截 submit 记录 ================
await st(() => window.__app.session.cheat({ money: 300, actionPoints: 8 }).catch(() => {}));
await page.waitForTimeout(500);
await st(() => {
  window.__submits = [];
  const orig = window.__app.session.submit.bind(window.__app.session);
  window.__app.session.submit = async (a) => {
    const r = await orig(a);
    window.__submits.push({ t: a.type, ok: r?.ok, msg: r?.message || r?.fail_code || '' });
    return r;
  };
});
const s0 = await snap();
assert('作弊后：手牌 8 张、行动点 ≥ 8、金钱 ≥ 300', (s0?.hand ?? 0) >= 8 && (s0?.ap ?? 0) >= 8 && (s0?.money ?? 0) >= 300, JSON.stringify(s0));

// ================ ③ 双牌建造煤厂 L1 @ WIGAN 槽0（首建，可突破运输网） ================
await myTurn();
await clickTop('建造');
await page.waitForTimeout(150);
const dblOk = await clickTop('双手牌建造产业板块');
assert('打开双牌建造菜单', dblOk);
await waitFor(() => window.__app?.scene?.picker?.kind === 'build', 4000, '双牌建造选择态');
const wiganPt = await slotPt('WIGAN', 0);
const coalSlot = await (async () => {
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(wiganPt.x, wiganPt.y);
    await page.waitForTimeout(350);
    if (await st(() => !!document.querySelector('#handcards .cards.selecting'))) return true;
  }
  return false;
})();
assert('真实点击 WIGAN 槽0 建煤厂进入选牌', coalSlot);
await pickNCardsAndNext(2);
assert('煤厂出现「确认建造」', await waitFor(() => /确认建造/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认煤厂'));
const n0 = await subsLen();
await confirmExec();
assert('煤厂建造被引擎接受', await waitSubmitOk('doubleBuild', n0));
await page.waitForTimeout(400);
// 煤厂产出煤 → 可能弹出「补市场抉择」，一律选「留在板块上」保持板块存在
if (await st(() => /补充煤到市场/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''))) {
  await clickModal('留在板块上');
  await page.waitForTimeout(400);
  assert('补市场抉择已 dismissed（留在板块上）',
    await waitFor(() => { const r = document.querySelector('#actionstrip'); return !r || window.getComputedStyle(r).display === 'none'; }, 4000, 'dismiss'));
}
const s1 = await snap();
assert('已建 1 块产业（煤厂），用于后续拆板', (s1?.tiles ?? 0) === 1, JSON.stringify(s1));
assert('建造后金钱 > 0', (s1?.money ?? -1) > 0, JSON.stringify(s1));

// ================ ④ 贷 1 档：收入后退 1 格（10→9 = −1），得 +£10 ================
// 客户端 me.hand 是卡牌 id 字符串数组（见 app.js:1014 const cardId = hand[sel[0]]）
const loanCard = await st(() => {
  const s = window.__app.state;
  const me = s.players.find((p) => p.id === s.viewerId);
  return me?.hand?.[0] || null;
});
assert('手里有可弃的牌用于贷款', !!loanCard, String(loanCard));
const n1 = await subsLen();
await st((c) => window.__app.submit({ type: 'loan', tier: 1, cardId: c }, '贷款'), loanCard);
assert('贷款（1 档）被引擎接受', await waitSubmitOk('loan', n1));
await page.waitForTimeout(300);
const s2 = await snap();
assert('贷款后收入轨后退 1 格（incomePos 10→9，收入 −1）', (s2?.income ?? -1) === 9, JSON.stringify(s2));
assert('贷款后金钱 +£10（仍 > 0）', (s2?.money ?? 0) > (s1?.money ?? 0), `before=${s1?.money} after=${s2?.money}`);

// ================ ⑤ 作弊把金钱清零（大额负数会被 max(0,·) 夹到 0） ================
await st(() => window.__app.session.cheat({ money: -1000 }).catch(() => {}));
await page.waitForTimeout(400);
const s3 = await snap();
assert('作弊后金钱归零', (s3?.money ?? -1) === 0, JSON.stringify(s3));

// ================ ⑥ 结束回合 → 引擎结算触发强制拆板 ================
await st(() => window.__app.session.endTurn());
const pendingShown = await waitFor(() => !!window.__app?.state?.pendingForeclose, 12000, 'pendingForeclose');
assert('轮末收入为负且没钱 → 触发 pendingForeclose（debtor=本人）', pendingShown, JSON.stringify(await snap()));
const pend = await st(() => window.__app?.state?.pendingForeclose);
assert('欠款 remaining 正确（收入 −1 → 欠 1）', pend && pend.remaining === 1, JSON.stringify(pend));
assert('debtor 为本人', pend && pend.pid === (await st(() => window.__app.state.viewerId)), JSON.stringify(pend));

// ================ ⑦ UI 接线：强制拆板向导 + 地图高亮 ================
const strip = await st(() => ({
  title: document.querySelector('#actionstrip .as-title')?.textContent || '',
  body: document.querySelector('#actionstrip .as-body')?.textContent || '',
  cancel: [...document.querySelectorAll('#actionstrip .as-btn')].some((b) => b.textContent.trim() === '取消'),
}));
assert('行动向导显示「强制拆板抵债」', strip.title.includes('强制拆板抵债'), strip.title);
assert('正文说明：抵债 / 还债 / 一笔勾销',
  strip.body.includes('抵债') && strip.body.includes('还债') && strip.body.includes('一笔勾销'), strip.body);
assert('向导强制不可取消（无「取消」按钮）', !strip.cancel);
const picker = await st(() => {
  const p = window.__app?.scene?.picker;
  return p ? { kind: p.kind, tiles: (p.tiles || []).length } : null;
});
assert('地图选择态 = foreclose 且至少高亮 1 块（本人的煤厂）', picker && picker.kind === 'foreclose' && picker.tiles >= 1, JSON.stringify(picker));

// ================ ⑧ 真实点击地图上高亮的煤厂 → 拆除抵债 ================
const moneyBefore = (await snap())?.money;       // 应为 0
const n2 = await subsLen();
// 从服务端实际高亮 tile 反算屏幕坐标（避免硬编码槽位与真实落点不一致）
const wp = await st(() => {
  const sc = window.__app.scene;
  const t = (sc?.picker?.tiles || [])[0];
  if (!t) return null;
  const found = sc._findTile(t.tileId);
  const pos = found && sc._slotPos(found.location, found.slotIndex);
  if (!pos) return null;
  const cam = sc.cameras.main;
  const w0 = cam.getWorldPoint(0, 0), w1 = cam.getWorldPoint(cam.width, cam.height);
  const sx = (pos.x - w0.x) / (w1.x - w0.x) * cam.width;
  const sy = (pos.y - w0.y) / (w1.y - w0.y) * cam.height;
  const rect = document.querySelector('#game canvas').getBoundingClientRect();
  return { x: rect.left + sx, y: rect.top + sy };
});
assert('反算出高亮煤厂的屏幕坐标', !!wp, JSON.stringify(wp));
// Phaser 合成点击对 down/up 时序敏感，用「移动→按下→抬起」并带重试
let clicked = false;
for (let i = 0; i < 6 && !clicked; i++) {
  await page.mouse.move(wp.x, wp.y);
  await page.waitForTimeout(60);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(500);
  clicked = await waitSubmitOk('foreclose_tile', n2, 200);
}
assert('点击煤厂提交 foreclose_tile 被引擎接受', clicked);
await page.waitForTimeout(500);
const after = await st(() => {
  const s = window.__app?.state; if (!s) return null;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  const coal = (me?.industryTiles || []).find((t) => t.buildingId === 'building_002' && t.location === 'WIGAN');
  return { money: me?.money, tiles: me?.industryTiles?.length ?? -1, coal: !!coal, pending: s.pendingForeclose || null };
});
// 煤厂成本 5 → repay=2；欠款 remaining=1 → leftover=1 归玩家，煤厂移除，pending 清除
assert('拆板后金钱 = 0 + 余额 1（repay 2 − 欠 1）', (after?.money ?? -1) === (moneyBefore ?? 0) + 1, `before=${moneyBefore} after=${after?.money}`);
assert('煤厂已从地图上移除（industryTiles 空）', after && after.tiles === 0 && !after.coal, JSON.stringify(after));
assert('pendingForeclose 已清除（拆板足够抵债）', !after?.pending, JSON.stringify(after));
assert('拆板后向导条收起', await waitFor(() => {
  const r = document.querySelector('#actionstrip');
  return !r || window.getComputedStyle(r).display === 'none';
}, 4000, '向导收起'));

// ================ Part B · UI 接线：一笔勾销弹窗「算你好彩」 ================
await st(() => {
  const app = window.__app, s = app.state;
  app.checkForecloseForgiven({ forecloseForgiven: { pid: s.viewerId }, phase: s.phase, round: s.round, players: s.players });
});
const forgivenModal = await waitFor(() => {
  const m = document.querySelector('#modal, .modal');
  const t = m?.textContent || '';
  return t.includes('算你好彩');
}, 6000, '算你好彩弹窗');
assert('调用 checkForecloseForgiven → 弹出「算你好彩」', forgivenModal);
const forgiveUi = await st(() => {
  const m = document.querySelector('#modal, .modal');
  return { title: m?.querySelector('.modal-title, .as-title')?.textContent || '',
           hasOk: [...(m?.querySelectorAll('button') || [])].some((b) => b.textContent.includes('国补干嘛不薅？')) };
});
assert('弹窗含「国补干嘛不薅？」按钮', forgiveUi.hasOk, JSON.stringify(forgiveUi));

// ================ 汇总 ================
console.log('\nSUMMARY  CHECKS: ' + checks.length + '  FAIL: ' + checks.filter((c) => !c.ok).length);
if (errors.length) console.log('  [pageerror]', errors.slice(0, 3).join(' | '));
await browser.close();
if (checks.some((c) => !c.ok)) process.exit(1);
console.log('全部通过 ✅');
