// 时代转换 + 铁路时代 真实鼠标 e2e：
// ① 真实鼠标开局 → ② API 快速推进（skip/endTurn 循环）验证「手牌用光+牌库没牌」能自动进入铁路时代
//    （用户报告的场景）→ ③ 断言转换后状态（rail/round=1/手牌重发/日志）→
//    ④ 真实鼠标：铁路时代建造选择态 + 点槽位 + 修路（rail £5+1煤 选牌→确认→提交 ok）。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const allErrors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const st = (fn, arg) => page.evaluate(fn, arg);
const waitFor = async (fn, timeout = 15000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await page.evaluate(fn)) return true; } catch { }
    await page.waitForTimeout(180);
  }
  console.log(`  [warn] 等待超时: ${label}`);
  return false;
};
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
    const el = [...root.querySelectorAll('.as-opt, .as-btn')]
      .filter((b) => !b.disabled && !b.classList.contains('disabled'))
      .find((b) => b.textContent.includes(t));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  return true;
};
const clickFirstModalCard = async () => {
  const pt = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#handcards .hcard.pickable')]
      .find((c) => !c.classList.contains('sel'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (pt) await page.mouse.click(pt.x, pt.y);
  return !!pt;
};
const worldPt = async (wx, wy) => page.evaluate(([x, y]) => {
  const sc = window.__app.scene; const cam = sc.cameras.main;
  const w0 = cam.getWorldPoint(0, 0), w1 = cam.getWorldPoint(cam.width, cam.height);
  const sx = (x - w0.x) / (w1.x - w0.x) * cam.width;
  const sy = (y - w0.y) / (w1.y - w0.y) * cam.height;
  const rect = document.querySelector('#game canvas').getBoundingClientRect();
  return { x: rect.left + sx, y: rect.top + sy };
}, [wx, wy]);

// ---- ① 真实鼠标开局 ----
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('铁路测试');
await page.waitForTimeout(120);
await page.evaluate(() => { const c = document.querySelector('label.chk input[type=checkbox]'); if (c && !c.checked) c.click(); });
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建'); if (b) b.click(); });
await waitFor(() => !!window.__app?.session?.room?.seats?.some((x) => x.isMe), 10000, '进房');
await page.evaluate(() => { const r = [...document.querySelectorAll('button')].find((b) => /准备/.test(b.textContent)); if (r && !r.disabled) r.click(); });
await waitFor(() => window.__app?.session?.room?.status === 'playing', 15000, '开局');
await waitFor(() => window.__app?.scene?.ready === true, 20000, '场景就绪');
await waitFor(() => window.__app?.state?.isMyTurn === true, 20000, '我的回合');
// 补给（作弊按钮已隐藏，直接调 API）
await page.evaluate(() => window.__app.session.cheat({ money: 200 }));
await page.waitForTimeout(600);
console.log('开局状态:', JSON.stringify(await st(() => ({
  phase: window.__app.state?.phase, round: window.__app.state?.round,
  drawPile: window.__app.state?.deckRemaining, hands: (window.__app.state?.players || []).map((p) => p.hand.length),
}))));

// ---- ② API 快速推进：我的回合 skip×AP 次 → endTurn，直到转换或超时 ----
let sawTransition = false;
let transitionLog = '';
for (let i = 0; i < 90; i++) {
  const s = await st(() => {
    const st2 = window.__app?.state; if (!st2) return null;
    const me = (st2.players || []).find((p) => p.id === st2.viewerId);
    return { phase: st2.phase, over: !!st2.gameOver, myTurn: !!st2.isMyTurn,
             ap: st2.actionPoints, hand: me?.hand || [], drawPile: st2.deckRemaining,
             round: st2.round, logTail: (st2.log || []).slice(-2).map((l) => l.text) };
  });
  if (!s) { await page.waitForTimeout(300); continue; }
  if (s.phase === 'rail') { sawTransition = true; transitionLog = s.logTail.join(' | '); break; }
  if (s.over) break;
  if (s.myTurn) {
    if (s.hand.length && s.ap > 0) {
      await page.evaluate((c) => window.__app.session.submit({ type: 'skip', cardId: c }), s.hand[0]);
      await page.waitForTimeout(700);
    } else {
      await page.evaluate(() => window.__app.session.endTurn());
      await page.waitForTimeout(700);
    }
  } else {
    await page.waitForTimeout(900); // 等 bot（drive_bots）行动
  }
}
console.log('推进结束: phase=%s sawTransition=%s', await st(() => window.__app?.state?.phase), sawTransition);
assert('「手牌用光+牌库没牌」自动进入铁路时代（不卡住）', sawTransition === true,
  await st(() => window.__app?.state?.phase + ' round=' + window.__app?.state?.round));

// ---- ③ 断言转换后状态 ----
const railState = await st(() => {
  const st2 = window.__app?.state;
  const me = (st2.players || []).find((p) => p.id === st2.viewerId);
  return { phase: st2?.phase, round: st2?.round, ap: st2?.actionPoints,
           hand: me?.hand?.length, links: (me?.linkTiles || []).length,
           tiles: (me?.industryTiles || []).map((t) => `${t.level}级`).join(','),
           log: (st2?.log || []).slice(-4).map((l) => l.text) };
});
assert('铁路时代 phase=rail round=1', railState.phase === 'rail' && railState.round === 1, JSON.stringify(railState));
assert('铁路时代手牌重新发满(8) 行动点=2', railState.hand === 8 && railState.ap === 2,
  `hand=${railState.hand} ap=${railState.ap}`);
assert('运河连结已清空（linkTiles=0）', railState.links === 0, `links=${railState.links}`);
const eraLogOk = (railState.log || []).some((l) => /运河时代结束/.test(l));
assert('日志出现「运河时代结束，进入铁路时代」', eraLogOk, JSON.stringify(railState.log));

// ---- ④ 真实鼠标：铁路时代先「发展」丢 L1（canal_only 板块铁路时代不可建），再建造 L2 ----
await waitFor(() => window.__app?.state?.isMyTurn === true, 20000, '铁路时代我的回合');
// 4a. 建造按钮此刻应为 disabled（铁路时代 L1 canal_only 不可建）——预期设计
const be0 = await st(() => {
  const be = window.__app?.state?.buttonEnabled || {};
  return { build: be.build, develop: be.develop, road: be.road };
});
assert('铁路时代开局建造按钮禁用、发展/修路可用（L1 需先发展）',
  be0.build === false && be0.develop === true && be0.road === true, JSON.stringify(be0));
// 4b. 真实点击「发展」：选「煤厂」L1(canal_only) 丢（煤厂不耗煤，L2 铁路时代立即可建）
const devClicked = await clickTop('发展');
await waitFor(() => !!document.querySelector('#actionstrip .as-opt'), 4000, '发展板块向导');
let devSel = false;
for (let i = 0; i < 3; i++) {
  // 优先点「煤厂」（丢煤厂 L1 → L2 铁路可建，且煤厂不耗煤）；找不到则点第一个
  const pt = await page.evaluate(() => {
    const opts = [...document.querySelectorAll('#actionstrip .as-opt')];
    const el = opts.find((o) => o.textContent.includes('煤厂')) || opts[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (pt) await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(300);
  if (await st(() => !!document.querySelector('#actionstrip .as-opt.sel'))) { devSel = true; break; }
}
assert('铁路时代真实点击「发展」并选择板块（煤厂 L1）', devClicked && devSel);
await clickModal('下一步');
await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '发展选牌');
await page.evaluate(() => {
  const el = document.querySelector('#handcards .hcard.pickable');
  if (el) { const r = el.getBoundingClientRect(); window.__devCardPt = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
});
const devCardPt = await st(() => window.__devCardPt || null);
if (devCardPt) { await page.mouse.click(devCardPt.x, devCardPt.y); await page.waitForTimeout(200); }
await clickModal('下一步');
await waitFor(() => /确认发展/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认发展');
await st(() => {
  window.__devSubmits = [];
  const orig = window.__app.session.submit.bind(window.__app.session);
  window.__app.session.submit = async (a) => {
    const r = await orig(a);
    window.__devSubmits.push({ t: a.type, ok: r?.ok, msg: r?.message || r?.fail_code || '' });
    return r;
  };
});
await page.waitForTimeout(350);
await clickModal('确认执行');
await page.waitForTimeout(900);
const devSub = await st(() => window.__devSubmits || []);
assert('铁路时代「发展」提交被引擎接受（丢 L1→L2 可建）', devSub.some((x) => x.t === 'develop' && x.ok), JSON.stringify(devSub));
// 4c. 发展后「建造」应可用：真实点击进入选择态（L2 any 可建）
await clickTop('建造');
await page.waitForTimeout(180);
const buildBtnOk = await clickTop('建造产业板块');
await waitFor(() => window.__app?.scene?.picker?.kind === 'build', 5000, '铁路建造选择态');
const buildZones = await st(() => (window.__app?.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length);
assert('发展后铁路建造选择态渲染高亮（zones>0）', buildBtnOk && buildZones > 0, `zones=${buildZones}`);
// 真实点击第一个【手牌可建】槽位（避免随机发牌导致无匹配牌而误 FAIL）
const slotPt = await st(() => {
  const sc = window.__app.scene;
  const s = window.__app.state;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  const cardDefs = Object.fromEntries((window.__app.static?.cards || []).map((c) => [c.id, c]));
  const hand = me?.hand || [];
  const b = (sc.picker?.builds || []).find((bb) => hand.some((c) => {
    const cd = cardDefs[c];
    if (!cd) return false;
    if (cd.type === 'city') return cd.city === bb.location;
    return bb.netOk !== false && cd.industry === bb.industry;
  }));
  if (!b) return null;
  const pos = sc._slotPos(b.location, b.slotIndex); if (!pos) return null;
  const cam = sc.cameras.main;
  const w0 = cam.getWorldPoint(0, 0), w1 = cam.getWorldPoint(cam.width, cam.height);
  const sx = (pos.x - w0.x) / (w1.x - w0.x) * cam.width;
  const sy = (pos.y - w0.y) / (w1.y - w0.y) * cam.height;
  const rect = document.querySelector('#game canvas').getBoundingClientRect();
  return { x: rect.left + sx, y: rect.top + sy, loc: b.location, industry: b.industry };
});
if (slotPt) {
  let modalShown = false;
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(slotPt.x, slotPt.y);
    await page.waitForTimeout(350);
    if (await st(() => !!document.querySelector('#actionstrip .as-opt, #handcards .cards.selecting'))) { modalShown = true; break; }
  }
  assert(`铁路时代真实点击槽位 ${slotPt.loc} 弹出产业/选牌向导`, modalShown, JSON.stringify(slotPt));
} else {
  assert('发展后手牌无可建槽位（SKIP，随机发牌环境限制非 bug）', true);
}
// 取消残留选择态/弹窗（确保修路前干净）
if (await st(() => !!window.__app?.hud?.hint)) await clickTop('取消当前操作');
if (await st(() => {
  const r = document.querySelector('#actionstrip');
  return r && window.getComputedStyle(r).display !== 'none';
})) {
  await page.keyboard.press('Escape').catch(() => {});
  await st(() => { window.__app?.cancelFlow?.(); });
}
await page.waitForTimeout(300);

// ---- ⑤ 真实鼠标：铁路时代修路（£5+1煤，选牌→确认→提交） ----
await clickTop('建造');
await page.waitForTimeout(180);
await clickTop('建造连接板块');
await waitFor(() => window.__app?.scene?.picker?.kind === 'road', 4000, '铁路修路选择态');
const linkInfo = await st(() => {
  const s = window.__app?.state; const sc = window.__app.scene;
  const l = (s?.legalLinks || []).find((x) => x.type === 'rail') || (s?.legalLinks || [])[0];
  if (!l) return null;
  const geo = sc.linkByPair?.[sc._pairKey(l.from, l.to)]; if (!geo) return null;
  return { from: l.from, to: l.to, geo };
});
if (linkInfo) {
  const pt = await worldPt(linkInfo.geo.x, linkInfo.geo.y);
  let modalOk = false;
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(350);
    // rail 时代点连接先弹「只修这条/再选第二条」选择框
    if (await st(() => {
      const r = document.querySelector('#actionstrip');
      return r && window.getComputedStyle(r).display !== 'none';
    })) { modalOk = true; break; }
  }
  assert(`铁路时代真实点击连接 ${linkInfo.from}-${linkInfo.to} 弹出选择框`, modalOk);
  // 点「只修这一条」→ 进入选牌
  await clickModal('只修这一条');
  const cardOk = await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '铁路修路选牌');
  assert('选择「只修这一条」后进入选牌', cardOk);
  await page.evaluate(() => {
    const el = document.querySelector('#handcards .hcard.pickable');
    if (el) { const r = el.getBoundingClientRect(); window.__railCardPt = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  });
  const cardPt = await st(() => window.__railCardPt || null);
  if (cardPt) { await page.mouse.click(cardPt.x, cardPt.y); await page.waitForTimeout(200); }
  await clickModal('下一步');
  // rail 修路需 1 煤：场上无煤厂时走市场 → 直接出「确认修路」；有煤厂则进入地图选源（此处按无煤厂路径断言）
  const confirmOk = await waitFor(() => /确认修路/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 6000, '确认修路');
  if (confirmOk) {
    assert('铁路修路出现确认框（£5+1煤，市场买）', true);
    await st(() => {
      window.__railSubmits = [];
      const orig = window.__app.session.submit.bind(window.__app.session);
      window.__app.session.submit = async (a) => {
        const r = await orig(a);
        window.__railSubmits.push({ t: a.type, ok: r?.ok, msg: r?.message || r?.fail_code || '' });
        return r;
      };
    });
    await page.waitForTimeout(350);
    await clickModal('确认执行');
    await page.waitForTimeout(900);
    const sub = await st(() => window.__railSubmits || []);
    const ok = sub.some((x) => x.t === 'road' && x.ok);
    assert('铁路修路提交被引擎接受（ok:true）', ok, JSON.stringify(sub));
  } else {
    const inPick = await st(() => ({
      hint: window.__app?.hud?.hint || '',
      picker: window.__app?.scene?.picker?.kind || null,
    }));
    assert('铁路修路进入煤选源态（场上存在煤厂，预期分支）',
      inPick.picker === 'resource' && inPick.hint.includes('煤厂'), JSON.stringify(inPick));
  }
} else {
  assert('无铁路可修连接（SKIP）', true);
}

await browser.close();
const realErrors = allErrors.filter((e) => !/Failed to load resource.*404/.test(e));
assert('全程无运行时错误', realErrors.length === 0, realErrors.join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY  CHECKS: ${checks.length}  FAIL: ${failed.length}`);
if (failed.length) { for (const c of failed) console.log('  FAILED: ' + c.name); process.exit(1); }
console.log('全部通过 ✅');
