/**
 * Waitwhile public API client (Playwright for WAF bypass).
 * Uses page.request after loading waitwhile.com so cookies attach.
 */
const { chromium } = require('playwright');

const API = 'https://api.waitwhile.com/v2/public';
const RECAPTCHA_SITE_KEY = '6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio';
const DEFAULT_WARM_URL = 'https://waitwhile.com/locations/chromeheartsmiami';

let browser = null;
let context = null;
let apiPage = null;
let apiPageUrl = null;

async function launchBrowser() {
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
    apiPageUrl = null;
  });
}

async function getContext() {
  if (!context) await launchBrowser();
  return context;
}

async function resetSession() {
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
  apiPageUrl = null;
  context = null;
  browser = null;
}

/**
 * Keep one live Waitwhile page for API + booking captcha.
 * @param {string} [targetUrl]
 */
async function getApiPage(targetUrl = DEFAULT_WARM_URL) {
  if (apiPage && !apiPage.isClosed() && apiPageUrl === targetUrl) return apiPage;

  if (apiPage && !apiPage.isClosed() && apiPageUrl !== targetUrl) {
    try {
      await apiPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await apiPage.waitForTimeout(1500);
      apiPageUrl = targetUrl;
      return apiPage;
    } catch {
      try {
        await apiPage.close();
      } catch (_) {}
      apiPage = null;
      apiPageUrl = null;
    }
  }

  await getContext();
  apiPage = await context.newPage();
  for (let i = 0; i < 5; i++) {
    try {
      const resp = await apiPage.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await apiPage.waitForTimeout(1500 + Math.floor(Math.random() * 800));
      const body = ((await apiPage.content()) || '').slice(0, 800);
      if (
        resp &&
        resp.status() < 400 &&
        !/Just a moment|Attention Required|cf-browser-verification/i.test(body)
      ) {
        apiPageUrl = targetUrl;
        return apiPage;
      }
    } catch {
      await apiPage.waitForTimeout(1500);
    }
  }
  apiPageUrl = targetUrl;
  return apiPage;
}

async function apiGet(path) {
  const page = await getApiPage();
  const res = await page.request.get(`${API}${path}`, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://waitwhile.com',
      Referer: 'https://waitwhile.com/',
    },
    timeout: 20_000,
  });
  if (!res.ok()) {
    const text = await res.text();
    if (res.status() === 403) {
      await resetSession();
      const page2 = await getApiPage();
      const retry = await page2.request.get(`${API}${path}`, {
        headers: {
          Accept: 'application/json',
          Origin: 'https://waitwhile.com',
          Referer: 'https://waitwhile.com/',
        },
        timeout: 20_000,
      });
      if (!retry.ok()) {
        throw new Error(
          `GET ${path} → HTTP ${retry.status()} ${(await retry.text()).substring(0, 200)}`
        );
      }
      return retry.json();
    }
    throw new Error(`GET ${path} → HTTP ${res.status()} ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function apiPost(path, body, { recaptchaToken } = {}) {
  const page = await getApiPage();
  let url = `${API}${path}`;
  if (recaptchaToken) {
    url += (path.includes('?') ? '&' : '?') + `recaptcha=${encodeURIComponent(recaptchaToken)}`;
  }
  const res = await page.request.post(url, {
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
    json = { raw: text.substring(0, 300) };
  }
  return { ok: res.ok(), status: res.status(), body: json };
}

async function getLocation(shortName) {
  return apiGet(`/locations/${shortName}`);
}

/** Public booking questionnaire fields (acknowledgments, guest names, etc.). */
const dataFieldCache = new Map(); // shortName -> { at, fields }

async function getDataFields(shortName, { page = null, ttlMs = 10 * 60_000 } = {}) {
  const cached = dataFieldCache.get(shortName);
  if (cached && Date.now() - cached.at < ttlMs) return cached.fields;

  let fields = [];
  try {
    if (page && !page.isClosed()) {
      const res = await page.request.get(`${API}/data-fields/${shortName}`, {
        headers: {
          Accept: 'application/json',
          Origin: 'https://waitwhile.com',
          Referer: 'https://waitwhile.com/',
        },
        timeout: 20_000,
      });
      if (res.ok()) {
        const body = await res.json();
        if (Array.isArray(body)) fields = body;
      }
    } else {
      const body = await apiGet(`/data-fields/${shortName}`);
      if (Array.isArray(body)) fields = body;
    }
  } catch (_) {
    fields = [];
  }
  dataFieldCache.set(shortName, { at: Date.now(), fields });
  return fields;
}

/**
 * Auto-answer required public booking questions.
 * CHOICE → first option (usually "Yes"); guest-name TEXT → "N/A".
 */
function buildPublicDataFieldAnswers(fields) {
  if (!Array.isArray(fields) || !fields.length) return [];
  const out = [];
  for (const f of fields) {
    if (!f || !f.id) continue;
    if (f.isActive === false || f.isActiveBooking === false || f.isPublic === false) continue;
    // Always answer required public fields; also fill optional guest-name style prompts
    const required = f.isRequiredPublic === true;
    const name = `${f.name || ''} ${f.displayName || ''}`.toLowerCase();
    const isGuestNames = /guest.?s?.?name|if no guests|n\/a/i.test(name);
    const isNotes = /client notes|^notes$/i.test(name) || /notes/i.test(f.displayName || '');
    if (!required && !isGuestNames) continue;
    if (isNotes && !required) continue;

    let value = null;
    if (f.inputType === 'CHOICE' || f.inputType === 'CHECKBOX') {
      const opts = Array.isArray(f.inputOptions) ? f.inputOptions.filter(Boolean) : [];
      value = opts[0] || 'Yes';
    } else if (f.inputType === 'TEXT' || f.inputType === 'TEXTAREA') {
      if (isGuestNames) value = 'N/A';
      else if (f.defaultValue) value = String(f.defaultValue);
      else value = 'N/A';
    } else if (f.defaultValue != null && f.defaultValue !== '') {
      value = String(f.defaultValue);
    } else if (required) {
      value = 'Yes';
    }
    if (value == null || value === '') continue;
    out.push({ id: f.id, values: [value] });
  }
  return out;
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
  const byId = location.servicesById || {};
  const avail = slot.numAvailableSpotsByServiceId || {};
  const withSpots = Object.keys(avail).filter((id) => {
    if (!(avail[id] > 0)) return false;
    const svc = byId[id];
    if (!svc) return true;
    // Skip category parents (e.g. "Services") — Waitwhile rejects those
    const kids = Object.values(byId).some((s) => s && s.parentId === id);
    if (kids) return false;
    return svc.isActiveBooking !== false;
  });
  if (withSpots.length) {
    const personal = withSpots.find((id) => {
      const s = byId[id] || {};
      return /personal|in-store\s*shop|shopping/i.test(
        `${s.name || ''} ${s.displayName || ''}`
      );
    });
    return personal || withSpots[0];
  }
  return (location.availableBookingServiceIds || location.services || [])[0];
}

function manageUrl(shortName, visit) {
  const publicId = visit.publicId || visit.id;
  return `https://waitwhile.com/locations/${shortName}/visits/${publicId}`;
}

async function close() {
  await resetSession();
}

module.exports = {
  API,
  RECAPTCHA_SITE_KEY,
  getContext,
  getApiPage,
  apiGet,
  apiPost,
  getLocation,
  getDataFields,
  buildPublicDataFieldAnswers,
  getAvailableSlots,
  pickServiceId,
  manageUrl,
  close,
};
