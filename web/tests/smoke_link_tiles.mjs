import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const allErrors = [];
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() === 404) allErrors.push('404: ' + r.url()); });

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};

await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('连接测试');
await page.waitForTimeout(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();

// 等入座 + 准备 + 开局 + 人类回合
await page.waitForFunction(() => {
  const s = window.__app?.session;
  return !!s?.room?.seats?.some((x) => x.isMe);
}, { timeout: 10000 });
const readyBtn = page.getByRole('button', { name: /准备|取消准备/ }).first();
if ((await readyBtn.innerText().catch(() => '')) === '准备') await readyBtn.click();
await page.waitForFunction(() => {
  const s = window.__app?.session;
  return s?.room?.status === 'playing' && !!s?.isMyTurn;
}, { timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('#topbar') && !!document.querySelector('#rightcol'), { timeout: 10000 });

// 等 GameScene 加载完连接槽位数据
await page.waitForFunction(() => {
  const sc = window.__game?.scene?.getScene('GameScene');
  return sc?.ready && Object.keys(sc.linkByPair || {}).length > 0;
}, { timeout: 15000 });

// 给人类玩家强插 4 条不同色/时代的连接板块，并强制重新渲染
const injected = await page.evaluate(() => {
  const app = window.__app;
  const state = JSON.parse(JSON.stringify(app.session.state));
  const me = state.players.find((p) => p.id === state.viewerId);
  if (!me) return { ok: false, reason: 'no viewer' };
  const sc = window.__game.scene.getScene('GameScene');
  if (!sc?.linkByPair || !Object.keys(sc.linkByPair).length) return { ok: false, reason: 'no link geo' };
  // 取前 4 条槽位（linkByPair 的 key 用 '|' 分隔）
  const pairs = Object.keys(sc.linkByPair).slice(0, 4);
  const types = ['canal', 'rail', 'canal', 'rail'];
  const colors = [me.color, me.color, 'yellow', 'purple'];
  me.linkTiles = pairs.map((pair, i) => {
    const [a, b] = pair.split('|');
    return { id: `inject_${i}`, endpoints: [a, b], owner: me.id, type: types[i] };
  });
  // 修改玩家颜色让截图里能看到多色
  const other = state.players.find((p) => p.id !== me.id);
  if (other) other.color = 'red';
  me.linkTiles[2].owner = other ? other.id : me.id;
  me.linkTiles[3].owner = other ? other.id : me.id;
  app.scene.setState(state);
  return { ok: true, pairs, types, colors };
});
assert('注入连接板块成功', injected.ok, JSON.stringify(injected));

await page.waitForTimeout(600);
await page.evaluate(() => {
  const sc = window.__game.scene.getScene('GameScene');
  sc.zoomBy(2.5);
  sc.setScrollRatioX(0.72);
  sc.setScrollRatioY(0.62);
});
await page.waitForTimeout(400);
await page.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/link_tiles_smoke.png' });

// 验证 4 张扫描图纹理都被加载
const textures = await page.evaluate(() => {
  const sc = window.__game.scene.getScene('GameScene');
  return ['red_canal', 'red_rail', 'yellow_canal', 'yellow_rail', 'white_canal', 'white_rail', 'purple_canal', 'purple_rail']
    .map((k) => ({ key: k, exists: sc.textures.exists(k) }));
});
assert('8 张连接板块纹理全部加载', textures.every((t) => t.exists), JSON.stringify(textures));

// 验证 dynC 里确实出现了 Image 对象（而非只有 Graphics）
const dynInspect = await page.evaluate(() => {
  const sc = window.__game.scene.getScene('GameScene');
  const images = sc.dynC.list.filter((o) => o.type === 'Image');
  const containers = sc.dynC.list.filter((o) => o.type === 'Container');
  return {
    imageCount: images.length,
    imageKeys: images.slice(0, 8).map((o) => o.texture?.key),
    containerCount: containers.length,
    containerChildTypes: containers.slice(0, 4).map((c) => c.list.map((o) => o.type)),
  };
});
assert('dynC 中连接板块 Image 对象 > 0', dynInspect.imageKeys.some((k) => /_(canal|rail)$/.test(k)),
  JSON.stringify(dynInspect));

console.log('--- SUMMARY ---');
let failed = 0;
for (const c of checks) if (!c.ok) failed++;
console.log(`CHECKS: ${checks.length}  FAIL: ${failed}`);
console.log('REAL ERRORS:', allErrors.filter((e) => !e.startsWith('404:') && !/Failed to load resource.*404/.test(e)).join('\n') || 'none');

await browser.close();
process.exit(failed === 0 ? 0 : 1);
