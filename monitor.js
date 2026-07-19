#!/usr/bin/env node
require('dotenv').config();

/**
 * Chrome Hearts Appointment Slot Monitor — Multi-Location
 * Prefers lightweight HTTPS (no browser). Falls back to Playwright
 * only if the Waitwhile WAF blocks direct requests.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'your_bot_token_here') {
  console.error('❌  Missing TELEGRAM_BOT_TOKEN in .env'); process.exit(1);
}
if (TELEGRAM_CHAT_IDS.length === 0) {
  console.error('❌  Missing TELEGRAM_CHAT_ID in .env'); process.exit(1);
}

const RAW_IDS = (process.env.LOCATION_IDS || 'chromeheartsmiami,chromehearts').split(',').map(s => s.trim()).filter(Boolean);

const LOCATION_NAMES = {
  'chromeheartsmiami': 'Chrome Hearts Miami',
  'lasvegas-fontaine': 'Chrome Hearts Las Vegas',
  'chromehearts-newyork': 'Chrome Hearts New York',
  'chromehearts': 'Chrome Hearts New York West Village',
  'chromeheartswestvillage': 'Chrome Hearts West Village',
};

const LOCATIONS = RAW_IDS.map(id => ({
  id,
  name: LOCATION_NAMES[id] || id,
  bookingUrl: `https://waitwhile.com/locations/${id}/time?registration=booking`,
}));

const CONFIG = {
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 30_000,
  lookAheadDays: Number(process.env.LOOK_AHEAD_DAYS) || 60,
  logFile: path.join(__dirname, 'monitor.log'),
  repeatAlertMs: 5 * 60 * 1000,
  browserRecycleMs: 30 * 60 * 1000, // recycle Playwright every 30 min if used
};

const BASE = 'https://api.waitwhile.com/v2/public/visits';

const state = {};
for (const loc of LOCATIONS) {
  state[loc.id] = { previousSlotKeys: new Set(), lastAlertTime: 0 };
}

let checkCount = 0;
let consecutiveErrors = 0;
let checking = false;
let useBrowser = false; // flipped true only if direct HTTPS gets blocked
let browser = null;
let browserContext = null;
let browserLaunchedAt = 0;

const padTo2 = n => String(n).padStart(2, '0');

function nowStr() {
  const d = new Date();
  return `${padTo2(d.getHours())}:${padTo2(d.getMinutes())}:${padTo2(d.getSeconds())}`;
}

function isoDatetime(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${padTo2(d.getMonth() + 1)}-${padTo2(d.getDate())}T00:00`;
}

function log(msg) {
  const line = `[${nowStr()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.logFile, line + '\n'); } catch (_) {}
}

function formatSlot(slot) {
  if (typeof slot === 'string') {
    return new Date(slot).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  if (slot?.date) {
    const d = new Date(slot.date);
    const spots = slot.numAvailableSpots;
    return `${d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — ${spots} spot${spots !== 1 ? 's' : ''}`;
  }
  return JSON.stringify(slot);
}

// ─── Telegram ──────────────────────────────────────────────────────────────────
function sendToOne(chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) log(`⚠️  Telegram error (${chatId}): ${JSON.stringify(json)}`);
          resolve(json);
        } catch { resolve(null); }
      });
    });
    req.on('error', e => { log(`⚠️  Telegram send failed (${chatId}): ${e.message}`); resolve(null); });
    req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function sendTelegram(text) {
  await Promise.all(TELEGRAM_CHAT_IDS.map(id => sendToOne(id, text)));
}

async function triggerAlert(loc, slots, isRepeat = false) {
  const slotLines = slots.slice(0, 10).map((s, i) => `  ${i + 1}. ${formatSlot(s)}`).join('\n');
  const header = isRepeat ? `🔔 <b>REMINDER — Slots Still Open</b>` : `🚨 <b>NEW SLOT AVAILABLE — Book Now!</b>`;

  const msg = [
    header,
    `📍 <b>${loc.name}</b>`,
    ``,
    `<b>Available (${slots.length} slot${slots.length !== 1 ? 's' : ''}):</b>`,
    slotLines,
    slots.length > 10 ? `  ...and ${slots.length - 10} more` : '',
    ``,
    `👉 <a href="${loc.bookingUrl}">Tap here to book</a>`,
    ``,
    `<i>${new Date().toLocaleString()}</i>`,
  ].filter(Boolean).join('\n');

  log(`${isRepeat ? '🔔' : '🚨'} ${loc.name} — ${isRepeat ? 'reminder' : 'ALERT'} (${slots.length} slots)`);
  await sendTelegram(msg);
}

// ─── Direct HTTPS (preferred — no Chromium memory) ─────────────────────────────
function fetchJsonDirect(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://waitwhile.com',
        'Referer': 'https://waitwhile.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 403 || res.statusCode === 401) {
          const err = new Error(`HTTP ${res.statusCode} blocked`);
          err.blocked = true;
          return reject(err);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} — ${data.substring(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ─── Playwright fallback (only if WAF blocks direct) ───────────────────────────
async function closeBrowser() {
  const ctx = browserContext;
  const br = browser;
  browserContext = null;
  browser = null;
  browserLaunchedAt = 0;
  try { if (ctx) await ctx.close(); } catch (_) {}
  try { if (br) await br.close(); } catch (_) {}
}

async function ensureBrowserContext() {
  if (browserContext && browser?.isConnected()) {
    if (Date.now() - browserLaunchedAt > CONFIG.browserRecycleMs) {
      log('♻️  Recycling browser to free memory...');
      await closeBrowser();
    } else {
      return browserContext;
    }
  }

  const { chromium } = require('playwright');
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-software-rasterizer',
      '--single-process',
      '--js-flags=--max-old-space-size=128',
    ],
  });

  browserContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://waitwhile.com',
      'Referer': 'https://waitwhile.com/',
    },
  });

  browserLaunchedAt = Date.now();
  browser.on('disconnected', () => {
    browser = null;
    browserContext = null;
    browserLaunchedAt = 0;
  });

  return browserContext;
}

async function fetchJsonBrowser(url) {
  const ctx = await ensureBrowserContext();
  const res = await ctx.request.get(url, {
    headers: { 'Accept': 'application/json, text/plain, */*' },
    timeout: 15_000,
  });
  if (!res.ok()) throw new Error(`HTTP ${res.status()} — ${(await res.text()).substring(0, 200)}`);
  return res.json();
}

async function apiGet(url) {
  if (!useBrowser) {
    try {
      return await fetchJsonDirect(url);
    } catch (err) {
      if (err.blocked) {
        log('⚠️  Direct API blocked by WAF — enabling Playwright fallback');
        useBrowser = true;
      } else {
        throw err;
      }
    }
  }
  return fetchJsonBrowser(url);
}

// ─── Check one location ────────────────────────────────────────────────────────
async function checkLocation(loc) {
  const fromDate = isoDatetime(0);
  const toDate = isoDatetime(CONFIG.lookAheadDays);
  const s = state[loc.id];

  const slots = await apiGet(
    `${BASE}/${loc.id}/first-available-slots` +
    `?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}&maxNumSlots=10`
  );

  const currentKeys = new Set(
    Array.isArray(slots) ? slots.map(sl => typeof sl === 'string' ? sl : (sl.date || JSON.stringify(sl))) : []
  );

  const hasSlots = currentKeys.size > 0;
  const newKeys = [...currentKeys].filter(k => !s.previousSlotKeys.has(k));
  const closedKeys = [...s.previousSlotKeys].filter(k => !currentKeys.has(k));

  if (closedKeys.length) log(`ℹ️  ${loc.name}: ${closedKeys.length} slot(s) closed`);

  if (hasSlots) {
    const timeSince = Date.now() - s.lastAlertTime;
    const isNew = newKeys.length > 0;
    const isDue = timeSince >= CONFIG.repeatAlertMs;
    if (isNew || isDue) {
      s.lastAlertTime = Date.now();
      await triggerAlert(loc, Array.isArray(slots) ? slots : [...currentKeys], !isNew);
    }
  }

  s.previousSlotKeys = currentKeys;
  return { name: loc.name, count: currentKeys.size };
}

async function checkAll() {
  if (checking) return; // never overlap polls (prevents zombie Chromium launches)
  checking = true;
  checkCount++;
  const summary = [];
  let anyError = false;

  try {
    for (const loc of LOCATIONS) {
      try {
        const result = await checkLocation(loc);
        summary.push(result.count > 0 ? `✅ ${result.name} (${result.count})` : `⏳ ${result.name}`);
      } catch (err) {
        anyError = true;
        summary.push(`⚠️ ${loc.name}`);
        log(`⚠️  ${loc.name} error: ${err.message.split('\n')[0]}`);
        // Properly close — do NOT just null (that left zombie Chromium processes)
        if (useBrowser) await closeBrowser();
      }
    }

    if (anyError) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        log('🔴 5 consecutive errors — pausing 2 minutes and closing browser...');
        await closeBrowser();
        await new Promise(r => setTimeout(r, 120_000));
        consecutiveErrors = 0;
      }
    } else {
      consecutiveErrors = 0;
    }

    const mode = useBrowser ? 'browser' : 'http';
    process.stdout.write(`\r[${nowStr()}] #${checkCount} [${mode}] — ${summary.join(' | ')}${' '.repeat(8)}`);
  } finally {
    checking = false;
  }
}

async function main() {
  console.clear();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      CHROME HEARTS — MULTI-LOCATION SLOT MONITOR        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  LOCATIONS.forEach(l => console.log(`  📍 ${l.name}`));
  console.log(`  Polling : every ${CONFIG.pollIntervalMs / 1000}s  |  Look-ahead: ${CONFIG.lookAheadDays} days`);
  console.log(`  Mode    : lightweight HTTPS (Playwright only if WAF blocks)`);
  console.log(`  Telegram: ${TELEGRAM_CHAT_IDS.length} recipient(s): ${TELEGRAM_CHAT_IDS.join(', ')}`);
  console.log('──────────────────────────────────────────────────────────\n');

  log(`Monitor started — watching ${LOCATIONS.map(l => l.id).join(', ')}`);

  // Probe once: prefer direct HTTPS so we never start Chromium unless needed
  try {
    const probe = await fetchJsonDirect(
      `${BASE}/${LOCATIONS[0].id}/first-available-slots` +
      `?fromDate=${encodeURIComponent(isoDatetime(0))}&toDate=${encodeURIComponent(isoDatetime(7))}&maxNumSlots=1`
    );
    log(`✅ Direct HTTPS works (${Array.isArray(probe) ? probe.length : 0} slots in probe) — no Chromium needed`);
  } catch (err) {
    if (err.blocked) {
      useBrowser = true;
      log('⚠️  Direct HTTPS blocked — starting Playwright...');
      await ensureBrowserContext();
      log('Browser ready');
    } else {
      log(`⚠️  Probe failed (${err.message}) — will retry each poll`);
    }
  }

  await sendTelegram(
    `✅ <b>Monitor restarted</b> (memory fix)\n\n` +
    LOCATIONS.map(l => `📍 <b>${l.name}</b>\n👉 <a href="${l.bookingUrl}">Book</a>`).join('\n\n') +
    `\n\n🕐 Checking every ${CONFIG.pollIntervalMs / 1000}s`
  );

  await checkAll();
  setInterval(checkAll, CONFIG.pollIntervalMs);

  // Safety: if somehow using browser, recycle on a timer
  setInterval(async () => {
    if (useBrowser && browser) {
      log('♻️  Scheduled browser recycle');
      await closeBrowser();
    }
  }, CONFIG.browserRecycleMs);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
