#!/usr/bin/env node
require('dotenv').config();

/**
 * Chrome Hearts Appointment Slot Monitor
 * Polls the Waitwhile API every 30 seconds and sends a Telegram
 * message the instant any appointment slot opens up.
 */

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LOCATION_ID = process.env.LOCATION_ID || 'chromeheartsmiami';

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'your_bot_token_here') {
  console.error('❌  Missing TELEGRAM_BOT_TOKEN in .env — see .env for setup instructions.');
  process.exit(1);
}
if (!TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID === 'your_chat_id_here') {
  console.error('❌  Missing TELEGRAM_CHAT_ID in .env — see .env for setup instructions.');
  process.exit(1);
}

const CONFIG = {
  locationId: LOCATION_ID,
  bookingUrl: `https://waitwhile.com/locations/${LOCATION_ID}/time?registration=booking`,
  pollIntervalMs: 30_000,         // check every 30 seconds
  lookAheadDays: 60,              // scan this many days ahead
  logFile: path.join(__dirname, 'monitor.log'),
  repeatAlertMs: 5 * 60 * 1000,  // re-send Telegram message every 5 min while slots stay open
};

const BASE = 'https://api.waitwhile.com/v2/public/visits';

// ─── State ─────────────────────────────────────────────────────────────────────
let previousSlotKeys = new Set();
let checkCount = 0;
let lastAlertTime = 0;
let consecutiveErrors = 0;
let browserContext = null;

// ─── Helpers ───────────────────────────────────────────────────────────────────
function padTo2(n) { return String(n).padStart(2, '0'); }

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
    const d = new Date(slot);
    return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  if (slot && slot.date) {
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
        const json = JSON.parse(data);
        if (!json.ok) log(`⚠️  Telegram error: ${JSON.stringify(json)}`);
        resolve(json);
      });
    });
    req.on('error', (e) => { log(`⚠️  Telegram send failed: ${e.message}`); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Alert ─────────────────────────────────────────────────────────────────────
async function triggerAlert(slots, isRepeat = false) {
  const slotLines = slots
    .slice(0, 10)
    .map((s, i) => `  ${i + 1}. ${formatSlot(s)}`)
    .join('\n');

  const header = isRepeat
    ? `🔔 <b>REMINDER — Slots Still Open</b>`
    : `🚨 <b>SLOT OPENED — Book Now!</b>`;

  const msg = [
    header,
    `📍 Chrome Hearts (${CONFIG.locationId})`,
    ``,
    `<b>Available slots (${slots.length} total):</b>`,
    slotLines,
    slots.length > 10 ? `  ...and ${slots.length - 10} more` : '',
    ``,
    `👉 <a href="${CONFIG.bookingUrl}">Tap here to book</a>`,
    ``,
    `<i>Checked at ${new Date().toLocaleString()}</i>`,
  ].filter(l => l !== undefined).join('\n');

  log(isRepeat ? '🔔 Sending reminder...' : '🚨 ALERT — sending Telegram message!');
  await sendTelegram(msg);

  const border = '═'.repeat(62);
  fs.appendFileSync(CONFIG.logFile, [
    '', border,
    `  ${isRepeat ? 'REMINDER' : 'ALERT'} — ${new Date().toLocaleString()}`,
    `  ${slots.length} slot(s) available`,
    border, '',
  ].join('\n'));
}

// ─── Browser API Request ───────────────────────────────────────────────────────
async function ensureBrowserContext() {
  if (browserContext) return browserContext;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  browserContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://waitwhile.com',
      'Referer': `https://waitwhile.com/locations/${CONFIG.locationId}/time?registration=booking`,
    },
  });

  browser.on('disconnected', () => { browserContext = null; });
  return browserContext;
}

async function apiGet(url) {
  const ctx = await ensureBrowserContext();
  const res = await ctx.request.get(url, {
    headers: { 'Accept': 'application/json, text/plain, */*' },
    timeout: 15_000,
  });
  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status()} — ${body.substring(0, 200)}`);
  }
  return res.json();
}

// ─── Core Check ────────────────────────────────────────────────────────────────
async function checkSlots() {
  checkCount++;
  const fromDate = isoDatetime(0);
  const toDate = isoDatetime(CONFIG.lookAheadDays);

  try {
    const slots = await apiGet(
      `${BASE}/${CONFIG.locationId}/first-available-slots` +
      `?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}&maxNumSlots=10`
    );

    consecutiveErrors = 0;

    const currentSlotKeys = new Set(
      Array.isArray(slots)
        ? slots.map(s => typeof s === 'string' ? s : (s.date || JSON.stringify(s)))
        : []
    );

    const hasSlots = currentSlotKeys.size > 0;
    const newSlotKeys = [...currentSlotKeys].filter(k => !previousSlotKeys.has(k));
    const closedSlotKeys = [...previousSlotKeys].filter(k => !currentSlotKeys.has(k));

    if (closedSlotKeys.length > 0) {
      log(`ℹ️  ${closedSlotKeys.length} slot(s) just closed`);
    }

    if (hasSlots) {
      const timeSinceAlert = Date.now() - lastAlertTime;
      const isNew = newSlotKeys.length > 0;
      const isDue = timeSinceAlert >= CONFIG.repeatAlertMs;

      if (isNew || isDue) {
        lastAlertTime = Date.now();
        await triggerAlert(Array.isArray(slots) ? slots : [...currentSlotKeys], !isNew);
      } else {
        const minsLeft = Math.round((CONFIG.repeatAlertMs - timeSinceAlert) / 60000);
        process.stdout.write(`\r[${nowStr()}] ✅ ${currentSlotKeys.size} slot(s) open — next Telegram reminder in ${minsLeft}m${' '.repeat(10)}`);
      }
    } else {
      process.stdout.write(`\r[${nowStr()}] ⏳ No slots — check #${checkCount} — next in ${CONFIG.pollIntervalMs / 1000}s${' '.repeat(20)}`);
    }

    previousSlotKeys = currentSlotKeys;

  } catch (err) {
    consecutiveErrors++;
    log(`⚠️  Check #${checkCount} error (${consecutiveErrors} in a row): ${err.message}`);
    browserContext = null;

    if (consecutiveErrors >= 5) {
      log('🔴 5 consecutive errors — pausing 2 minutes...');
      await new Promise(r => setTimeout(r, 120_000));
      consecutiveErrors = 0;
    }
  }
}

// Deep scan: full slot-by-slot check (runs every 5 min, logs only)
async function deepScan() {
  try {
    const fromDate = isoDatetime(0);
    const toDate = isoDatetime(CONFIG.lookAheadDays);
    const data = await apiGet(
      `${BASE}/${CONFIG.locationId}/availability` +
      `?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`
    );
    const open = (data || []).filter(s => s.numAvailableSpots > 0);
    if (open.length > 0) {
      log(`🔍 Deep scan: ${open.length} slot(s) with availability`);
    }
  } catch (_) {}
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.clear();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        CHROME HEARTS — APPOINTMENT SLOT MONITOR         ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Location   : ${CONFIG.locationId}`);
  console.log(`  Polling    : every ${CONFIG.pollIntervalMs / 1000}s`);
  console.log(`  Look-ahead : ${CONFIG.lookAheadDays} days`);
  console.log(`  Telegram   : chat ${TELEGRAM_CHAT_ID}`);
  console.log(`  Log file   : ${CONFIG.logFile}`);
  console.log('──────────────────────────────────────────────────────────');
  console.log('  Telegram message fires the instant a slot opens.');
  console.log('  Reminder sent every 5 min while slots stay open.');
  console.log('──────────────────────────────────────────────────────────\n');

  log(`Monitor started — location: ${CONFIG.locationId}, polling every ${CONFIG.pollIntervalMs / 1000}s`);

  log('Launching browser context...');
  await ensureBrowserContext();
  log('Browser ready.\n');

  // Send a startup confirmation to Telegram
  await sendTelegram(
    `✅ <b>Monitor started</b>\n📍 Watching: ${CONFIG.locationId}\n🕐 Checking every 30s for the next ${CONFIG.lookAheadDays} days\n\nYou'll be notified the moment a slot opens.`
  );

  await deepScan();
  await checkSlots();

  setInterval(deepScan, 5 * 60 * 1000);
  setInterval(checkSlots, CONFIG.pollIntervalMs);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
