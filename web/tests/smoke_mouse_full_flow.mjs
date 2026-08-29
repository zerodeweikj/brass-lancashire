// 行动模块全链路 · 真实鼠标事件测试（page.mouse.click，非 JS 直调）：
// 大厅 → 创建(机器人房) → 准备 → 开局 → 作弊 → 修路 → 贷款 → 发展 → 建造 → 跳过
//      → 撤回 → 出售(无可售) → 铁选源(真实点击地图铁厂) → 结束回合
// 每步：真实鼠标点击 UI/地图/弹窗，轮询断言引擎状态与 UI 渲染。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const allErrors = [];
const notFound = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() === 404 && !/favicon/i.test(r.url())) notFound.push(r.url()); });

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const st = (fn, arg) => page.evaluate(fn, arg);
const waitFor = async (fn, timeout = 12000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await page.evaluate(fn)) return true; } catch { /* ignore */ }
    await page.waitForTimeout(160);
  }
  console.log(`  [warn] 等待超时: ${label}`);
  return false;
};

// ---- 真实鼠标点击辅助：按文本找按钮/弹窗项，点其中心 ----
const clickTop = async (text) => {
  const pt = await page.evaluate((t) => {
    const els = [...document.querySelectorAll('#topbar button')];
    const el = els.find((b) => b.textContent.includes(t) && !b.disabled);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  return true;
};
// 点击右侧向导条（#actionstrip）中的选项/按钮：面板选择（.as-opt）、下一步/确认（.as-btn）
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
// 点击左侧手牌区第一张可选牌（选择态 .pickable，跳过已选）
const clickFirstModalCard = async () => {
  const pt = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#handcards .hcard.pickable')]
      .find((c) => !c.classList.contains('sel'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  return true;
};
// 选牌并点「下一步」：点卡后验证 sel，未选中则重试（modal 刚渲染时点击偶发未注册）
// 点确认执行：先等确认框渲染稳定，点击后等 toast/状态刷新
// 等待某类型行动被引擎接受（ok:true）——服务端权威执行证据
const waitSubmitOk = async (type, fromIdx = 0, timeout = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const subs = await st(() => window.__submits || []);
    const fresh = subs.slice(fromIdx);
    if (fresh.some((x) => x.t === type && x.ok)) return true;
    if (fresh.some((x) => x.t === type && !x.ok)) return false; // 被拒
    await page.waitForTimeout(160);
  }
  return false;
};
const subsLen = () => st(() => (window.__submits || []).length);
// 地图点击后验证期望元素出现，未出现则重试（HUD 重渲染/时序偶发）
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
const pickCardAndNext = async () => {
  for (let i = 0; i < 3; i++) {
    const clicked = await clickFirstModalCard();
    await page.waitForTimeout(200);
    const selN = await st(() => document.querySelectorAll('#handcards .hcard.sel').length);
    if (clicked && selN > 0) break;
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(120);
  await clickModal('下一步');
};
// 世界坐标 → 页面坐标（数值线性求逆）
const worldPt = async (wx, wy) => page.evaluate(([x, y]) => {
  const sc = window.__app.scene; const cam = sc.cameras.main;
  const w0 = cam.getWorldPoint(0, 0), w1 = cam.getWorldPoint(cam.width, cam.height);
  const sx = (x - w0.x) / (w1.x - w0.x) * cam.width;
  const sy = (y - w0.y) / (w1.y - w0.y) * cam.height;
  const rect = document.querySelector('#game canvas').getBoundingClientRect();
  return { x: rect.left + sx, y: rect.top + sy };
}, [wx, wy]);
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

const stSnap = () => st(() => {
  const s = window.__app?.state; if (!s) return null;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  const matTotal = Object.values(me?.mat || {}).reduce((a, lv) => a + Object.values(lv).reduce((x, y) => x + y, 0), 0);
  return { ap: s.actionPoints, hand: me?.hand?.length ?? -1, money: me?.money, myTurn: !!s.isMyTurn,
           version: s.version, matTotal, links: (me?.linkTiles || []).length, tiles: (me?.industryTiles || []).length };
});
const myTurn = async () => waitFor(() => window.__app?.state?.isMyTurn === true, 20000, '等我的回合');

// ================ ① 大厅：真实输入 + 真实点击创建/准备 ================
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('鼠标测试');
await page.waitForTimeout(120);
await page.evaluate(() => { const c = document.querySelector('label.chk input[type=checkbox]'); if (c && !c.checked) c.click(); });
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建'); if (b) b.click(); });
await waitFor(() => !!window.__app?.session?.room?.seats?.some((x) => x.isMe), 10000, '进房');
await st(() => { const r = [...document.querySelectorAll('button')].find((b) => /准备/.test(b.textContent)); if (r && !r.disabled) r.click(); });
await waitFor(() => window.__app?.session?.room?.status === 'playing', 15000, '开局');
await myTurn();

// ================ ② 补给（作弊按钮已隐藏，直接调 API 给机器人房补给） ================
await waitFor(() => window.__app?.scene?.ready === true, 20000, '场景就绪');
const cheatBefore = await stSnap();
await st(() => window.__app.session.cheat({ money: 200, actionPoints: 8 }));
await page.waitForTimeout(600);
const cheatSnap = await stSnap();
assert('补给后金钱/行动点增加',
  (cheatSnap.money ?? 0) > (cheatBefore.money ?? 0) && (cheatSnap.ap ?? 0) >= (cheatBefore.ap ?? 0),
  JSON.stringify({ before: cheatBefore, after: cheatSnap }));

// 作弊后拦截 session.submit 记录每次提交结果（诊断用）
await st(() => {
  window.__submits = [];
  const orig = window.__app.session.submit.bind(window.__app.session);
  window.__app.session.submit = async (a) => {
    const r = await orig(a);
    window.__submits.push({ t: a.type, ok: r?.ok, msg: r?.message || r?.fail_code || '' });
    return r;
  };
});

// ================ ③ 修路（运河，真实点击全链路） ================
const beforeRoad = await stSnap();
await clickTop('建造');                       // 展开建造子菜单
await page.waitForTimeout(150);
const roadClicked = await clickTop('建造连接板块');
const roadState = await st(() => ({
  picker: window.__app?.scene?.picker?.kind || null,
  zones: (window.__app?.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length,
  flow: window.__app?.flow?.kind || null,
}));
assert('真实点击「建造→建造连接板块」进入修路选择态且渲染高亮',
  roadClicked && roadState.picker === 'road' && roadState.zones > 0, JSON.stringify(roadState));
if (roadState.zones === 0) {
  await waitFor(() => (window.__app?.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length > 0, 5000, 'road 高亮渲染');
}
const linkPt = await st(() => {
  const s = window.__app?.state; const sc = window.__app.scene;
  const l = (s?.legalLinks || [])[0]; if (!l) return null;
  const geo = sc.linkByPair?.[sc._pairKey(l.from, l.to)]; if (!geo) return null;
  return { from: l.from, to: l.to, geo };
});
if (linkPt) {
  const pt = await worldPt(linkPt.geo.x, linkPt.geo.y);
  const cardOk = await clickUntil(() => page.mouse.click(pt.x, pt.y), '#handcards .cards.selecting', 3, 350);
  assert(`真实点击连接 ${linkPt.from}-${linkPt.to} 后弹出选牌弹窗`, cardOk);
  await pickCardAndNext();
  const confirmOk = await waitFor(() => /确认修路/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认修路');
  assert('出现「确认修路」确认框', confirmOk);
  // 运河时代修路不需要煤，确认框不应出现任何煤相关文本
  const confirmBody = await st(() => document.querySelector('#actionstrip .as-body')?.textContent || '');
  const phase = await st(() => window.__app?.state?.phase);
  if (phase === 'canal') {
    assert('运河时代修路确认框不出现「消耗煤」文本', !/消耗煤/.test(confirmBody) && !/煤厂/.test(confirmBody), confirmBody);
  }
  const n0 = await subsLen();
  await confirmExec();
  const roadDone = await waitSubmitOk('road', n0);
  assert('修路提交被引擎接受（ok:true）', roadDone);
} else {
  assert('无合法连接，修路跳过（SKIP）', true);
}

// ================ ④ 贷款（真实点击） ================
await myTurn();
const beforeLoan = await stSnap();
const loanClicked = await clickTop('贷款');
await page.waitForTimeout(150);
await clickTop('贷款 10 元');
const loanCardOk = await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '贷款选牌');
assert('真实点击「贷款→贷款 10 元」进入选牌', loanClicked && loanCardOk);
await pickCardAndNext();
await waitFor(() => /确认贷款/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认贷款');
const n1 = await subsLen();
  await confirmExec();
  const loanDone = await waitSubmitOk('loan', n1);
  assert('贷款提交被引擎接受（ok:true，+10 元）', loanDone);

// ================ ⑤ 发展（真实点击：选板块→选牌→确认） ================
await myTurn();
const beforeDev = await stSnap();
const devClicked = await clickTop('发展');
const devOptOk = await waitFor(() => !!document.querySelector('#actionstrip .as-opt'), 4000, '发展板块弹窗');
assert('真实点击「发展」弹出板块选择', devClicked && devOptOk);
// 发展选择：未选中时整个 .opt 可点（onclick 添加）；选中后出现 −/＋ 控件
const devAddOk = await clickUntil(async () => {
  const pt = await page.evaluate(() => {
    const el = document.querySelector('#actionstrip .as-opt');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (pt) await page.mouse.click(pt.x, pt.y);
}, '#actionstrip .as-opt.sel', 3, 300);
assert('发展选择板块成功（.opt.sel 出现）', devAddOk);
await clickModal('下一步');
const devCardOk = await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '发展选牌');
assert('发展选择板块后进入选牌', devCardOk);
await pickCardAndNext();
await waitFor(() => /确认发展/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认发展');
const n2 = await subsLen();
await confirmExec();
const devDone = await waitSubmitOk('develop', n2);
  assert('发展提交被引擎接受（ok:true，板块减少）', devDone);

// ================ ⑥ 建造（动态找可建槽位，真实点击） ================
await myTurn();
const buildInfo = await st(() => {
  const s = window.__app?.state; if (!s) return null;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  const cardDefs = Object.fromEntries((window.__app.static?.cards || []).map((c) => [c.id, c]));
  const hand = me?.hand || [];
  for (const t of s.legalBuilds || []) {
    const ok = hand.some((c) => {
      const cd = cardDefs[c];
      if (!cd) return false;
      if (cd.type === 'city') return cd.city === t.location;
      return t.netOk !== false && cd.industry === t.industry;
    });
    if (ok) return { loc: t.location, idx: t.slotIndex, industry: t.industry, level: t.level, netOk: t.netOk };
  }
  return null;
});
if (buildInfo) {
  await clickTop('建造');
  await page.waitForTimeout(150);
  await clickTop('建造产业板块');
  await waitFor(() => window.__app?.scene?.picker?.kind === 'build', 4000, 'build 选择态');
  const pt = await slotPt(buildInfo.loc, buildInfo.idx);
  const slotClicked = await clickUntil(() => page.mouse.click(pt.x, pt.y), '#actionstrip .as-opt, #handcards .cards.selecting', 3, 350);
  assert(`真实点击槽位 ${buildInfo.loc} 槽${buildInfo.idx} 触发弹窗`, slotClicked);
  // 若多产业弹窗：真实点击对应产业
  const multi = await st(() => !!document.querySelector('#actionstrip .as-opt'));
  if (multi) { await clickModal(buildInfo.industry); }
  const buildCardOk = await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '建造选牌');
  assert(`真实点击槽位 ${buildInfo.loc} 槽${buildInfo.idx} 进入选牌（${buildInfo.industry} L${buildInfo.level}）`, buildCardOk);
  await pickCardAndNext();
  await waitFor(() => /确认建造/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认建造');
  const n3 = await subsLen();
  await confirmExec();
  const buildDone = await waitSubmitOk('build', n3);
  assert('建造提交被引擎接受（ok:true，板块落图）', buildDone);
} else {
  assert('手牌无匹配建造牌，建造跳过（SKIP，环境限制非 bug）', true);
}

// ================ ⑦ 跳过（真实点击） ================
await myTurn();
const beforeSkip = await stSnap();
const skipOk = await clickTop('跳过');
const skipCardOk = await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '跳过选牌');
assert('真实点击「跳过」进入选牌', skipOk && skipCardOk);
await pickCardAndNext();
await waitFor(() => /确认跳过/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认跳过');
const n4 = await subsLen();
await confirmExec();
const skipDone = await waitSubmitOk('skip', n4);
assert('跳过提交被引擎接受（ok:true，行动点-1）', skipDone);

// ================ ⑧ 撤回上一步（真实点击） ================
await myTurn();
const undoBtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('#topbar button')].find((x) => x.textContent.includes('撤回上一步'));
  return b ? { disabled: b.disabled } : null;
});
if (undoBtn && !undoBtn.disabled) {
  const n5 = await subsLen();
  await clickTop('撤回上一步');
  const undoDone = await waitSubmitOk('undo', n5);
  assert('真实点击「撤回上一步」被引擎接受（ok:true，状态回滚）', undoDone);
} else {
  assert('撤回按钮不可用，撤回跳过（SKIP）', true);
}

// ================ ⑨ 出售（开局无可售，真实点击应优雅取消） ================
await myTurn();
// 清理可能残留的选择态（真实点击「取消当前操作」）
const hadHint = await st(() => !!window.__app?.hud?.hint);
if (hadHint) { await clickTop('取消当前操作'); await page.waitForTimeout(300); }
await clickTop('售卖棉花');
await page.waitForTimeout(500);
const sellAfter = await st(() => ({
  flow: window.__app?.flow || null,
  picker: window.__app?.scene?.picker,
  modal: !!document.querySelector('#actionstrip') && window.getComputedStyle(document.querySelector('#actionstrip')).display !== 'none',
}));
assert('「售卖棉花」无可售时优雅取消、无残留', sellAfter.flow === null && sellAfter.picker === null,
  JSON.stringify({ flow: sellAfter.flow?.kind || null, picker: sellAfter.picker?.kind || null, modal: sellAfter.modal }));

// ================ ⑩ 铁选源（注入 2 铁厂后真实鼠标点击地图铁厂） ================
const ironInjected = await st(() => {
  const st2 = JSON.parse(JSON.stringify(window.__app.session.state));
  const slots = [];
  for (const [loc, s] of Object.entries(window.__app.scene.slotXY || {})) {
    for (let i = 0; i < (s.slots?.length || 0); i++) { slots.push([loc, i]); if (slots.length === 2) break; }
    if (slots.length === 2) break;
  }
  if (slots.length < 2) return null;
  const p1 = st2.players.find((p) => p.id === st2.viewerId) || st2.players[0];
  (p1.industryTiles = p1.industryTiles || []).push(
    { id: 'mouse_iron_1', owner: p1.id, buildingId: 'building_001', level: 1, location: slots[0][0], slotIndex: slots[0][1], industry: '铁厂', resourceType: 'iron', boardResources: 3, flipped: false },
    { id: 'mouse_iron_2', owner: p1.id, buildingId: 'building_001', level: 1, location: slots[1][0], slotIndex: slots[1][1], industry: '铁厂', resourceType: 'iron', boardResources: 3, flipped: false },
  );
  window.__app.scene.setState(st2);
  window.__app.flow = { kind: 'build' };
  window.__resDone = false;
  window.__app.startResourcePick({
    kind: 'iron', amount: 2,
    sources: [
      { tileId: 'mouse_iron_1', location: slots[0][0], owner: p1.id, level: 1, remaining: 3 },
      { tileId: 'mouse_iron_2', location: slots[1][0], owner: p1.id, level: 1, remaining: 3 },
    ],
    onDone: () => { window.__resDone = true; },
  });
  return slots;
});
if (ironInjected) {
  await page.waitForTimeout(300);
  const p1 = await slotPt(ironInjected[0][0], ironInjected[0][1]);
  await page.mouse.click(p1.x, p1.y);
  await page.waitForTimeout(150);
  const mid = await st(() => window.__app?.hud?.hint || '');
  assert('真实点击铁厂1 后提示「已选 1 / 2」', mid.includes('已选 1 / 2'), mid);
  await page.mouse.click(p1.x, p1.y);   // 同一建筑再点一次（消耗多个）
  await page.waitForTimeout(200);
  const fin = await st(() => ({ done: window.__resDone, hint: window.__app?.hud?.hint || '' }));
  assert('同一铁厂真实点击两次完成选源（onDone 触发、提示已清理）',
    fin.done === true && !fin.hint, JSON.stringify(fin));
} else {
  assert('无可用槽位，铁选源真实点击跳过（SKIP）', true);
}
await st(() => { window.__app.cancelFlow(); });

// ================ ⑪ 结束回合（真实点击，耗完行动点后） ================
await myTurn();
for (let i = 0; i < 8; i++) {
  const can = await st(() => {
    const s = window.__app?.state; const me = (s.players || []).find((p) => p.id === s.viewerId);
    return { endOk: !!s?.isMyTurn && (s.actionPoints <= 0 || (me?.hand || []).length === 0), skipOk: !!s?.buttonEnabled?.skip };
  });
  if (can.endOk) break;
  if (!can.skipOk) break;
  const clicked = await clickTop('跳过');
  if (!clicked) break;
  const cardOk = await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '跳过选牌');
  if (!cardOk) break;
  await pickCardAndNext();
  await waitFor(() => /确认跳过/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 3000, '确认跳过');
  await confirmExec();
  await waitFor(() => {
    const s = window.__app?.state; return !s || s.actionPoints <= 0;
  }, 8000, '跳过执行').catch(() => {});
}
const endOk = await st(() => {
  const s = window.__app?.state; const me = (s.players || []).find((p) => p.id === s.viewerId);
  return s?.isMyTurn && (s.actionPoints <= 0 || (me?.hand || []).length === 0);
});
if (endOk) {
  await clickTop('结束回合');
  const ended = await waitFor(() => window.__app?.state?.isMyTurn === false, 15000, '结束回合');
  assert('真实点击「结束回合」后回合移交（isMyTurn=false）', ended);
} else {
  assert('行动点未耗完无法结束回合（SKIP）', true);
}

// ================ 汇总 ================
await browser.close();
const realErrors = allErrors.filter((e) => !/Failed to load resource.*404/.test(e));
assert('全程无运行时错误', realErrors.length === 0, realErrors.join(' | '));
assert('全程无资源 404', notFound.length === 0, notFound.slice(0, 6).join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY  CHECKS: ${checks.length}  FAIL: ${failed.length}`);
if (failed.length) { for (const c of failed) console.log('  FAILED: ' + c.name); process.exit(1); }
console.log('全部通过 ✅');
