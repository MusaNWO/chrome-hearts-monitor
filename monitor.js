#!/usr/bin/env node
/**
 * Chrome Hearts Appointment Monitor — LOCAL TEST MODE
 * (No Telegram / No Railway)
 *
 * - Polls Miami + NY (configurable)
 * - Auto-books matching Sun/Wed/Thu/Fri @ 11/12/1 ET slots
 * - Prints BOOK prompts for other slots; type the number to book
 *
 * Usage:
 *   node monitor.js
 *   DRY_RUN=1 node monitor.js          # simulate bookings
 *   AUTO_BOOK_ENABLED=0 node monitor.js
 *   LOCATION_IDS=lasvegas-fontaine node monitor.js   # easier to test (has slots)
 */
require('dotenv').config();
const readline = require('readline');
const {
  getAvailableSlots,
  close: closeWaitwhile,
} = require('./lib/waitwhile');
const { bookSlot, bookedKeys, formatBookingResult } = require('./lib/booking');
const { isAutoBookSlot } = require('./lib/autobook');

const RAW_IDS = (process.env.LOCATION_IDS || 'chromeheartsmiami,chromehearts')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const LOCATION_NAMES = {
  chromeheartsmiami: 'Chrome Hearts Miami',
  'lasvegas-fontaine': 'Chrome Hearts Las Vegas',
  'chromehearts-newyork': 'Chrome Hearts New York',
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
};

const state = {};
for (const loc of LOCATIONS) {
  state[loc.id] = { previousKeys: new Set() };
}

/** Pending manual book options shown in console: number -> { loc, slot } */
let pendingMenu = [];
let checking = false;
let checkCount = 0;

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
  return `${weekdays[dow]}, ${months[Number(mo) - 1]} ${Number(d)} ${hour}:${mi} ${ampm}`;
}

async function doBook(loc, slot, reason) {
  const key = `${loc.id}|${slot.date}`;
  if (bookedKeys.has(key)) {
    log(`skip already booked: ${loc.name} ${slot.date}`);
    return;
  }
  log(`BOOKING (${reason}): ${loc.name} @ ${formatSlot(slot)} ...`);
  try {
    const result = await bookSlot({
      locationId: loc.id,
      slot,
      dryRun: CONFIG.dryRun,
    });
    console.log('\n' + formatBookingResult(result) + '\n');
    if (!result.ok) {
      log(`Tip: set CAPSOLVER_API_KEY for reliable reCAPTCHA, or DRY_RUN=1 to simulate.`);
    }
  } catch (err) {
    log(`Booking error: ${err.message}`);
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
  const newSlots = (slots || []).filter((sl) => !s.previousKeys.has(sl.date));

  const auto = [];
  const manual = [];
  for (const slot of slots || []) {
    if (bookedKeys.has(`${loc.id}|${slot.date}`)) continue;
    if (CONFIG.autoBook && isAutoBookSlot(slot)) auto.push(slot);
    else manual.push(slot);
  }

  // Auto-book every matching slot
  for (const slot of auto) {
    const isNew = !s.previousKeys.has(slot.date);
    if (isNew || !bookedKeys.has(`${loc.id}|${slot.date}`)) {
      // Only attempt once per slot key (bookSlot dedupes)
      if (!bookedKeys.has(`${loc.id}|${slot.date}`)) {
        await doBook(loc, slot, 'AUTO');
      }
    }
  }

  s.previousKeys = currentKeys;
  return { loc, slots: slots || [], newSlots, auto, manual };
}

async function checkAll() {
  if (checking) return;
  checking = true;
  checkCount++;
  try {
    const results = [];
    for (const loc of LOCATIONS) {
      try {
        results.push(await checkLocation(loc));
      } catch (err) {
        log(`⚠️  ${loc.name}: ${err.message}`);
        results.push({ loc, slots: [], manual: [], auto: [], error: err.message });
      }
    }

    // Rebuild manual BOOK menu
    pendingMenu = [];
    for (const r of results) {
      for (const slot of r.manual || []) {
        if (bookedKeys.has(`${r.loc.id}|${slot.date}`)) continue;
        pendingMenu.push({ loc: r.loc, slot });
      }
    }

    const summary = results
      .map((r) => {
        if (r.error) return `⚠️ ${r.loc.name}`;
        return r.slots.length
          ? `✅ ${r.loc.name} (${r.slots.length})`
          : `⏳ ${r.loc.name}`;
      })
      .join(' | ');

    console.log(`\n[${nowStr()}] #${checkCount} — ${summary}`);

    if (pendingMenu.length) {
      console.log('── Manual BOOK (type number + Enter) ──');
      pendingMenu.slice(0, 15).forEach((item, i) => {
        const autoTag = isAutoBookSlot(item.slot) ? ' [auto-eligible]' : '';
        console.log(
          `  [${i + 1}] ${item.loc.name} — ${formatSlot(item.slot)}${autoTag}`
        );
      });
      if (pendingMenu.length > 15) {
        console.log(`  ... +${pendingMenu.length - 15} more`);
      }
      console.log('────────────────────────────────────────');
    }
  } finally {
    checking = false;
  }
}

function startInput() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', async (line) => {
    const n = Number(line.trim());
    if (!n || n < 1 || n > pendingMenu.length) {
      if (line.trim()) log('Enter a valid menu number to BOOK');
      return;
    }
    const item = pendingMenu[n - 1];
    console.log(`BOOKING… [${n}] ${item.loc.name} ${item.slot.date}`);
    await doBook(item.loc, item.slot, 'MANUAL');
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   CHROME HEARTS MONITOR — LOCAL (no Telegram)           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  LOCATIONS.forEach((l) => console.log(`  📍 ${l.name}`));
  console.log(`  Polling   : every ${CONFIG.pollIntervalMs / 1000}s`);
  console.log(`  Auto-book : ${CONFIG.autoBook ? 'ON (Sun/Wed/Thu/Fri @ 11/12/1 ET)' : 'OFF'}`);
  console.log(`  Dry-run   : ${CONFIG.dryRun ? 'YES' : 'NO'}`);
  console.log(`  Captcha   : ${process.env.CAPSOLVER_API_KEY ? 'CapSolver' : 'browser (may fail score)'}`);
  console.log('──────────────────────────────────────────────────────────');
  console.log('  Type a number from the menu to BOOK a slot.');
  console.log('  Ctrl+C to stop.\n');

  startInput();
  await checkAll();
  setInterval(checkAll, CONFIG.pollIntervalMs);

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await closeWaitwhile();
    process.exit(0);
  });
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  await closeWaitwhile();
  process.exit(1);
});
