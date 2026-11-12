/**
 * Waitwhile public API client (Playwright for WAF bypass).
 * Prefer in-page fetch after warming the location page so cookies + browser
 * context look like a real visit. Fully reset on 403 / crash.
 */
const { chromium } = require('playwright');
const ProxyChain = require('proxy-chain');
const {
  getPlaywrightProxy,
  pickNextProxyRaw,
  rotateProxy,
  hasProxy,
  proxyStatus,
} = require('./proxy');

const API = 'https://api.waitwhile.com/v2/public';
const RECAPTCHA_SITE_KEY = '6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio';
const DEFAULT_WARM_URL = 'https://waitwhile.com/locations/chromeheartsmiami';

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

let browser = null;
let context = null;
let apiPage = null;
let apiPageUrl = null;
let uaIndex = 0;
let sessionStartedAt = 0;
let consecutiveForbidden = 0;
let anonymizedProxyUrl = null;

const SESSION_MAX_MS = Number(process.env.WAITWHILE_SESSION_MS) || 12 * 60_000;

function warmUrlFor(pathOrShortName) {
  const m = String(pathOrShortName || '').match(
    /(?:\/locations\/|\/visits\/|\/data-fields\/)?([a-z0-9-]+)/i
  );
  const id = m ? m[1] : 'chromeheartsmiami';
  if (/^(visits|locations|data-fields|v2|public)$/i.test(id)) {
    return DEFAULT_WARM_URL;
  }
  return `https://waitwhile.com/locations/${id}?registration=booking`;
}

async function closeAnonymizedProxy() {
  if (!anonymizedProxyUrl) return;
  try {
    await ProxyChain.closeAnonymizedProxy(anonymizedProxyUrl, true);
  } catch (_) {}
  anonymizedProxyUrl = null;
}

async function launchBrowser() {
  const headed = process.env.HEADED === '1';
  // Ensure a proxy sticky session is selected before Chromium starts
  if (hasProxy()) pickNextProxyRaw({ forceNew: false });
  const proxy = getPlaywrightProxy();
  const launchOpts = {
    headless: !headed,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  };
  if (proxy) {
    // Chromium on Railway often fails authenticated CONNECT; forward via local
    // anonymized proxy so Chrome sees a no-auth localhost proxy.
    const upstream = proxy.username
      ? `http://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@${proxy.server.replace(/^https?:\/\//, '')}`
      : proxy.server;
    anonymizedProxyUrl = await ProxyChain.anonymizeProxy(upstream);
    launchOpts.proxy = { server: anonymizedProxyUrl };
    console.log(
      `[waitwhile] browser via proxy-chain → ${proxyStatus().current || proxy.server}`
    );
  }
  browser = await chromium.launch(launchOpts);
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex += 1;
  context = await browser.newContext({
    userAgent: ua,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // light stealth
    window.chrome = window.chrome || { runtime: {} };
  });
  browser.on('disconnected', () => {
    browser = null;
    context = null;
    apiPage = null;
    apiPageUrl = null;
  });
  sessionStartedAt = Date.now();
}

async function getContext() {
  if (!context) await launchBrowser();
  return context;
}

async function resetSession({ rotateIp = false } = {}) {
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
  sessionStartedAt = 0;
  await closeAnonymizedProxy();
  if (rotateIp && hasProxy()) {
    rotateProxy();
  }
}

function pageIsDead(page) {
  try {
    return !page || page.isClosed();
  } catch {
    return true;
  }
}

/**
 * Keep one live Waitwhile page for API + booking captcha.
 * @param {string} [targetUrl]
 */
async function getApiPage(targetUrl = DEFAULT_WARM_URL) {
  if (sessionStartedAt && Date.now() - sessionStartedAt > SESSION_MAX_MS) {
    await resetSession();
  }

  if (!pageIsDead(apiPage) && apiPageUrl === targetUrl) {
    try {
      // Touch the page — throws if renderer crashed
      await apiPage.evaluate(() => document.readyState);
      return apiPage;
    } catch {
      await resetSession();
    }
  }

  if (!pageIsDead(apiPage) && apiPageUrl !== targetUrl) {
    try {
      const resp = await apiPage.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await apiPage.waitForTimeout(1200 + Math.floor(Math.random() * 800));
      if (resp && resp.status() < 400) {
        apiPageUrl = targetUrl;
        return apiPage;
      }
    } catch {
      try {
        await apiPage.close();
      } catch (_) {}
      apiPage = null;
      apiPageUrl = null;
    }
  }

  await getContext();
  if (pageIsDead(apiPage)) {
    apiPage = await context.newPage();
  }

  const gotoTimeout = hasProxy() ? 45_000 : 60_000;
  for (let i = 0; i < 6; i++) {
    try {
      console.log(`[waitwhile] warmup ${i + 1}/6 → ${targetUrl}`);
      const resp = await apiPage.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: gotoTimeout,
      });
      await apiPage.waitForTimeout(1200 + Math.floor(Math.random() * 800));
      try {
        await apiPage.mouse.move(80 + Math.random() * 400, 120 + Math.random() * 300);
        await apiPage.evaluate(() => window.scrollBy(0, 150 + Math.floor(Math.random() * 200)));
      } catch (_) {}
      const body = ((await apiPage.content()) || '').slice(0, 800);
      if (
        resp &&
        resp.status() < 400 &&
        !/Just a moment|Attention Required|cf-browser-verification/i.test(body)
      ) {
        apiPageUrl = targetUrl;
        console.log(`[waitwhile] warmup ok HTTP ${resp.status()}`);
        return apiPage;
      }
      console.log(`[waitwhile] warmup bad status=${resp && resp.status()}`);
    } catch (err) {
      const msg = String((err && err.message) || err);
      console.log(`[waitwhile] warmup fail: ${msg.slice(0, 140)}`);
      const proxyFail = /TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|ERR_PROXY|ERR_CONNECTION|Timeout/i.test(
        msg
      );
      const crash = /crash|Target closed|has been closed/i.test(msg);
      if (proxyFail || crash) {
        await resetSession({ rotateIp: proxyFail && hasProxy() });
        await getContext();
        apiPage = await context.newPage();
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  apiPageUrl = targetUrl;
  return apiPage;
}

async function fetchJsonViaPage(page, url) {
  return page.evaluate(async (u) => {
    const res = await fetch(u, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  }, url);
}

async function fetchJsonViaRequest(page, url) {
  const res = await page.request.get(url, {
    headers: {
      Accept: 'application/json',
      Origin: 'https://waitwhile.com',
      Referer: page.url() || 'https://waitwhile.com/',
    },
    timeout: 20_000,
  });
  const text = await res.text();
  return { status: res.status(), ok: res.ok(), text };
}

function parseJsonOrThrow(path, result) {
  if (!result.ok) {
    throw new Error(`GET ${path} → HTTP ${result.status} ${String(result.text).substring(0, 200)}`);
  }
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(`GET ${path} → invalid JSON ${String(result.text).substring(0, 200)}`);
  }
}

async function apiGet(path, { warmUrl } = {}) {
  const target = warmUrl || warmUrlFor(path);
  const url = `${API}${path}`;

  const attempt = async (forceReset) => {
    if (forceReset) await resetSession();
    const page = await getApiPage(target);
    // Prefer in-page fetch (real browser TLS / cookies); fall back to page.request
    let result;
    try {
      result = await fetchJsonViaPage(page, url);
    } catch (err) {
      if (/crash|Target closed|has been closed/i.test(String(err && err.message))) {
        await resetSession();
        const page2 = await getApiPage(target);
        result = await fetchJsonViaRequest(page2, url);
      } else {
        result = await fetchJsonViaRequest(page, url);
      }
    }
    return result;
  };

  let result = await attempt(false);
  if (result.status === 403 || result.status === 429) {
    consecutiveForbidden += 1;
    // Back off a bit before rotating UA / session
    await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * consecutiveForbidden)));
    result = await attempt(true);
  }

  if (!result.ok) {
    if (result.status === 403 || result.status === 429) consecutiveForbidden += 1;
    throw new Error(
      `GET ${path} → HTTP ${result.status} ${String(result.text).substring(0, 200)}`
    );
  }

  consecutiveForbidden = 0;
  return parseJsonOrThrow(path, result);
}

async function apiPost(path, body, { recaptchaToken, warmUrl } = {}) {
  const page = await getApiPage(warmUrl || warmUrlFor(path));
  let url = `${API}${path}`;
  if (recaptchaToken) {
    url += (path.includes('?') ? '&' : '?') + `recaptcha=${encodeURIComponent(recaptchaToken)}`;
  }
  const res = await page.request.post(url, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: 'https://waitwhile.com',
      Referer: page.url() || 'https://waitwhile.com/',
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
  return apiGet(`/locations/${shortName}`, {
    warmUrl: `https://waitwhile.com/locations/${shortName}?registration=booking`,
  });
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
      const body = await apiGet(`/data-fields/${shortName}`, {
        warmUrl: `https://waitwhile.com/locations/${shortName}?registration=booking`,
      });
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
  return apiGet(`/visits/${shortName}/first-available-slots?${q}`, {
    warmUrl: `https://waitwhile.com/locations/${shortName}?registration=booking`,
  });
}

function pickServiceId(slot, location) {
  const byId = location.servicesById || {};
  const avail = slot.numAvailableSpotsByServiceId || {};
  const withSpots = Object.keys(avail).filter((id) => {
    if (!(avail[id] > 0)) return false;
    const svc = byId[id];
    if (!svc) return true;
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

function getConsecutiveForbidden() {
  return consecutiveForbidden;
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
  getConsecutiveForbidden,
  resetSession,
  proxyStatus,
  hasProxy,
  close,
};
