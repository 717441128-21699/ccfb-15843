// 浏览器冒烟：加载各路由，收集页面错误，等待关键内容，截图
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:4188/';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--user-data-dir=C:\\Users\\Administrator\\AppData\\Local\\Temp\\mo-prof2'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('requestfailed', (r) => errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure()?.errorText ?? '')));

async function shot(hash, file, waitSel, waitMs = 1200) {
  await page.goto(BASE + hash, { waitUntil: 'networkidle0', timeout: 30000 });
  if (waitSel) {
    try { await page.waitForSelector(waitSel, { timeout: 15000 }); }
    catch { errors.push(`WAIT_TIMEOUT ${waitSel} @${hash}`); }
  }
  await new Promise((r) => setTimeout(r, waitMs));
  await page.screenshot({ path: file, fullPage: false });
  console.log('shot', file);
}

await shot('#/nights', 'shot-nights.png', '.meteor-thumb', 1500);
// 点第一张流星卡缩略图进详情
try {
  await page.click('.meteor-thumb');
  await page.waitForSelector('#geom-canvas', { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 1800));
  await page.screenshot({ path: 'shot-detail.png' });
  console.log('shot shot-detail.png, hash=', page.url());
} catch (e) {
  errors.push('detail open failed: ' + e.message);
}
await shot('#/showers', 'shot-showers.png', '#radiant-map', 1800);
await shot('#/validation', 'shot-validation.png', undefined, 800);
await shot('#/stations', 'shot-stations2.png', '.badge.good', 5000);

// 测试交互式合成检测（点击按钮，等待完成 toast / 新卡片，最多 90s）
await page.goto(BASE + '#/nights', { waitUntil: 'networkidle0' });
const btns = await page.$$('button');
for (const b of btns) {
  const txt = await page.evaluate((x) => x.textContent, b);
  if (txt && txt.includes('合成并检测演示夜')) { await b.click(); break; }
}
try {
  await page.waitForFunction(() => document.body.innerText.includes('检测完成'), { timeout: 120000 });
  console.log('synth run completed');
} catch { errors.push('synth run did not complete in time'); }
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: 'shot-synth-done.png' });

console.log('\n==== ERRORS (' + errors.length + ') ====');
for (const e of errors.slice(0, 40)) console.log(e);
await browser.close();
process.exit(errors.some((e) => e.startsWith('PAGEERROR') || e.startsWith('REQFAIL')) ? 1 : 0);
