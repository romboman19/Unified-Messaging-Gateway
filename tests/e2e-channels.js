const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://192.168.10.11:8083';
const OUT = process.argv[2] || './screenshots-channels';
const PASSWORD = process.env.UMG_ADMIN_PASSWORD || '1CSMumWOQLqm64p6';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    // Start completely clean every run.
  });
  const page = await context.newPage();

  page.on('console', (msg) => console.log('PAGE CONSOLE:', msg.text()));
  page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/') && !url.includes('/api/v1/health')) {
      console.log('API', res.status(), url.replace(BASE, ''));
    }
  });

  // Always go to the login page directly.
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.screenshot({ path: path.join(OUT, '01-login-page.png'), fullPage: true });

  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');

  // Wait until we are no longer on /login.
  await page.waitForFunction(
    () => !window.location.pathname.includes('/login'),
    { timeout: 15000 }
  );
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, '02-after-login.png'), fullPage: true });

  // Navigate to channels page directly.
  await page.goto(`${BASE}/channels`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ path: path.join(OUT, '03-channels.png'), fullPage: true });

  console.log('URL:', page.url());
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  console.log('BODY_TEXT:', text.substring(0, 2000));

  if (!page.url().includes('/channels')) {
    console.log('FAIL: did not reach /channels');
    await browser.close();
    process.exit(1);
  }

  // Wait for the account form to be ready.
  await page.waitForSelector('form input[placeholder*="Основний"]', { timeout: 15000 });

  // Create a new mock account.
  await page.fill('form input[placeholder*="Основний"]', 'Тестовий mock');
  await page.click('form button[type="submit"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '04-account-created.png'), fullPage: true });

  const body = await page.evaluate(() => document.body.innerText);
  if (body.includes('Тестовий mock')) {
    console.log('OK: new account appears in UI');
  } else {
    console.log('FAIL: new account not found');
  }

  // Add endpoint to the newly created account card.
  const cards = await page.$$('section.mt-6 > div.rounded-lg.bg-white.p-4.shadow');
  let testCard = null;
  for (const card of cards) {
    const cardText = await card.evaluate((el) => el.innerText);
    if (cardText.includes('Тестовий mock')) {
      testCard = card;
      break;
    }
  }

  if (testCard) {
    const inputs = await testCard.$$('input');
    if (inputs[0]) await inputs[0].fill('Тест endpoint');
    if (inputs[1]) await inputs[1].fill('test-1');
    if (inputs[2]) await inputs[2].fill('+380991111111');
    const addBtn = await testCard.$('button:has-text("Endpoint")');
    if (addBtn) await addBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '05-endpoint-added.png'), fullPage: true });
    const finalBody = await page.evaluate(() => document.body.innerText);
    if (finalBody.includes('Тест endpoint')) {
      console.log('OK: endpoint appears in UI');
    } else {
      console.log('FAIL: endpoint not found');
    }
  } else {
    console.log('FAIL: account card not found for endpoint creation');
  }

  await browser.close();
  console.log('Screenshots saved to', OUT);
})().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(1);
});
