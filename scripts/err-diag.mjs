import puppeteer from 'puppeteer-core';
const BASE = process.env.BASE || 'http://127.0.0.1:5181/';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--user-data-dir=C:\\Users\\Administrator\\AppData\\Local\\Temp\\mo-prof3'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (e) => console.log('PAGEERROR@' + page.url() + '\n' + (e.stack || e.message) + '\n---'));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

for (const hash of ['#/nights', '#/stations', '#/showers', '#/validation', '#/meteor/QUA-0001']) {
  await page.goto(BASE + hash, { waitUntil: 'networkidle0', timeout: 40000 });
  await new Promise((r) => setTimeout(r, 2200));
}
console.log('done route sweep');
await browser.close();
