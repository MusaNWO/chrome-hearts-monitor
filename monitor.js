#!/usr/bin/env node
require('dotenv').config();

/**
 * Chrome Hearts Appointment Slot Monitor — Multi-Location
 * Polls Waitwhile API every 30s via headless Chromium and sends
 * Telegram alerts the instant slots open at any watched location.
 */

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'your_bot_token_here') {
  console.error('❌  Missing TELEGRAM_BOT_TOKEN in .env'); process.exit(1);
}
if (!TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID === 'your_chat_id_here') {
  console.error('❌  Missing TELEGRAM_CHAT_ID in .env'); process.exit(1);
}

// Locations to monitor — comma-separated env var or defaults
const RAW_IDS = (process.env.LOCATION_IDS || 'chromeheartsmiami,chromehearts-newyork').split(',').map(s => s.trim());

// Friendly names for each location ID
const LOCATION_NAMES = {
  'chromeheartsmiami':      'Chrome Hearts Miami',
  'lasvegas-fontaine':      'Chrome Hearts Las Vegas',
  'chromehearts-newyork':   'Chrome Hearts New York',
  'chromehearts':           'Chrome Hearts New York West Village',
  'chromeheartswestvillage':'Chrome Hearts West Village',
};

const LOCATIONS = RAW_IDS.map(id => ({
  id,
  name: LOCATION_NAMES[id] || id,
  bookingUrl: `https://waitwhile.com/locations/${id}/time?registration=booking`,
}));

const CONFIG = {
  pollIntervalMs: 30_000,
  lookAheadDays: 60,
  logFile: path.join(__dirname, 'monitor.log'),
  repeatAlertMs: 5 * 60 * 1000,
};

const BASE = 'https://api.waitwhile.com/v2/public/visits';

// ─── Per-location state ────────────────────────────────────────────────────────
const state = {};
for (const loc of LOCATIONS) {
  state[loc.id] = { previousSlotKeys: new Set(), lastAlertTime: 0 };
}

let checkCount = 0;
let consecutiveErrors = 0;
let browserContext = null;

// ─── Helpers ───────────────────────────────────────────────────────────────────
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
  fs.appendFileSync(CONFIG.logFile, line + '\n');
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
function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
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
          if (!json.ok) log(`⚠️  Telegram error: ${JSON.stringify(json)}`);
          resolve(json);
        } catch { resolve(null); }
      });
    });
    req.on('error', e => { log(`⚠️  Telegram send failed: ${e.message}`); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Alert ─────────────────────────────────────────────────────────────────────
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

// ─── Browser ───────────────────────────────────────────────────────────────────
async function ensureBrowserContext() {
  if (browserContext) return browserContext;
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  browserContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9', 'Origin': 'https://waitwhile.com', 'Referer': 'https://waitwhile.com/' },
  });
  browser.on('disconnected', () => { browserContext = null; });
  return browserContext;
}

async function apiGet(url) {
  const ctx = await ensureBrowserContext();
  const res = await ctx.request.get(url, { headers: { 'Accept': 'application/json, text/plain, */*' }, timeout: 15_000 });
  if (!res.ok()) throw new Error(`HTTP ${res.status()} — ${(await res.text()).substring(0, 200)}`);
  return res.json();
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

// ─── Main poll ─────────────────────────────────────────────────────────────────
async function checkAll() {
  checkCount++;
  const summary = [];

  try {
    for (const loc of LOCATIONS) {
      try {
        const result = await checkLocation(loc);
        summary.push(result.count > 0 ? `✅ ${result.name} (${result.count})` : `⏳ ${result.name}`);
      } catch (err) {
        summary.push(`⚠️ ${loc.name}`);
        log(`⚠️  ${loc.name} error: ${err.message}`);
        browserContext = null;
      }
    }
    consecutiveErrors = 0;
    process.stdout.write(`\r[${nowStr()}] #${checkCount} — ${summary.join(' | ')}${' '.repeat(10)}`);
  } catch (err) {
    consecutiveErrors++;
    log(`⚠️  Check #${checkCount} fatal error: ${err.message}`);
    browserContext = null;
    if (consecutiveErrors >= 5) {
      log('🔴 5 errors in a row — pausing 2 minutes...');
      await new Promise(r => setTimeout(r, 120_000));
      consecutiveErrors = 0;
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      CHROME HEARTS — MULTI-LOCATION SLOT MONITOR        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  LOCATIONS.forEach(l => console.log(`  📍 ${l.name}`));
  console.log(`  Polling : every ${CONFIG.pollIntervalMs / 1000}s  |  Look-ahead: ${CONFIG.lookAheadDays} days`);
  console.log(`  Telegram: chat ${TELEGRAM_CHAT_ID}`);
  console.log('──────────────────────────────────────────────────────────\n');

  log(`Monitor started — watching ${LOCATIONS.map(l => l.id).join(', ')}`);

  await ensureBrowserContext();
  log('Browser ready.\n');

  await sendTelegram(
    `✅ <b>Monitor started</b>\n\n` +
    LOCATIONS.map(l => `📍 <b>${l.name}</b>\n👉 <a href="${l.bookingUrl}">Book</a>`).join('\n\n') +
    `\n\n🕐 Checking every 30s — you'll be alerted the instant a slot opens.`
  );

  await checkAll();
  setInterval(checkAll, CONFIG.pollIntervalMs);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
