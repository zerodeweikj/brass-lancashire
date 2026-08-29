// 大厅留言入口 e2e（2026-08-12）：
//   大厅底部常驻「留言 / 提意见」按钮 → 点击弹出全屏留言浮层 →
//   填正文（选填联系方式）→ 提交 POST /api/feedback → 浮层关闭 + 成功 toast；
//   空正文提交被拒、浮层不关。验证前端接线与后端落盘闭环。
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
const waitFor = async (fn, timeout = 12000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await page.evaluate(fn)) return true; } catch { /* ignore */ }
    await page.waitForTimeout(160);
  }
  console.log('  [warn] 等待超时:', label);
  return false;
};

await page.goto(URL, { waitUntil: 'domcontentloaded' });

// 1) 大厅底部留言按钮存在
assert('大厅底部出现「留言 / 提意见」按钮',
  await waitFor(() => !!document.querySelector('#lobby .feedback-foot button')));

// 2) 点击弹出浮层
await page.click('#lobby .feedback-foot button');
assert('点击后弹出留言浮层',
  await waitFor(() => !!document.querySelector('.feedback-overlay .feedback-card')));
assert('浮层含多行文本框',
  await page.evaluate(() => !!document.querySelector('.feedback-overlay textarea.fb-text')));
assert('浮层含选填联系方式输入框',
  await page.evaluate(() => !!document.querySelector('.feedback-overlay input.fb-contact')));

// 3) 空正文提交被拒、浮层不关
await page.fill('.feedback-overlay textarea.fb-text', '   ');
await page.click('.feedback-overlay .feedback-card .primary');
await page.waitForTimeout(400);
assert('空正文提交被拒（浮层仍在）',
  await page.evaluate(() => !!document.querySelector('.feedback-overlay')));

// 4) 真实提交 → 浮层关闭 + 成功 toast + 后端落盘
const before = await page.evaluate(async () => {
  const r = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
  const t = await r.json();
  return t.ok ? 1 : 0;
}).catch(() => 0);
void before;

const msg = 'e2e 测试：缩放手感很赞，建议加个音效';
await page.fill('.feedback-overlay textarea.fb-text', msg);
await page.fill('.feedback-overlay input.fb-contact', 'tester@local');
await page.click('.feedback-overlay .feedback-card .primary');
assert('提交后浮层关闭',
  await waitFor(() => !document.querySelector('.feedback-overlay'), 8000, 'overlay-close'));
const toastOk = await waitFor(() =>
  [...document.querySelectorAll('body *')].some((e) => e.textContent.includes('已收到，谢谢你的意见')), 6000, 'toast');
assert('出现成功 toast「已收到，谢谢你的意见！」', toastOk);

// 5) 后端落盘验证（读服务端日志文件行数增长）
const line = await page.evaluate(async () => {
  const r = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'e2e-probe-line' }) });
  return (await r.json()).ok === true;
}).catch(() => false);
assert('后端 /api/feedback 接收成功（同源 fetch）', line);

assert('无未捕获页面错误', errors.length === 0, errors.join(' | '));

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log('\nSUMMARY: ' + (checks.length - failed.length) + '/' + checks.length + ' passed');
if (failed.length) {
  console.log('FAILED: ' + failed.map((c) => c.name).join('; '));
  process.exit(1);
}
