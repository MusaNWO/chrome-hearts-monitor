#!/usr/bin/env node
/**
 * Local end-to-end booking test (no Telegram).
 * Opens Waitwhile → grecaptcha → POST visit in the SAME browser page.
 *
 *   HEADED=1 node scripts/local-book-test.js
 *   HEADED=1 node scripts/local-book-test.js --location chromehearts
 *   DRY_RUN=1 node scripts/local-book-test.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { chromium } = require('playwright');
const { randomGuest } = require('../lib/guest');
const {
  manageUrl,
  pickServiceId,
  buildPublicDataFieldAnswers,
} = require('../lib/waitwhile');

const V3_SITE_KEY = '6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio';
const ACTION = 'PUB_CREATE_VISIT';
const API = 'https://api.waitwhile.com/v2/public';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}
function pad(n) {
  return String(n).padStart(2, '0');
}
function iso(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00`;
}

async function main() {
  const locationId = arg('location', 'lasvegas-fontaine');
  const dryRun = process.env.DRY_RUN === '1';
  const headed = process.env.HEADED !== '0';

  console.log(`Local book test → ${locationId} (headed=${headed}, dryRun=${dryRun})`);

  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    // 1) Load booking page
    const pageUrl = `https://waitwhile.com/locations/${locationId}?registration=booking`;
    console.log('Opening', pageUrl);
    for (let i = 0; i < 5; i++) {
      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(2500);
        const t = await page.evaluate(() => document.body?.innerText?.slice(0, 60) || '');
        if (!t.includes('404')) break;
      } catch (e) {
        console.log('goto retry', i, e.message.slice(0, 80));
        await page.waitForTimeout(1500);
      }
    }

    // Humanize
    await page.mouse.move(140, 200);
    await page.waitForTimeout(500);
    await page.mouse.move(400, 360);
    await page.evaluate(() => window.scrollBy(0, 250));
    await page.waitForTimeout(1200);

    // 2) Fetch slots via page.request (same session)
    const q = new URLSearchParams({
      fromDate: iso(0),
      toDate: iso(60),
      maxNumSlots: '10',
    });
    const slotsRes = await page.request.get(
      `${API}/visits/${locationId}/first-available-slots?${q}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!slotsRes.ok()) {
      throw new Error(`slots HTTP ${slotsRes.status()} ${(await slotsRes.text()).slice(0, 200)}`);
    }
    const slots = await slotsRes.json();
    console.log('Slots:', slots.length);
    if (!slots.length) throw new Error('No slots available');
    const slot = slots[0];
    console.log('Picking', slot.date);

    const locRes = await page.request.get(`${API}/locations/${locationId}`, {
      headers: { Accept: 'application/json' },
    });
    if (!locRes.ok()) throw new Error(`location HTTP ${locRes.status()}`);
    const location = await locRes.json();
    const serviceId = pickServiceId(slot, location);
    const person = randomGuest();
    console.log('Guest', person.name, person.phone, person.email);

    let dataFields = [];
    try {
      const dfRes = await page.request.get(`${API}/data-fields/${locationId}`, {
        headers: { Accept: 'application/json' },
      });
      if (dfRes.ok()) {
        const rawFields = await dfRes.json();
        dataFields = buildPublicDataFieldAnswers(rawFields);
        console.log(
          'Questionnaire answers:',
          dataFields.map((d) => `${d.id}=${d.values.join('|')}`).join(', ') || '(none)'
        );
      }
    } catch (_) {}

    const payload = {
      state: 'BOOKED',
      firstName: person.firstName,
      lastName: person.lastName,
      name: person.name,
      email: person.email,
      phone: person.phone,
      partySize: 1,
      serviceIds: serviceId ? [serviceId] : [],
      date: slot.date,
      duration: slot.duration || 3600,
    };
    if (dataFields.length) payload.dataFields = dataFields;

    if (dryRun) {
      console.log('DRY_RUN payload OK', JSON.stringify(payload, null, 2));
      return;
    }

    // 3) reCAPTCHA in this page
    const hasRender = await page.evaluate(
      () => !!document.querySelector('script[src*="recaptcha/api.js?render="]')
    );
    if (!hasRender) {
      await page.addScriptTag({
        url: `https://www.google.com/recaptcha/api.js?render=${V3_SITE_KEY}`,
      });
      await page.waitForTimeout(2500);
    }
    await page.waitForFunction(() => window.grecaptcha && window.grecaptcha.execute, {
      timeout: 25_000,
    });
    console.log('Executing grecaptcha…');
    const token = await page.evaluate(
      async ({ siteKey, action }) => {
        await new Promise((r) => grecaptcha.ready(r));
        return grecaptcha.execute(siteKey, { action });
      },
      { siteKey: V3_SITE_KEY, action: ACTION }
    );
    console.log('Token len', token?.length);

    // 4) Immediate POST from same page
    const postUrl = `${API}/visits/${locationId}?recaptcha=${encodeURIComponent(token)}`;
    const bookRes = await page.request.post(postUrl, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://waitwhile.com',
        Referer: pageUrl,
      },
      data: payload,
      timeout: 30_000,
    });
    const text = await bookRes.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 300) };
    }

    if (!bookRes.ok()) {
      console.log('\n❌ BOOKING FAILED');
      console.log('HTTP', bookRes.status());
      console.log(body);
      process.exitCode = 2;
      return;
    }

    const visit = body;
    const url = manageUrl(locationId, visit);
    console.log('\n✅ BOOKED');
    console.log('Store:', location.displayName || locationId);
    console.log('Date:', slot.date);
    console.log('Guest:', person.name, person.phone);
    console.log('Manage:', url);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
