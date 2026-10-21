#!/usr/bin/env node
/**
 * Chrome Hearts Monitor V2 — Telegram (@CHM2_bot)
 *
 * Loads .env.v2 only — does NOT touch the old bot (.env / Railway master).
 *
 * - Alerts with BOOK inline button
 * - BOOK → BOOKING… → books slot → sends manage URL
 * - Auto-book Sun/Wed/Thu/Fri @ 11/12/1 store-local hours
 *
 * Usage:
 *   node monitor-v2.js
 *   DRY_RUN=1 node monitor-v2.js
 *   LOCATION_IDS=lasvegas-fontaine node monitor-v2.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env.v2') });

const {
  getAvailableSlots,
  close: closeWaitwhile,
} = require('./lib/waitwhile');
const { bookSlot, bookedKeys, formatBookingResult, slotKey } = require('./lib/booking');
const { isAutoBookSlot } = require('./lib/autobook');
const tg = require('./lib/telegram');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!TOKEN || !CHAT_IDS.length) {
  console.error('❌  Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env.v2');
  process.exit(1);
}

tg.configure({ token: TOKEN, chatIds: CHAT_IDS });

const RAW_IDS = (process.env.LOCATION_IDS || 'chromeheartsmiami,chromehearts')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const LOCATION_NAMES = {
  chromeheartsmiami: 'Chrome Hearts Miami',
  'lasvegas-fontaine': 'Chrome Hearts Las Vegas',
  chromehearts: 'Chrome Hearts New York West Village',
};

const LOCATIONS = RAW_IDS.map((id) => ({
  id,
  name: LOCATION_NAMES[id] || id,
}));

const CONFIG = {
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 30_000,
  lookAheadDays: Number(process.env.LOOK_AHEAD_DAYS) || 60,
  dryRun: process.env.DRY_RUN === '1',
  autoBook: process.env.AUTO_BOOK_ENABLED !== '0',
  repeatAlertMs: 5 * 60 * 1000,
};

const state = {};
for (const loc of LOCATIONS) {
  state[loc.id] = { previousKeys: new Set(), lastAlertAt: 0 };
}

/** shortId -> { locationId, slot, loc } */
const pendingBooks = new Map();
const bookingCallbacks = new Set(); // message keys already set to BOOKING…

let checking = false;
let checkCount = 0;
let shortCounter = 0;

function pad(n) {
  return String(n).padStart(2, '0');
}
function nowStr() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function log(msg) {
  console.log(`[${nowStr()}] ${msg}`);
}
function isoDatetime(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00`;
}
function formatSlot(slot) {
  const m = String(slot.date).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return slot.date;
  const [, y, mo, d, h, mi] = m;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 12)).getUTCDay();
  let hour = Number(h);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${weekdays[dow]}, ${months[Number(mo) - 1]} ${Number(d)} · ${hour}:${mi} ${ampm}`;
}

function nextShortId() {
  shortCounter = (shortCounter + 1) % 1_000_000;
  return `b${shortCounter.toString(36)}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendBookingResult(result, reason) {
  const text = formatBookingResult(result);
  // Telegram HTML: escape manage URL as link
  let html = escapeHtml(text);
  if (result.ok && result.manageUrl) {
    html = html.replace(
      escapeHtml(`Manage: ${result.manageUrl}`),
      `Manage: <a href="${result.manageUrl}">${escapeHtml(result.manageUrl)}</a>`
    );
  }
  const header = reason === 'AUTO' ? '🤖 <b>AUTO-BOOKED</b>\n\n' : '';
  await tg.sendAll(header + html);
  log(`Telegram: sent booking result (${reason}) ok=${result.ok}`);
}

async function doBook(loc, slot, reason) {
  const key = slotKey(loc.id, slot.date);
  if (bookedKeys.has(key)) {
    log(`skip already booked: ${loc.name} ${slot.date}`);
    return { ok: false, error: 'already booked' };
  }
  log(`BOOKING (${reason}): ${loc.name} @ ${formatSlot(slot)}`);
  try {
    const result = await bookSlot({
      locationId: loc.id,
      slot,
      dryRun: CONFIG.dryRun,
    });
    console.log('\n' + formatBookingResult(result) + '\n');
    await sendBookingResult(result, reason);
    return result;
  } catch (err) {
    log(`Booking error: ${err.message}`);
    await tg.sendAll(`❌ Booking error at <b>${escapeHtml(loc.name)}</b>\n${escapeHtml(err.message)}`);
    return { ok: false, error: err.message };
  }
}

async function sendManualAlert(loc, slot) {
  const shortId = nextShortId();
  pendingBooks.set(shortId, { loc, slot, locationId: loc.id });

  // Expire pending after 30 min
  setTimeout(() => pendingBooks.delete(shortId), 30 * 60 * 1000);

  const text = [
    `🚨 <b>SLOT OPEN — Book now</b>`,
    ``,
    `📍 <b>${escapeHtml(loc.name)}</b>`,
    `🕐 ${escapeHtml(formatSlot(slot))}`,
    ``,
    `Tap <b>BOOK</b> to reserve with temporary details.`,
    `You'll get the manage link after booking.`,
  ].join('\n');

  const results = await tg.sendAlertWithBookButton({
    text,
    callbackData: `book:${shortId}`,
    buttonLabel: 'BOOK',
  });

  const ok = results.some((r) => r.ok);
  log(`Telegram alert ${loc.name} ${slot.date} shortId=${shortId} ok=${ok}`);
  return shortId;
}

async function handleCallback(cq) {
  const { id, data, chatId, messageId, messageText } = cq;

  if (data === 'noop' || data.startsWith('busy:')) {
    await tg.answerCallback(id, 'Already processing…');
    return;
  }

  if (!data.startsWith('book:')) {
    await tg.answerCallback(id, '');
    return;
  }

  const shortId = data.slice(5);
  const pending = pendingBooks.get(shortId);
  if (!pending) {
    await tg.answerCallback(id, 'This offer expired — wait for a new alert');
    await tg.editMessageMarkup(chatId, messageId, {
      inline_keyboard: [[{ text: 'EXPIRED', callback_data: 'noop' }]],
    });
    return;
  }

  const msgKey = `${chatId}:${messageId}`;
  if (bookingCallbacks.has(msgKey)) {
    await tg.answerCallback(id, 'Already booking…');
    return;
  }
  bookingCallbacks.add(msgKey);

  // Flip button to BOOKING…
  await tg.answerCallback(id, 'Booking…');
  await tg.editMessageMarkup(chatId, messageId, {
    inline_keyboard: [[{ text: 'BOOKING…', callback_data: 'busy:' + shortId }]],
  });

  const { loc, slot } = pending;
  const result = await doBook(loc, slot, 'MANUAL');

  if (result.ok) {
    pendingBooks.delete(shortId);
    await tg.editMessageMarkup(chatId, messageId, {
      inline_keyboard: [[{ text: 'BOOKED ✓', callback_data: 'noop' }]],
    });
    // Also update message text if possible
    const note = result.dryRun ? ' (dry-run)' : '';
    await tg.editMessageText(
      chatId,
      messageId,
      `${messageText || ''}\n\n✅ <b>BOOKED${note}</b>\nManage: <a href="${result.manageUrl}">open confirmation</a>`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'BOOKED ✓', callback_data: 'noop' }]],
        },
      }
    ).catch(() => {});
  } else {
    bookingCallbacks.delete(msgKey);
    await tg.editMessageMarkup(chatId, messageId, {
      inline_keyboard: [[{ text: 'BOOK', callback_data: `book:${shortId}` }]],
    });
    await tg.sendAll(
      `❌ Booking failed for <b>${escapeHtml(loc.name)}</b> ${escapeHtml(formatSlot(slot))}\n${escapeHtml(result.error || 'unknown')}`
    );
  }
}

async function checkLocation(loc) {
  const fromDate = isoDatetime(0);
  const toDate = isoDatetime(CONFIG.lookAheadDays);
  const slots = await getAvailableSlots(loc.id, {
    fromDate,
    toDate,
    maxNumSlots: 20,
  });

  const s = state[loc.id];
  const currentKeys = new Set((slots || []).map((sl) => sl.date));

  const auto = [];
  const manual = [];
  for (const slot of slots || []) {
    if (bookedKeys.has(slotKey(loc.id, slot.date))) continue;
    if (CONFIG.autoBook && isAutoBookSlot(slot)) auto.push(slot);
    else manual.push(slot);
  }

  // Auto-book every matching slot (once)
  for (const slot of auto) {
    if (!bookedKeys.has(slotKey(loc.id, slot.date))) {
      await doBook(loc, slot, 'AUTO');
    }
  }

  // Manual alerts for newly seen non-auto slots
  const newManual = manual.filter((sl) => !s.previousKeys.has(sl.date));
  const timeSince = Date.now() - s.lastAlertAt;
  const shouldRemind = manual.length > 0 && timeSince >= CONFIG.repeatAlertMs;

  if (newManual.length) {
    s.lastAlertAt = Date.now();
    // Cap alerts per check to avoid spam
    for (const slot of newManual.slice(0, 5)) {
      await sendManualAlert(loc, slot);
    }
  } else if (shouldRemind) {
    s.lastAlertAt = Date.now();
    for (const slot of manual.slice(0, 3)) {
      await sendManualAlert(loc, slot);
    }
  }

  s.previousKeys = currentKeys;
  return { loc, slots: slots || [], auto, manual };
}

async function checkAll() {
  if (checking) return;
  checking = true;
  checkCount++;
  try {
    const parts = [];
    for (const loc of LOCATIONS) {
      try {
        const r = await checkLocation(loc);
        parts.push(
          r.slots.length ? `✅ ${r.loc.name} (${r.slots.length})` : `⏳ ${r.loc.name}`
        );
      } catch (err) {
        parts.push(`⚠️ ${loc.name}`);
        log(`${loc.name}: ${err.message}`);
      }
    }
    process.stdout.write(`\r[${nowStr()}] #${checkCount} — ${parts.join(' | ')}${' '.repeat(8)}`);
  } finally {
    checking = false;
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     CHROME HEARTS MONITOR V2 — @CHM2_bot                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  LOCATIONS.forEach((l) => console.log(`  📍 ${l.name}`));
  console.log(`  Polling   : every ${CONFIG.pollIntervalMs / 1000}s`);
  console.log(`  Auto-book : ${CONFIG.autoBook ? 'ON (Sun/Wed/Thu/Fri @ 11/12/1)' : 'OFF'}`);
  console.log(`  Dry-run   : ${CONFIG.dryRun ? 'YES' : 'NO'}`);
  console.log(`  Telegram  : ${CHAT_IDS.join(', ')}`);
  console.log(`  Config    : .env.v2 (old bot untouched)`);
  console.log('──────────────────────────────────────────────────────────\n');

  await tg.sendAll(
    [
      '✅ <b>Monitor V2 started</b> (@CHM2_bot)',
      '',
      ...LOCATIONS.map((l) => `📍 ${escapeHtml(l.name)}`),
      '',
      `Auto-book: ${CONFIG.autoBook ? 'ON' : 'OFF'} (Sun/Wed/Thu/Fri · 11/12/1)`,
      `Mode: ${CONFIG.dryRun ? 'DRY-RUN' : 'LIVE'}`,
      '',
      'You will get alerts with a <b>BOOK</b> button.',
      'Matching auto-book slots are reserved automatically.',
    ].join('\n')
  );

  // Start callback poller (non-blocking loop)
  tg.startPolling(handleCallback, log).catch((e) => log(`Poller stopped: ${e.message}`));

  await checkAll();
  setInterval(checkAll, CONFIG.pollIntervalMs);

  process.on('SIGINT', async () => {
    console.log('\nShutting down V2...');
    tg.stopPolling();
    await closeWaitwhile();
    process.exit(0);
  });
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  await closeWaitwhile();
  process.exit(1);
});
