import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--user-data-dir=C:\\Users\\Administrator\\AppData\\Local\\Temp\\mo-prof4'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1.5 });
await page.goto('http://127.0.0.1:5181/#/meteor/QUA-0001', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 2200));
const el = await page.$('#geom-canvas');
await el.screenshot({ path: 'shot-geom.png' });
await browser.close();
console.log('ok');
