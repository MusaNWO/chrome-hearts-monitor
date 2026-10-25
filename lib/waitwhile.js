/**
 * Waitwhile public API client (Playwright network stack for WAF bypass).
 */
const { chromium } = require('playwright');

const API = 'https://api.waitwhile.com/v2/public';
const RECAPTCHA_SITE_KEY = '6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio';

let browser = null;
let context = null;
let warmed = false;

async function getContext() {
  if (context) return context;
  browser = await chromium.launch({
    headless: process.env.HEADED !== '1',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://waitwhile.com',
      Referer: 'https://waitwhile.com/',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  browser.on('disconnected', () => {
    browser = null;
    context = null;
    warmed = false;
  });
  return context;
}

/** Hit the public site once so Cloudflare/WAF cookies attach to API requests. */
async function warmSession() {
  if (warmed) return;
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    for (let i = 0; i < 4; i++) {
      try {
        await page.goto('https://waitwhile.com/locations/chromeheartsmiami', {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        await page.waitForTimeout(2000);
        warmed = true;
        return;
      } catch {
        await page.waitForTimeout(1500);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}

async function apiGet(path) {
  await warmSession();
  const ctx = await getContext();
  const res = await ctx.request.get(`${API}${path}`, {
    headers: { Accept: 'application/json' },
    timeout: 20_000,
  });
  if (!res.ok()) {
    // One hard reset if WAF starts blocking mid-run
    if (res.status() === 403) {
      warmed = false;
      try {
        if (context) await context.close();
      } catch (_) {}
      context = null;
      browser = null;
      await warmSession();
      const retry = await (await getContext()).request.get(`${API}${path}`, {
        headers: { Accept: 'application/json' },
        timeout: 20_000,
      });
      if (!retry.ok()) {
        throw new Error(
          `GET ${path} → HTTP ${retry.status()} ${(await retry.text()).substring(0, 200)}`
        );
      }
      return retry.json();
    }
    throw new Error(`GET ${path} → HTTP ${res.status()} ${(await res.text()).substring(0, 200)}`);
  }
  return res.json();
}

async function apiPost(path, body, { recaptchaToken } = {}) {
  await warmSession();
  const ctx = await getContext();
  let url = `${API}${path}`;
  if (recaptchaToken) {
    url += (path.includes('?') ? '&' : '?') + `recaptcha=${encodeURIComponent(recaptchaToken)}`;
  }
  const res = await ctx.request.post(url, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://waitwhile.com',
      Referer: 'https://waitwhile.com/',
    },
    data: body,
    timeout: 30_000,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok(), status: res.status(), body: json };
}

async function getLocation(shortName) {
  return apiGet(`/locations/${shortName}`);
}

async function getAvailableSlots(shortName, { fromDate, toDate, maxNumSlots = 20 } = {}) {
  const q = new URLSearchParams({
    fromDate,
    toDate,
    maxNumSlots: String(maxNumSlots),
  });
  return apiGet(`/visits/${shortName}/first-available-slots?${q}`);
}

function pickServiceId(slot, location) {
  const avail = slot.numAvailableSpotsByServiceId || {};
  const withSpots = Object.keys(avail).filter((id) => avail[id] > 0);
  if (withSpots.length) {
    // Prefer Personal Shopping when present
    const personal = withSpots.find((id) =>
      /personal|shop/i.test(location.servicesById?.[id]?.name || '')
    );
    return personal || withSpots[0];
  }
  return (location.availableBookingServiceIds || location.services || [])[0];
}

function manageUrl(shortName, visit) {
  const publicId = visit.publicId || visit.id;
  // Waitwhile guest confirmation / manage page
  return `https://waitwhile.com/locations/${shortName}/visits/${publicId}`;
}

async function close() {
  try {
    if (context) await context.close();
  } catch (_) {}
  try {
    if (browser) await browser.close();
  } catch (_) {}
  context = null;
  browser = null;
  warmed = false;
}

module.exports = {
  RECAPTCHA_SITE_KEY,
  getContext,
  apiGet,
  apiPost,
  getLocation,
  getAvailableSlots,
  pickServiceId,
  manageUrl,
  close,
};
