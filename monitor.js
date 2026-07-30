#!/usr/bin/env node
require('dotenv').config();

/**
 * Chrome Hearts Appointment Slot Monitor — Multi-Location
 * Lightweight HTTPS only (no Chromium) — stable on Railway.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === 'your_bot_token_here') {
  console.error('❌  Missing TELEGRAM_BOT_TOKEN'); process.exit(1);
}
if (TELEGRAM_CHAT_IDS.length === 0) {
  console.error('❌  Missing TELEGRAM_CHAT_ID'); process.exit(1);
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
  maxRetries: 3,
};

const BASE = 'https://api.waitwhile.com/v2/public/visits';

const state = {};
for (const loc of LOCATIONS) {
  state[loc.id] = { previousSlotKeys: new Set(), lastAlertTime: 0 };
}

let checkCount = 0;
let consecutiveErrors = 0;
let checking = false;
let lastHealthAlertAt = 0;

const padTo2 = n => String(n).padStart(2, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://waitwhile.com',
        'Referer': 'https://waitwhile.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // HTML 403 pages from WAF
        if (res.statusCode === 403 || res.statusCode === 401 || data.trimStart().startsWith('<!')) {
          return reject(new Error(`HTTP ${res.statusCode || 'blocked'} (WAF/forbidden)`));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} — ${data.substring(0, 160)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

async function apiGet(url) {
  let lastErr;
  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastErr = err;
      if (attempt < CONFIG.maxRetries) {
        await sleep(1000 * attempt); // 1s, 2s backoff
      }
    }
  }
  throw lastErr;
}

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
  if (checking) return;
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
        log(`⚠️  ${loc.name} error: ${err.message}`);
      }
    }

    if (anyError) {
      consecutiveErrors++;
      if (consecutiveErrors >= 10 && Date.now() - lastHealthAlertAt > 30 * 60 * 1000) {
        lastHealthAlertAt = Date.now();
        await sendTelegram(`⚠️ <b>Monitor health warning</b>\n${consecutiveErrors} consecutive failed checks.\nStill retrying every ${CONFIG.pollIntervalMs / 1000}s.`);
      }
      if (consecutiveErrors >= 5) {
        log('🔴 5 consecutive errors — backing off 90s...');
        await sleep(90_000);
        consecutiveErrors = 0;
      }
    } else {
      consecutiveErrors = 0;
    }

    process.stdout.write(`\r[${nowStr()}] #${checkCount} — ${summary.join(' | ')}${' '.repeat(8)}`);
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
  console.log(`  Mode    : HTTPS only (no Chromium — stable on Railway)`);
  console.log(`  Telegram: ${TELEGRAM_CHAT_IDS.length} recipient(s)`);
  console.log('──────────────────────────────────────────────────────────\n');

  log(`Monitor started — watching ${LOCATIONS.map(l => l.id).join(', ')}`);

  // Startup probe
  try {
    const probe = await apiGet(
      `${BASE}/${LOCATIONS[0].id}/first-available-slots` +
      `?fromDate=${encodeURIComponent(isoDatetime(0))}&toDate=${encodeURIComponent(isoDatetime(7))}&maxNumSlots=1`
    );
    log(`✅ API OK (probe returned ${Array.isArray(probe) ? probe.length : 0} slots)`);
  } catch (err) {
    log(`⚠️  Startup probe failed: ${err.message} — will keep retrying`);
  }

  await sendTelegram(
    `✅ <b>Monitor restarted</b>\n\n` +
    LOCATIONS.map(l => `📍 <b>${l.name}</b>\n👉 <a href="${l.bookingUrl}">Book</a>`).join('\n\n') +
    `\n\n🕐 Checking every ${CONFIG.pollIntervalMs / 1000}s (HTTPS, no browser)`
  );

  await checkAll();
  setInterval(checkAll, CONFIG.pollIntervalMs);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
