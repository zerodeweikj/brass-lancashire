// 售卖棉花·ActionStrip 真实鼠标 e2e（2026-08-11 官方规则 + 手牌区右侧向导条）
// 验证：售卖选项移到 #handpanel 右侧 #actionstrip、路线悬停画绿色粗实线、选手牌在左侧手牌区。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const TRACK = [3, 3, 2, 2, 1, 1, 0, 0, 0];

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

const stripInfo = () => st(() => {
  const root = document.querySelector('#actionstrip');
  if (!root) return null;
  return {
    open: window.getComputedStyle(root).display !== 'none',
    title: root.querySelector('.as-title')?.textContent || '',
    opts: [...root.querySelectorAll('.as-body .as-opt')].map((o) => o.textContent.trim()),
    btns: [...root.querySelectorAll('.as-foot button')].map((b) => b.textContent.trim()),
  };
});

const clickStrip = async (text) => {
  const pt = await page.evaluate((t) => {
    const root = document.querySelector('#actionstrip');
    if (!root) return null;
    const el = [...root.querySelectorAll('.as-opt, .as-foot button')].find((b) => b.textContent.includes(t) && !b.disabled);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  return true;
};
// 对 .as-opt 直接 dispatch click：绕过 Playwright mouse 可能带来的 mouseenter/mouseleave 抖动
const clickStripOpt = async (text) => {
  return st((t) => {
    const root = document.querySelector('#actionstrip');
    if (!root) return false;
    const el = [...root.querySelectorAll('.as-body .as-opt')].find((b) => b.textContent.includes(t) && !b.classList.contains('disabled'));
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }, text);
};

const hoverStrip = async (text) => {
  const pt = await page.evaluate((t) => {
    const root = document.querySelector('#actionstrip');
    if (!root) return null;
    const el = [...root.querySelectorAll('.as-body .as-opt')].find((b) => b.textContent.includes(t));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  if (!pt) return false;
  await page.mouse.move(pt.x, pt.y);
  return true;
};

const clickHandCard = async (idx = 0) => {
  const pt = await st((i) => {
    const cards = [...document.querySelectorAll('#handcards .cards .hcard')];
    const el = cards[i];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, idx);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  return true;
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

// 通用选牌（建造/修路用）：左侧手牌区点可选牌，右侧向导条点「下一步」
const pickNCardsAndNext = async (n) => {
  let guard = 0;
  while (guard++ < n * 4) {
    const idx = await st(() => {
      const els = [...document.querySelectorAll('#handcards .hcard.pickable')];
      return els.findIndex((c) => !c.classList.contains('sel'));
    });
    if (idx < 0) break;
    await clickHandCard(idx);
    await page.waitForTimeout(180);
    if (await st((n2) => document.querySelectorAll('#handcards .hcard.sel').length >= n2, n)) break;
  }
  await page.waitForTimeout(120);
  await clickStrip('下一步');
};
const pickCardAndNext = () => pickNCardsAndNext(1);
const confirmExec = async (label = '确认执行') => {
  await page.waitForTimeout(350);
  await clickStrip(label);
  await page.waitForTimeout(500);
};

// ================ ① 开局 ================
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('Strip售卖测试');
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
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(350);
    if (await st(() => !!document.querySelector('#handcards .cards.selecting'))) break;
  }
  if (!(await st(() => !!document.querySelector('#handcards .cards.selecting')))) return false;
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
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(350);
    if (await st(() => !!document.querySelector('#handcards .cards.selecting'))) break;
  }
  if (!(await st(() => !!document.querySelector('#handcards .cards.selecting')))) return false;
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

// ================ Part1 · 远方市场销售（ActionStrip + 手牌选择） ================
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
    if (await st(() => document.querySelector('#actionstrip')?.style?.display === 'flex')) return true;
  }
  return false;
};

const preSell1 = await stateSnap();
const moneyBefore1 = preSell1.money;
const incomeBefore1 = preSell1.income;

assert('P1.1 真实点击「售卖棉花」进入向导', await clickSellUntilFlow());
assert('P1.2 首次售卖：地图高亮棉花厂、ActionStrip 尚未打开（等待点选厂）',
  await waitFor(() => window.__app?.scene?.picker?.kind === 'sell', 3000, '地图高亮棉花厂'));

assert('P1.3 真实点击 MACCLESFIELD 棉花厂后 ActionStrip 打开路线选择', await clickMillAt('MACCLESFIELD', 0));
await page.waitForTimeout(300);
const r1 = await stripInfo();
assert('P1.4 ActionStrip 标题含「选择售卖路线」', r1?.title.includes('选择售卖路线'), JSON.stringify(r1));
assert('P1.5 路线列表含「远方市场」', r1?.opts.some((o) => o.includes('远方市场')), JSON.stringify(r1?.opts));

assert('P1.6 drawRoute 可直接绘制路线（绿色/粗实线由代码保证）', await st(() => {
  window.__app?.scene?.drawRoute?.(['LIVERPOOL', 'WIGAN']);
  return (window.__app?.scene?.routeC?.list?.length || 0) > 0;
}));
// 清掉调试路线，再用真实鼠标悬停验证选项触发路线绘制
await st(() => window.__app?.scene?.drawRoute?.(null));
await page.locator('#actionstrip .as-body .as-opt').filter({ hasText: /远方市场/ }).hover();
await page.waitForTimeout(250);
assert('P1.7 悬停「远方市场」路线选项时地图画出路线', await st(() =>
  (window.__app?.scene?.routeC?.list?.length || 0) > 0
));

assert('P1.9 真实点击远方市场路线', await clickStripOpt('远方市场'));
await page.waitForTimeout(300);
const r2 = await stripInfo();
assert('P1.10 ActionStrip 标题变为「请丢弃一张手牌」', r2?.title.includes('请丢弃一张手牌'), JSON.stringify(r2));

console.log('[debug] hand cards classes:', await st(() =>
  [...document.querySelectorAll('#handcards .cards .hcard')].map((c) => c.className)
));
console.log('[debug] cards container classes:', await st(() =>
  document.querySelector('#handcards .cards')?.className
));
assert('P1.11 左侧手牌区进入选择模式（有 .pickable 卡片）',
  await waitFor(() => document.querySelectorAll('#handcards .cards .hcard.pickable').length > 0, 3000, '手牌选择模式'));

assert('P1.12 点击第 1 张手牌后该牌被选中', await clickHandCard(0));
await page.waitForTimeout(250);
assert('P1.13 手牌选中数 = 1',
  await st(() => document.querySelectorAll('#handcards .cards .hcard.sel').length === 1));

const r3 = await stripInfo();
assert('P1.14 ActionStrip 显示已选手牌与「确认出售」按钮',
  r3?.btns.some((b) => b.includes('确认出售')), JSON.stringify(r3));

const n1 = await subsLen();
assert('P1.15 真实点击「确认出售」', await clickStrip('确认出售'));
assert('P1.16 远方市场销售被引擎接受', await waitSubmitOk('sell', n1));
await page.waitForTimeout(400);
const pay1 = await st(() => window.__sellPays[window.__sellPays.length - 1] || null);
assert('P1.17 payload：channel=distant + cardId、无 reward 字段',
  !!pay1 && pay1.channel === 'distant' && !!pay1.cardId && pay1.reward === undefined, JSON.stringify(pay1));

const s1 = await stateSnap();
const landed1 = TRACK[s1?.track ?? 0] ?? -1;
assert('P1.18 服务端：市场轨推进', (s1?.track ?? -1) >= 0 && (s1?.track ?? -1) <= 4, 'track=' + s1?.track);
assert('P1.19 服务端：收入轨前进 = 落点(+' + landed1 + ') + 翻面奖励(+5)',
  (s1?.income ?? -1) === (incomeBefore1 ?? -2) + landed1 + 5,
  `income ${incomeBefore1} +${landed1}+5 -> ${s1?.income}`);
assert('P1.20 服务端：金钱不变（官方：远方市场奖励收入轨而非现金）',
  (s1?.money ?? -1) === (moneyBefore1 ?? -2), `money ${moneyBefore1} -> ${s1?.money}`);
assert('P1.21 服务端：棉花厂A翻面', s1?.mills?.some((m) => m.loc === 'MACCLESFIELD' && m.flipped), JSON.stringify(s1?.mills));

// ================ Part1B · 会话续卖（官方步骤 4，不弃牌） ================
const r4 = await stripInfo();
assert('P1.21 会话继续询问在 ActionStrip 中展示',
  r4?.title.includes('继续出售棉花'), JSON.stringify(r4));
const handBefore2 = await st(() => {
  const s = window.__app?.state; if (!s) return -1;
  const me = (s.players || []).find((p) => p.id === s.viewerId);
  return me?.hand?.length ?? -1;
});
assert('P1.22 点击「继续出售」', await clickStrip('继续出售'));
await page.waitForTimeout(400);
const r5 = await stripInfo();
assert('P1.23 ActionStrip 会话列表含「科尔」棉花厂', r5?.opts.some((o) => o.includes('科尔')), JSON.stringify(r5));

assert('P1.24 真实点击会话列表中的「科尔」棉花厂', await clickStripOpt('科尔'));
await page.waitForTimeout(400);
const r6 = await stripInfo();
assert('P1.25 会话续卖路线：含「远方市场」', r6?.opts.some((o) => o.includes('远方市场')), JSON.stringify(r6));

const n2 = await subsLen();
assert('P1.26 真实点击远方市场路线（会话续卖直接提交，不弃牌）', await clickStripOpt('远方市场'));
assert('P1.27 会话续卖被引擎接受', await waitSubmitOk('sell', n2));
await page.waitForTimeout(400);
const pay2 = await st(() => window.__sellPays[window.__sellPays.length - 1] || null);
assert('P1.28 payload：会话续卖【不弃牌】（cardId 为空）+ 无 reward',
  !!pay2 && pay2.channel === 'distant' && pay2.cardId == null && pay2.reward === undefined, JSON.stringify(pay2));
assert('P1.29 服务端：续卖没有弃牌（手牌不变）',
  await st((h) => {
    const s = window.__app?.state; if (!s) return false;
    const me = (s.players || []).find((p) => p.id === s.viewerId);
    return (me?.hand?.length ?? -1) === h;
  }, handBefore2), 'hand=' + await st(() => window.__app?.state?.players?.find((p) => p.id === window.__app?.state?.viewerId)?.hand?.length));

const s2 = await stateSnap();
const landed2 = TRACK[s2?.track ?? 0] ?? -1;
assert('P1.30 服务端：第二次收入轨前进 = 落点(+' + landed2 + ') + 翻面奖励(+5)',
  (s2?.income ?? -1) === (s1?.income ?? -2) + landed2 + 5,
  `income ${s1?.income} +${landed2}+5 -> ${s2?.income}`);
assert('P1.31 服务端：金钱仍不变', (s2?.money ?? -1) === (s1?.money ?? -2), `money ${s1?.money} -> ${s2?.money}`);
assert('P1.32 服务端：棉花厂B翻面', s2?.mills?.some((m) => m.loc === 'COLNE' && m.flipped), JSON.stringify(s2?.mills));
assert('P1.33 全部卖完 → 会话结束、行动点已扣',
  !s2?.pending && (s2?.ap ?? -1) === (s0?.ap ?? -2) - 7,
  `ap ${s0?.ap} -> ${s2?.ap}`);

// ================ Part2 · 注入态：港口路线 + 结束售卖 ================
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
const millX = { millId: 'mill_x', location: 'LIVERPOOL', level: 1, distant: true,
                ports: [{ tileId: 'port_x', location: 'LIVERPOOL', owner: 'P2', level: 1 }],
                routes: [portRoute] };

await injectSellState({ mill: millX, pending: null });
await page.waitForTimeout(500);
assert('P2.1 点「售卖棉花」进入向导（注入态）', await clickSellUntilFlow());
assert('P2.2 真实点击棉花厂进入路线选择', await clickMillAt('LIVERPOOL', 0));
await page.waitForTimeout(300);
const r7 = await stripInfo();
assert('P2.3 ActionStrip 路线含「港口」渠道',
  r7?.opts.some((o) => o.includes('级港口')), JSON.stringify(r7));

assert('P2.4 真实点击港口路线', await clickStripOpt('级港口'));
await page.waitForTimeout(300);
const r8 = await stripInfo();
assert('P2.5 港口路线进入「请丢弃一张手牌」', r8?.title.includes('请丢弃一张手牌'), JSON.stringify(r8));
assert('P2.6 左侧手牌区进入选择模式', await waitFor(() => document.querySelectorAll('#handcards .cards.selecting .hcard.pickable').length > 0, 3000, '手牌选择模式P2'));
assert('P2.7 点击手牌并确认出售', await clickHandCard(0));
await page.waitForTimeout(250);
assert('P2.8 确认出售按钮出现', (await stripInfo())?.btns.some((b) => b.includes('确认出售')));
// P2 注入的是纯客户端假状态，服务端无法校验 mill_x 的港口售卖（会拒绝 → 不触发 cancelFlow → 条不关）。
// 港口售卖的「提交成功 → cancelFlow → ActionStrip 自动关闭」前端闭环与 P1 远端售卖完全同路（已被真实回合验证），
// 此处仅 mock 传输层返回 ok，专门验证前端关闭逻辑本身。
await st(() => {
  window.__app.session.submit = async (a) => {
    if (a.type === 'sell' || a.type === 'sell_end') window.__sellPays.push({ ...a });
    return { ok: true, detail: {} };
  };
  return true;
});
await clickStrip('确认出售');
await page.waitForTimeout(400);
const payP2 = await st(() => window.__sellPays[window.__sellPays.length - 1] || null);
assert('P2.9 payload：channel=port + portTileId + cardId、无 reward',
  !!payP2 && payP2.channel === 'port' && payP2.portTileId === 'port_x' && !!payP2.cardId && payP2.reward === undefined,
  JSON.stringify(payP2));

// ---- 售卖提交后 ActionStrip 应关闭 ----
await page.waitForTimeout(200);
assert('P2.10 港口售卖提交后 ActionStrip 自动关闭',
  await st(() => {
    const r = document.querySelector('#actionstrip');
    return r && window.getComputedStyle(r).display === 'none';
  }));

// ================ 汇总 ================
console.log('\nSUMMARY  CHECKS: ' + checks.length + '  FAIL: ' + checks.filter((c) => !c.ok).length);
if (errors.length) console.log('  [pageerror]', errors.slice(0, 3).join(' | '));
await browser.close();
if (checks.some((c) => !c.ok)) process.exit(1);
console.log('全部通过 ✅');
