// 建造铁/煤厂后「补市场抉择」真实鼠标 e2e（2026-08-11 用户拍板）：
// 规则：建造后必须由玩家选择是否补入市场（系统不默认）；补入=移动资源+按槽位面值给钱
//       （最高价优先）；部分补充留板不翻面；全卖才翻面+收入奖励。
// Part1（真实服务端全链路）：建煤厂(WIGAN) → 修路 WIGAN-BLACKBURN → 发展铁厂×3（耗空 3 铁）
//      → 双牌建 L4 铁厂(BLACKBURN 产6铁) → 服务端返回 needSupplement → 弹窗断言 →
//      真实点击「补入市场」→ 服务端验证（钱 +4、市场满、留 3 铁、不翻面）。
// Part2（UI 接线）：monkeypatch submit 伪造 needSupplement → 点「留在板块上」校验 payload
//      supply=false；提交失败且服务端仍有 pending → 弹窗自动恢复。
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
const clickUntil = async (clickFn, expectSel, retries = 3, gap = 300) => {
  for (let i = 0; i < retries; i++) {
    await clickFn();
    await page.waitForTimeout(gap);
    const ok = await st((s) => !!document.querySelector(s), expectSel);
    if (ok) return true;
  }
  return false;
};
const confirmExec = async (label = '确认执行') => {
  await page.waitForTimeout(350);
  const clicked = await clickModal(label);
  await page.waitForTimeout(500);
  return clicked;
};
// 选 n 张手牌后点「下一步」（双牌建造要选 2 张）
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
const pickCardAndNext = () => pickNCardsAndNext(1);
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
const worldPt = async (wx, wy) => page.evaluate(([x, y]) => {
  const sc = window.__app.scene; const cam = sc.cameras.main;
  const w0 = cam.getWorldPoint(0, 0), w1 = cam.getWorldPoint(cam.width, cam.height);
  const sx = (x - w0.x) / (w1.x - w0.x) * cam.width;
  const sy = (y - w0.y) / (w1.y - w0.y) * cam.height;
  const rect = document.querySelector('#game canvas').getBoundingClientRect();
  return { x: rect.left + sx, y: rect.top + sy };
}, [wx, wy]);
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

// ================ ① 大厅：机器人房开局 ================
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('补市场测试');
await page.waitForTimeout(120);
await page.evaluate(() => { const c = document.querySelector('label.chk input[type=checkbox]'); if (c && !c.checked) c.click(); });
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建'); if (b) b.click(); });
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
const snap = () => st(() => {
  const s = window.__app?.state; if (!s) return null;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  return { ap: s.actionPoints, hand: me?.hand?.length ?? -1, money: me?.money,
           income: me?.incomePos, phase: s.phase };
});
const s0 = await snap();
assert('作弊后手牌 8 张、行动点 ≥ 8（一个回合内完成全部准备动作）', (s0?.hand ?? 0) >= 8 && (s0?.ap ?? 0) >= 8,
  JSON.stringify(s0));

// 双牌建造入口（真实点击：建造 → 双手牌建造产业板块）
const startDoubleBuild = async () => {
  await clickTop('建造');
  await page.waitForTimeout(150);
  const ok = await clickTop('双手牌建造产业板块');
  await waitFor(() => window.__app?.scene?.picker?.kind === 'build', 4000, '双牌建造选择态');
  return ok;
};

// ================ ③ 双牌建造煤厂 L1 @ WIGAN 槽0（首建，市场满 → 不应弹补市场） ================
await myTurn();
await startDoubleBuild();
const wiganPt = await slotPt('WIGAN', 0);
const coalSlot = await clickUntil(() => page.mouse.click(wiganPt.x, wiganPt.y), '#handcards .cards.selecting', 3, 350);
assert('真实点击 WIGAN 槽0 建煤厂进入选牌', coalSlot);
await pickNCardsAndNext(2);
assert('煤厂出现「确认建造」', await waitFor(() => /确认建造/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认煤厂'));
const n0 = await subsLen();
await confirmExec();
assert('煤厂建造被引擎接受', await waitSubmitOk('doubleBuild', n0));
await page.waitForTimeout(300);
const coalModal = await st(() => document.querySelector('#actionstrip .as-title')?.textContent || '');
assert('煤厂市场满 → 不弹「补充煤到市场」', !coalModal.includes('补充煤'), coalModal);

// ================ ④ 修路 WIGAN-BLACKBURN（煤厂入网，供铁厂用煤） ================
await myTurn();
await clickTop('建造');
await page.waitForTimeout(150);
await clickTop('建造连接板块');
await waitFor(() => window.__app?.scene?.picker?.kind === 'road', 4000, '修路选择态');
const roadGeo = await st(() => {
  const s = window.__app?.state; const sc = window.__app.scene;
  const l = (s?.legalLinks || []).find((x) => sc._pairKey(x.from, x.to) === sc._pairKey('WIGAN', 'BLACKBURN'));
  if (!l) return null;
  const geo = sc.linkByPair?.[sc._pairKey(l.from, l.to)];
  return geo ? { geo } : null;
});
if (roadGeo) {
  const pt = await worldPt(roadGeo.geo.x, roadGeo.geo.y);
  const cardOk = await clickUntil(() => page.mouse.click(pt.x, pt.y), '#handcards .cards.selecting', 3, 350);
  assert('真实点击 WIGAN-BLACKBURN 连接后弹出选牌', cardOk);
  await pickCardAndNext();
  assert('修路出现「确认修路」', await waitFor(() => /确认修路/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认修路'));
  const n1 = await subsLen();
  await confirmExec();
  assert('修路被引擎接受', await waitSubmitOk('road', n1));
} else {
  assert('legalLinks 缺 WIGAN-BLACKBURN（前置异常）', false, await st(() => JSON.stringify(window.__app?.state?.legalLinks || [])));
}

// ================ ⑤ 发展铁厂 ×3（每次耗市场 1 铁 → 腾出 3 个铁市场空槽） ================
const developIron = async (times) => {
  await myTurn();
  await clickTop('发展');
  assert('发展弹窗出现产业选项', await waitFor(() => !!document.querySelector('#actionstrip .as-opt'), 4000, '发展选项'));
  for (let k = 0; k < times; k++) {
    const ok = await clickUntil(async () => {
      const pt = await page.evaluate(() => {
        const el = [...document.querySelectorAll('#actionstrip .as-opt')]
          .find((o) => o.textContent.includes('铁厂'));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (pt) await page.mouse.click(pt.x, pt.y);
    }, '#actionstrip .as-opt.sel', 3, 300);
    if (!ok) return false;
  }
  await clickModal('下一步');
  assert('发展进入选牌', await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '发展选牌'));
  await pickCardAndNext();
  assert('发展出现「确认发展」', await waitFor(() => /确认发展/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认发展'));
  const nk = await subsLen();
  await confirmExec();
  return waitSubmitOk('develop', nk);
};
assert('发展铁厂 ×2 成功（丢 L1、L2）', await developIron(2));
assert('发展铁厂 ×1 成功（丢 L3，铁厂升至 L4 可建）', await developIron(1));

// ================ ⑥ 双牌建造 L4 铁厂 @ BLACKBURN 槽2（产 6 铁；市场仅 3 空槽） ================
await myTurn();
const moneyBeforeIron = (await snap())?.money;
const incomeBefore = (await snap())?.income;
await startDoubleBuild();
const bbPt = await slotPt('BLACKBURN', 2);
const ironSlot = await clickUntil(() => page.mouse.click(bbPt.x, bbPt.y), '#handcards .cards.selecting', 3, 350);
assert('真实点击 BLACKBURN 槽2 建 L4 铁厂进入选牌', ironSlot);
await pickNCardsAndNext(2);
assert('铁厂出现「确认建造」', await waitFor(() => /确认建造/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认铁厂'));
const n2 = await subsLen();
await confirmExec();
assert('L4 铁厂建造被引擎接受', await waitSubmitOk('doubleBuild', n2));

// ================ ⑦ 补市场弹窗（真实服务端响应） ================
const modalShown = await waitFor(() => /补充铁到市场/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 8000, '补市场弹窗');
assert('建造后弹出「补充铁到市场？」（真实服务端 needSupplement）', modalShown);
const m = await st(() => ({
  title: document.querySelector('#actionstrip .as-title')?.textContent || '',
  body: document.querySelector('#actionstrip .as-body')?.textContent || '',
  btns: [...document.querySelectorAll('#actionstrip .as-btn')].map((b) => b.textContent.trim()),
}));
console.log('  [dbg] 补市场弹窗:', JSON.stringify(m));
assert('正文：产出 6 单位铁 + 补入 3 单位 + 得 £4',
  m.body.includes('产出 6 单位铁') && m.body.includes('补入市场：3 单位') && m.body.includes('£4'), m.body);
assert('正文：部分补充不翻面说明（剩 3 单位留在板块上）', m.body.includes('剩 3 单位留在板块上'), m.body);
assert('按钮：补入市场 +£4 / 留在板块上',
  m.btns.some((b) => b.includes('补入市场') && b.includes('£4')) && m.btns.includes('留在板块上'),
  JSON.stringify(m.btns));
const displayedGain = (m.btns.find((b) => b.includes('补入市场')) || '').match(/£(\d+)/)?.[1];

// ================ ⑧ 真实点击「补入市场」→ 服务端落地验证 ================
const moneyPending = (await snap())?.money;
const n3 = await subsLen();
await clickModal('补入市场');
assert('「补入市场」提交被引擎接受', await waitSubmitOk('supplement_market', n3));
await page.waitForTimeout(400);
const after = await st(() => {
  const s = window.__app?.state; if (!s) return null;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  const iron = (me?.industryTiles || []).find((t) => t.buildingId === 'building_001' && t.location === 'BLACKBURN');
  return { money: me?.money, income: me?.incomePos, market: s.ironMarket, iron };
});
assert('补入后金钱 = 建造后 + 弹窗所示金额（' + (displayedGain || '?') + '）',
  (after?.money ?? -1) === (moneyPending ?? -2) + Number(displayedGain || -1),
  `pending=${moneyPending} + ${displayedGain} = ${(moneyPending ?? 0) + Number(displayedGain || 0)} → after=${after?.money}`);
assert('补入后铁市场回填至满（2/2/2/2）',
  after?.market && after.market.price1 === 2 && after.market.price2 === 2
  && after.market.price3 === 2 && after.market.price4 === 2, JSON.stringify(after?.market));
assert('板块剩 3 铁、未翻面（部分补充不翻面）',
  after?.iron && after.iron.boardResources === 3 && after.iron.flipped === false, JSON.stringify(after?.iron));
assert('收入轨不动（未翻面无奖励）', (after?.income ?? -1) === (incomeBefore ?? -2), `before=${incomeBefore} after=${after?.income}`);
assert('弹窗已关闭', !(await st(() => {
  const r = document.querySelector('#actionstrip');
  return r && window.getComputedStyle(r).display !== 'none';
})));

// ================ Part2 · UI 接线：留在板块上 → supply=false ================
await st(() => {
  window.__sup = [];
  const orig = window.__app.session.submit.bind(window.__app.session);
  window.__app.session.submit = async (a) => {
    if (a.type === 'build' || a.type === 'doubleBuild') {
      return { ok: true, message: '建造成功，请选择是否把产出补入市场',
               detail: { needSupplement: { resource: 'iron', qty: 4, put: 4, gain: 8, willFlip: true } } };
    }
    if (a.type === 'supplement_market') {
      window.__sup.push({ ...a });
      return { ok: true, message: a.supply ? '已补入市场' : '产出留在板块上', detail: {} };
    }
    return orig(a);
  };
});
await st(() => window.__app.submit({ type: 'build', location: 'WIGAN', slotIndex: 0, industry: '铁厂' }, '建造'));
assert('伪造建造响应 → 补市场弹窗弹出', await waitFor(() => /补充铁到市场/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 5000, 'part2 弹窗'));
const m2 = await st(() => ({
  btns: [...document.querySelectorAll('#actionstrip .as-btn')].map((b) => b.textContent.trim()),
  cancel: [...document.querySelectorAll('#actionstrip .as-btn')].some((b) => b.textContent.trim() === '取消'),
}));
assert('弹窗强制选择（无可取消按钮）', m2.btns.includes('补入市场 +£8') && m2.btns.includes('留在板块上') && !m2.cancel,
  JSON.stringify(m2));
await clickModal('留在板块上');
assert('点击「留在板块上」提交 supply=false', await waitFor(() => window.__sup.length === 1, 4000, 'keep payload'));
const keepPay = await st(() => window.__sup[0] || null);
assert('payload = {type:supplement_market, supply:false}',
  !!keepPay && keepPay.type === 'supplement_market' && keepPay.supply === false, JSON.stringify(keepPay));
assert('留板后弹窗关闭', await waitFor(() => {
  const r = document.querySelector('#actionstrip');
  return !r || window.getComputedStyle(r).display === 'none';
}, 4000, 'part2 弹窗关闭'));

// ================ Part3 · 失败恢复：提交被拒但服务端仍有 pending → 弹窗自动回来 ================
await st(() => {
  window.__app.session.stopPolling();   // 防止注入的 pending 被轮询覆盖
  window.__app.session.state = Object.assign({}, window.__app.session.state, {
    isMyTurn: true,
    pendingSupplement: { resource: 'coal', playerId: window.__app.session.myPlayerId,
                         tileId: 't_x', qty: 2, put: 2, gain: 8, willFlip: true },
  });
  const orig = window.__app.session.submit.bind(window.__app.session);
  window.__app.session.submit = async (a) => {
    if (a.type === 'road') return { ok: false, message: '测试用失败', fail_code: 'TEST' };
    return orig(a);
  };
});
await st(() => window.__app.submit({ type: 'road', cardId: 'x' }, '修路'));
assert('提交失败后若服务端仍挂 pending → 弹窗自动恢复',
  await waitFor(() => /补充煤到市场/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 5000, '失败恢复弹窗'));

// ================ 汇总 ================
console.log('\nSUMMARY  CHECKS: ' + checks.length + '  FAIL: ' + checks.filter((c) => !c.ok).length);
if (errors.length) console.log('  [pageerror]', errors.slice(0, 3).join(' | '));
await browser.close();
if (checks.some((c) => !c.ok)) process.exit(1);
console.log('全部通过 ✅');
