/**
 * Waitwhile public API client (Playwright browser for WAF bypass).
 * API calls run as fetch() inside a real waitwhile.com page so Cloudflare
 * cookies / TLS fingerprint match a normal browser (needed on Railway).
 */
const { chromium } = require('playwright');

const API = 'https://api.waitwhile.com/v2/public';
const RECAPTCHA_SITE_KEY = '6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio';
const WARM_URL = 'https://waitwhile.com/locations/chromeheartsmiami';

let browser = null;
let context = null;
let apiPage = null;

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
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  browser.on('disconnected', () => {
    browser = null;
    context = null;
    apiPage = null;
  });
  return context;
}

async function getApiPage() {
  if (apiPage && !apiPage.isClosed()) return apiPage;
  const ctx = await getContext();
  apiPage = await ctx.newPage();
  let ok = false;
  for (let i = 0; i < 5; i++) {
    try {
      await apiPage.goto(WARM_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await apiPage.waitForTimeout(1500);
      const status = await apiPage.evaluate(() => document.title || '');
      if (!/403|Attention Required|Just a moment/i.test(status + (await apiPage.content()).slice(0, 500))) {
        ok = true;
        break;
      }
    } catch {
      await apiPage.waitForTimeout(1500);
    }
  }
  if (!ok) {
    // Still proceed — fetch may work even if title looks odd
  }
  return apiPage;
}

async function browserFetch(method, path, body) {
  const page = await getApiPage();
  const url = `${API}${path}`;
  const result = await page.evaluate(
    async ({ method, url, body }) => {
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Accept: 'application/json',
            ...(body
              ? {
                  'Content-Type': 'application/json',
                  Origin: 'https://waitwhile.com',
                  Referer: 'https://waitwhile.com/',
                }
              : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          credentials: 'include',
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
      } catch (err) {
        return { ok: false, status: 0, text: String(err && err.message ? err.message : err) };
      }
    },
    { method, url, body: body || null }
  );

  let json;
  try {
    json = JSON.parse(result.text);
  } catch {
    json = { raw: String(result.text).substring(0, 300) };
  }
  return { ok: result.ok, status: result.status, body: json, text: result.text };
}

async function apiGet(path) {
  const res = await browserFetch('GET', path);
  if (!res.ok) {
    // Reset page once on WAF block
    if (res.status === 403 || /403 Forbidden/i.test(res.text || '')) {
      try {
        if (apiPage) await apiPage.close();
      } catch (_) {}
      apiPage = null;
      const retry = await browserFetch('GET', path);
      if (!retry.ok) {
        throw new Error(
          `GET ${path} → HTTP ${retry.status} ${String(retry.text).substring(0, 200)}`
        );
      }
      return retry.body;
    }
    throw new Error(`GET ${path} → HTTP ${res.status} ${String(res.text).substring(0, 200)}`);
  }
  return res.body;
}

async function apiPost(path, body, { recaptchaToken } = {}) {
  let p = path;
  if (recaptchaToken) {
    p += (path.includes('?') ? '&' : '?') + `recaptcha=${encodeURIComponent(recaptchaToken)}`;
  }
  return browserFetch('POST', p, body);
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
    const personal = withSpots.find((id) =>
      /personal|shop/i.test(location.servicesById?.[id]?.name || '')
    );
    return personal || withSpots[0];
  }
  return (location.availableBookingServiceIds || location.services || [])[0];
}

function manageUrl(shortName, visit) {
  const publicId = visit.publicId || visit.id;
  return `https://waitwhile.com/locations/${shortName}/visits/${publicId}`;
}

async function close() {
  try {
    if (apiPage) await apiPage.close();
  } catch (_) {}
  try {
    if (context) await context.close();
  } catch (_) {}
  try {
    if (browser) await browser.close();
  } catch (_) {}
  apiPage = null;
  context = null;
  browser = null;
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
