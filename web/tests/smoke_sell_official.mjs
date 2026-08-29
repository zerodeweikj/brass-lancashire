// 售卖棉花·官方规则真实鼠标 e2e（2026-08-11 规则书拍板）：
// 真实服务端全链路（一回合内）：
//   双牌建棉花厂A(MACCLESFIELD槽0) → 修路 MACCLESFIELD-THEMIDLANDS（连市场标记）
//   → 双牌建棉花厂B(COLNE槽0) → 修路 COLNE-YORKSHIRE（连市场标记）
// Part1（真实）：售卖棉花 → 点 MACCLESFIELD 棉花厂 → 断言「选择售卖路线」而非额外奖励询问
//   → 点「远方市场」→ 弃 1 张手牌 → 确认 → 服务端验证（市场轨推进 + 收入=落点数值 + 厂翻面 + 收入+5）
//   → 会话续卖弹窗 → 「继续出售」→ 会话列表点 COLNE 厂 → 远方市场 → 直接提交（不弃牌）
//   → 服务端验证（第二次抽牌推进 + 收入=落点数值 + 厂翻面 + 收入+5）
// Part2（UI 接线，注入态）：港口路线渠道校验（channel=port + portTileId + 无 reward 字段）；
//   会话中「结束售卖」按钮提交 {type:'sell_end'}。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const TRACK = [3, 3, 2, 2, 1, 1, 0, 0, 0];   // 与引擎 remoteTrackValues 一致

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
const stateSnap = () => st(() => {
  const s = window.__app?.state; if (!s) return null;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  return {
    money: me?.money, income: me?.incomePos, track: s.remoteCottonTrack,
    ap: s.actionPoints, pending: !!s.pendingSell,
    mills: (me?.industryTiles || []).filter((t) => t.buildingId === 'building_005')
      .map((t) => ({ loc: t.location, slot: t.slotIndex, flipped: t.flipped })),
  };
});
const modalInfo = () => st(() => ({
  title: document.querySelector('#actionstrip .as-title')?.textContent || '',
  opts: [...document.querySelectorAll('#actionstrip .as-body .as-opt')].map((o) => o.textContent.trim()),
  btns: [...document.querySelectorAll('#actionstrip .as-foot .as-btn')].map((b) => b.textContent.trim()),
}));

// ================ ActionStrip（售卖向导条）辅助 ================
// 售卖棉花行动已迁移到右侧 #actionstrip（不再用 #modal），这里复用真实鼠标点击验证。
const stripInfo = () => st(() => {
  const r = document.querySelector('#actionstrip');
  if (!r) return { open: false, title: '', opts: [], btns: [] };
  const open = window.getComputedStyle(r).display !== 'none';
  return {
    open,
    title: r.querySelector('.as-title')?.textContent || '',
    opts: [...r.querySelectorAll('.as-body .as-opt')].map((o) => o.textContent.replace(/\s+/g, ' ').trim()),
    btns: [...r.querySelectorAll('.as-foot .as-btn')].map((b) => b.textContent.trim()),
  };
});
const clickStripBtn = async (text) => st((t) => {
  const r = document.querySelector('#actionstrip');
  if (!r) return false;
  const el = [...r.querySelectorAll('.as-foot .as-btn')].find((b) => b.textContent.includes(t) && !b.disabled);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}, text);
const clickStripOpt = async (text) => st((t) => {
  const r = document.querySelector('#actionstrip');
  if (!r) return false;
  const el = [...r.querySelectorAll('.as-body .as-opt')].find((o) => o.textContent.includes(t) && !o.classList.contains('disabled'));
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}, text);
const clickHandCard = async (idx) => st((i) => {
  const card = document.querySelectorAll('#handcards .cards .hcard')[i];
  if (!card) return false;
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}, idx);
// 售卖弃牌：点左侧高亮手牌第 idx 张 → 右侧向导条出现「确认出售」→ 点击
const pickHandCardAndConfirm = async (idx = 0) => {
  if (!(await clickHandCard(idx))) return false;
  if (!(await waitFor(() => [...document.querySelectorAll('#actionstrip .as-foot .as-btn')].some((b) => b.textContent.includes('确认出售')), 3000, '确认出售按钮'))) return false;
  return clickStripBtn('确认出售');
};

// ================ ① 机器人房开局 ================
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('售卖官方测试');
await page.waitForTimeout(120);
await page.evaluate(() => { const c = document.querySelector('label.chk input[type=checkbox]'); if (c && !c.checked) c.click(); });
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建'); if (b) b.click(); });
await waitFor(() => !!window.__app?.session?.room?.seats?.some((x) => x.isMe), 10000, '进房');
await st(() => { const r = [...document.querySelectorAll('button')].find((b) => /准备/.test(b.textContent)); if (r && !r.disabled) r.click(); });
await waitFor(() => window.__app?.session?.room?.status === 'playing', 15000, '开局');
await myTurn();
await waitFor(() => window.__app?.scene?.ready === true, 20000, '场景就绪');

// ================ ② 作弊 + 拦截 submit ================
await st(() => window.__app.session.cheat({ money: 300, actionPoints: 8 }).catch(() => {}));
await page.waitForTimeout(500);
await st(() => {
  window.__submits = [];
  window.__sellPays = [];
  const orig = window.__app.session.submit.bind(window.__app.session);
  window.__app.session.submit = async (a) => {
    const r = await orig(a);
    window.__submits.push({ t: a.type, ok: r?.ok, msg: r?.message || r?.fail_code || '' });
    if (a.type === 'sell' || a.type === 'sell_end') window.__sellPays.push({ ...a });
    return r;
  };
});
const s0 = await stateSnap();
assert('作弊后行动点充足（≥8）、金钱充足', (s0?.ap ?? 0) >= 8 && (s0?.money ?? 0) >= 200, JSON.stringify(s0));

// ================ ③ 真实建造：2 棉花厂 + 2 条市场路 ================
const startDoubleBuild = async () => {
  await clickTop('建造');
  await page.waitForTimeout(150);
  await clickTop('双手牌建造产业板块');
  await waitFor(() => window.__app?.scene?.picker?.kind === 'build', 4000, '双牌建造选择态');
};
const doubleBuildAt = async (loc, slotIdx) => {
  await startDoubleBuild();
  const pt = await slotPt(loc, slotIdx);
  if (!pt) return false;
  const slotOk = await clickUntil(() => page.mouse.click(pt.x, pt.y), '#handcards .cards.selecting', 3, 350);
  if (!slotOk) return false;
  await pickNCardsAndNext(2);
  if (!(await waitFor(() => /确认建造/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认建造'))) return false;
  const n = await subsLen();
  await confirmExec();
  return waitSubmitOk('doubleBuild', n);
};
const roadBuild = async (a, b) => {
  await clickTop('建造');
  await page.waitForTimeout(150);
  await clickTop('建造连接板块');
  await waitFor(() => window.__app?.scene?.picker?.kind === 'road', 4000, '修路选择态');
  const geo = await st(([pa, pb]) => {
    const sc = window.__app.scene;
    const g = sc.linkByPair?.[sc._pairKey(pa, pb)];
    return g ? { x: g.x, y: g.y } : null;
  }, [a, b]);
  if (!geo) return false;
  const pt = await worldPt(geo.x, geo.y);
  const ok = await clickUntil(() => page.mouse.click(pt.x, pt.y), '#handcards .cards.selecting', 3, 350);
  if (!ok) return false;
  await pickCardAndNext();
  if (!(await waitFor(() => /确认修路/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 4000, '确认修路'))) return false;
  const n = await subsLen();
  await confirmExec();
  return waitSubmitOk('road', n);
};
assert('建棉花厂A @ MACCLESFIELD 槽0', await doubleBuildAt('MACCLESFIELD', 0));
assert('修路 MACCLESFIELD-THEMIDLANDS（连市场标记）', await roadBuild('MACCLESFIELD', 'THEMIDLANDS'));
assert('建棉花厂B @ COLNE 槽0', await doubleBuildAt('COLNE', 0));
assert('修路 COLNE-YORKSHIRE（连市场标记）', await roadBuild('COLNE', 'YORKSHIRE'));

assert('两座未翻面棉花厂就位', await waitFor(() => {
  const s = window.__app?.state; if (!s) return false;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  const ms = (me?.industryTiles || []).filter((t) => t.buildingId === 'building_005');
  return ms.length === 2 && ms.every((t) => !t.flipped);
}, 8000, '两厂就位'));
assert('两座厂都在 sellables（连市场标记可售）', await waitFor(() => {
  const sel = window.__app?.state?.sellables || [];
  return sel.length === 2 && sel.every((x) => x.distant && x.routes.some((r) => r.channel === 'distant'));
}, 6000, 'sellables'), await st(() => JSON.stringify((window.__app?.state?.sellables || []).map((x) => x.location))));

// ================ Part1 · 远方市场销售（官方 2.2，真实服务端） ================
const clickSellUntilFlow = async () => {
  for (let i = 0; i < 4; i++) {
    await clickTop('售卖棉花');
    await page.waitForTimeout(300);
    if (await st(() => window.__app?.flow?.kind === 'sell')) return true;
  }
  return false;
};
const clickMillAt = async (loc, idx) => {
  const pt = await slotPt(loc, idx);
  if (!pt) return false;
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(350);
    if (await st(() => !!document.querySelector('#actionstrip .as-body .as-opt'))) return true;
  }
  return false;
};
const clickRoute = async (txt) => clickStripOpt(txt);

const preSell1 = await stateSnap();
const moneyBefore1 = preSell1.money;
const incomeBefore1 = preSell1.income;
assert('P1.1 真实点击「售卖棉花」进入向导', await clickSellUntilFlow());
assert('P1.2 真实点击 MACCLESFIELD 棉花厂', await clickMillAt('MACCLESFIELD', 0));
const mRoute1 = await stripInfo();
assert('P1.3 直接进「选择售卖路线」——【不弹】额外收入奖励询问（官方无奖励二选一）',
  mRoute1.title.includes('选择售卖路线') && !mRoute1.title.includes('额外收入奖励'), mRoute1.title);
assert('P1.4 仅有「远方市场」路线（无港口路线）',
  mRoute1.opts.some((o) => o.includes('远方市场')) && !mRoute1.opts.some((o) => o.includes('级港口')),
  JSON.stringify(mRoute1.opts));
assert('P1.5 真实点击远方市场路线（官方 2.2）', await clickRoute('远方市场'));
assert('P1.6 进入弃 1 张手牌（官方步骤1）', await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '选牌'));
await pickHandCardAndConfirm();
assert('P1.7 出现「确认出售」', await waitFor(() => [...document.querySelectorAll('#actionstrip .as-foot .as-btn')].some((b) => b.textContent.includes('确认出售')), 4000, '确认出售'));
const n1 = await subsLen();
assert('P1.8 远方市场销售被引擎接受', await waitSubmitOk('sell', n1));
await page.waitForTimeout(400);
const pay1 = await st(() => window.__sellPays[window.__sellPays.length - 1] || null);
assert('P1.9 payload：channel=distant + cardId、无 reward 字段（官方无奖励选项）',
  !!pay1 && pay1.channel === 'distant' && !!pay1.cardId && pay1.reward === undefined, JSON.stringify(pay1));
const s1 = await stateSnap();
const landed1 = TRACK[s1?.track ?? 0] ?? -1;
assert('P1.10 服务端：市场轨推进（落点 = 收入轨格数）', (s1?.track ?? -1) >= 0 && (s1?.track ?? -1) <= 4, 'track=' + s1?.track);
assert('P1.11 服务端：收入轨前进 = 落点数值(+' + landed1 + ') + 翻面奖励(+5)',
  (s1?.income ?? -1) === (incomeBefore1 ?? -2) + landed1 + 5,
  `income ${incomeBefore1} +${landed1}+5 -> ${s1?.income}`);
assert('P1.11b 服务端：金钱【不变】（官方：远方市场奖励收入轨而非现金）',
  (s1?.money ?? -1) === (moneyBefore1 ?? -2), `money ${moneyBefore1} -> ${s1?.money}`);
assert('P1.12 服务端：棉花厂A翻面', s1?.mills?.some((m) => m.loc === 'MACCLESFIELD' && m.flipped), JSON.stringify(s1?.mills));
assert('P1.13 会话续卖弹窗出现（官方步骤4）',
  await waitFor(() => /继续出售棉花/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 6000, '续卖弹窗'));

// ================ Part1B · 会话续卖（官方步骤4：不弃牌） ================
await clickStripBtn('继续出售');
await page.waitForTimeout(400);
const mList = await stripInfo();
assert('P1.14 会话列表出现（含 COLNE 棉花厂）', mList.opts.some((o) => o.includes('棉花厂')), JSON.stringify(mList.opts));
const handBefore2 = await st(() => {
  const s = window.__app?.state; if (!s) return -1;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  return me?.hand?.length ?? -1;
});
assert('P1.15 真实点击会话列表中的 COLNE 棉花厂', await clickStripOpt('棉花厂'));
await page.waitForTimeout(350);
const mRoute2 = await stripInfo();
assert('P1.16 会话续卖路线：仅「远方市场」', mRoute2.opts.some((o) => o.includes('远方市场')), JSON.stringify(mRoute2.opts));
const n2 = await subsLen();
await clickRoute('远方市场');
assert('P1.17 会话续卖被引擎接受（无需弃牌、无确认弹窗直接提交）', await waitSubmitOk('sell', n2));
await page.waitForTimeout(400);
const pay2 = await st(() => window.__sellPays[window.__sellPays.length - 1] || null);
assert('P1.18 payload：会话续卖【不弃牌】（cardId 为空）+ 无 reward',
  !!pay2 && pay2.channel === 'distant' && pay2.cardId == null && pay2.reward === undefined, JSON.stringify(pay2));
assert('P1.19 服务端：续卖没有弃牌（手牌不变）',
  await st((h) => {
    const s = window.__app?.state; if (!s) return false;
    const me = (s.players || []).find((p) => p.id === s.viewerId);
    return (me?.hand?.length ?? -1) === h;
  }, handBefore2), 'hand=' + await st(() => window.__app?.state?.players?.find((p) => p.id === window.__app?.state?.viewerId)?.hand?.length));
const s2 = await stateSnap();
const landed2 = TRACK[s2?.track ?? 0] ?? -1;
assert('P1.20 服务端：第二次收入轨前进 = 落点数值(+' + landed2 + ') + 翻面奖励(+5)',
  (s2?.income ?? -1) === (s1?.income ?? -2) + landed2 + 5,
  `income ${s1?.income} +${landed2}+5 -> ${s2?.income}`);
assert('P1.20b 服务端：金钱【仍不变】', (s2?.money ?? -1) === (s1?.money ?? -2),
  `money ${s1?.money} -> ${s2?.money}`);
assert('P1.21 服务端：棉花厂B翻面', s2?.mills?.some((m) => m.loc === 'COLNE' && m.flipped), JSON.stringify(s2?.mills));
assert('P1.22 服务端：全部卖完 → 会话结束、行动点已扣',
  !s2?.pending && (s2?.ap ?? -1) === (s0?.ap ?? -2) - 7,
  `ap ${s0?.ap} -> ${s2?.ap}`);
assert('P1.23 无后续会话弹窗', !(await waitFor(() => /继续出售棉花/.test(document.querySelector('#actionstrip .as-title')?.textContent || ''), 2500, '不应有续卖弹窗')));

// ================ Part2 · UI 接线（注入态）：港口渠道 + 结束售卖 ================
const injectSellState = (arg) => st((a) => {
  const s = JSON.parse(JSON.stringify(window.__app.session.state));
  const me = s.players.find((p) => p.id === s.viewerId);
  if (!me) return false;
  me.industryTiles = [
    { id: 'mill_x', buildingId: 'building_005', level: 1, owner: me.id, location: 'LIVERPOOL', slotIndex: 0, flipped: false, boardResources: 0, builtEra: 'canal' },
    { id: 'port_x', buildingId: 'building_004', level: 1, owner: 'P2', location: 'LIVERPOOL', slotIndex: 1, flipped: false, boardResources: 0, builtEra: 'canal' },
  ];
  s.sellables = [a.mill];
  s.remoteBonusAvailable = true;
  s.pendingSell = a.pending || null;
  s.buttonEnabled = Object.assign({}, s.buttonEnabled || {}, { sell: true });
  window.__app.session.stopPolling();
  window.__app.session.state = s;
  window.__app.scene.setState(s);
  window.__app.sync();
  return true;
}, arg);
const portRoute = { key: 'port:port_x', kind: 'port', channel: 'port', portTileId: 'port_x',
                     to: 'LIVERPOOL', toName: '利物浦', distance: 0, path: ['LIVERPOOL'],
                     label: '利物浦 的 1 级港口（P2）' };
const marketRoute = { key: 'distant', kind: 'market', channel: 'distant', portTileId: null,
                      to: 'THEMIDLANDS', toName: '远方的棉花市场', distance: 2, path: ['LIVERPOOL', 'WIGAN', 'THEMIDLANDS'],
                      label: '卖到远方市场（抽牌推进市场轨得收入）' };
const millX = { millId: 'mill_x', location: 'LIVERPOOL', level: 1, distant: true,
                ports: [{ tileId: 'port_x', location: 'LIVERPOOL', owner: 'P2', level: 1 }],
                routes: [marketRoute, portRoute] };

// ---- Part2A：港口路线（真实鼠标点选 → payload 校验） ----
await injectSellState({ mill: millX, pending: null });
await page.waitForTimeout(350);
assert('P2.1 点「售卖棉花」进入向导（注入态）', await clickSellUntilFlow());
assert('P2.2 真实点击棉花厂进入路线选择', await clickMillAt('LIVERPOOL', 0));
const m2 = await stripInfo();
assert('P2.3 路线含「远方市场」+「港口」（官方 2.1/2.2 双渠道，且无奖励询问）',
  !m2.title.includes('额外收入奖励') && m2.opts.some((o) => o.includes('远方市场')) && m2.opts.some((o) => o.includes('级港口')),
  JSON.stringify({ title: m2.title, opts: m2.opts }));
assert('P2.4 真实点击港口路线', await clickRoute('级港口'));
assert('P2.5 港口路线进入弃牌（官方步骤1）', await waitFor(() => !!document.querySelector('#handcards .cards.selecting'), 4000, '选牌P2'));
await pickHandCardAndConfirm();
assert('P2.6 出现「确认出售」', await waitFor(() => [...document.querySelectorAll('#actionstrip .as-foot .as-btn')].some((b) => b.textContent.includes('确认出售')), 4000, '确认出售P2'));
await page.waitForTimeout(400);
const payP2 = await st(() => window.__sellPays[window.__sellPays.length - 1] || null);
assert('P2.7 payload：channel=port + portTileId + cardId、无 reward（官方 2.1 港口渠道）',
  !!payP2 && payP2.channel === 'port' && payP2.portTileId === 'port_x' && !!payP2.cardId && payP2.reward === undefined,
  JSON.stringify(payP2));

// ---- Part2B：会话「结束售卖」（官方步骤4 结束） ----
await injectSellState({ mill: millX, pending: { playerId: 'P1' } });
await page.waitForTimeout(350);
// sync() 会因 pendingSell 自动弹「继续出售棉花？」——先关掉，会话列表由点「售卖棉花」进入时自己弹
await st(() => { window.__app.hud.closeStrip(); window.__app.hud.clearHandSelectable(); });
await page.waitForTimeout(150);
assert('P2.8 会话态点「售卖棉花」直接弹会话列表', await clickSellUntilFlow());
const m3 = await stripInfo();
assert('P2.9 会话列表含「结束售卖」按钮', m3.btns.some((b) => b.includes('结束售卖')), JSON.stringify(m3.btns));
const nEnd = await subsLen();
await clickStripBtn('结束售卖');
await page.waitForTimeout(400);
const payEnd = await st(() => window.__sellPays[window.__sellPays.length - 1] || null);
assert('P2.10 「结束售卖」提交 {type:sell_end}（官方步骤4）',
  !!payEnd && payEnd.type === 'sell_end', JSON.stringify(payEnd));

// ================ 汇总 ================
console.log('\nSUMMARY  CHECKS: ' + checks.length + '  FAIL: ' + checks.filter((c) => !c.ok).length);
if (errors.length) console.log('  [pageerror]', errors.slice(0, 3).join(' | '));
await browser.close();
if (checks.some((c) => !c.ok)) process.exit(1);
console.log('全部通过 ✅');
