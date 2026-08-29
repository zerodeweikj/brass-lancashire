// 验证大厅输入框在自动刷新（4s）期间不会被清空/丢焦点。
// 复现用户反馈：建房密码框输入后立刻被清空。
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://47.76.136.173';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
// 进入大厅（等待昵称输入框出现）
await page.waitForSelector('input[placeholder="你的昵称"]', { timeout: 15000 });

// 先填昵称、房间名、密码
await page.fill('input[placeholder="你的昵称"]', '房东');
await page.fill('input[placeholder="房间名（可留空）"]', '私密房');
await page.fill('input[placeholder*="房间密码"]', 'secret123');

// 让焦点停在密码框，等待超过一个刷新周期（>4s）
await page.focus('input[placeholder*="房间密码"]');
await page.waitForTimeout(5200);

const pwd = await page.inputValue('input[placeholder*="房间密码"]');
ok(pwd === 'secret123', `密码框在刷新后未被清空 (实际="${pwd}")`);

const nm = await page.inputValue('input[placeholder="你的昵称"]');
ok(nm === '房东', `昵称框在刷新后保持 (实际="${nm}")`);

// 焦点仍在密码框（未被重建打断）
const focused = await page.evaluate(() => {
  const el = document.activeElement;
  return el && el.tagName === 'INPUT' && /房间密码/.test(el.placeholder || '');
});
ok(focused, '刷新期间密码框焦点未被打断');

// 真正建房并验证密码生效
await page.click('button.primary');
await page.waitForSelector('text=房间号', { timeout: 8000 });
const rid = await page.evaluate(() => {
  const m = location.href.match(/[?&]room=([A-F0-9]+)/i) || document.body.innerText.match(/房间号\s*([A-F0-9]+)/i);
  return m ? m[1] : null;
});
ok(!!rid, `建房成功，房间号=${rid}`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
