#!/usr/bin/env node
/**
 * Local poller: Miami + NY only. Books the first open slot that appears.
 * No Telegram / no Railway / no Las Vegas.
 *
 *   HEADED=1 node scripts/local-watch-book.js
 *   HEADED=1 POLL_SECONDS=20 node scripts/local-watch-book.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

process.env.HEADED = process.env.HEADED || '1';

const { getAvailableSlots, close } = require('../lib/waitwhile');
const { bookSlot, formatBookingResult, bookedKeys } = require('../lib/booking');

const LOCATIONS = [
  { id: 'chromeheartsmiami', name: 'Chrome Hearts Miami' },
  { id: 'chromehearts', name: 'Chrome Hearts New York West Village' },
];

const POLL_MS = (Number(process.env.POLL_SECONDS) || 30) * 1000;

function pad(n) {
  return String(n).padStart(2, '0');
}
function nowStr() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function iso(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00`;
}
function log(msg) {
  console.log(`[${nowStr()}] ${msg}`);
}

let checking = false;
let stop = false;
let bookedOnce = false;

async function checkOnce() {
  if (checking || stop || bookedOnce) return;
  checking = true;
  const parts = [];
  try {
    for (const loc of LOCATIONS) {
      try {
        const slots = await getAvailableSlots(loc.id, {
          fromDate: iso(0),
          toDate: iso(60),
          maxNumSlots: 20,
        });
        parts.push(slots.length ? `✅ ${loc.name} (${slots.length})` : `⏳ ${loc.name}`);

        for (const slot of slots) {
          const key = `${loc.id}|${slot.date}`;
          if (bookedKeys.has(key)) continue;

          log(`SLOT FOUND — booking ${loc.name} @ ${slot.date}`);
          const result = await bookSlot({
            locationId: loc.id,
            slot,
            dryRun: process.env.DRY_RUN === '1',
          });
          console.log('\n' + formatBookingResult(result) + '\n');

          if (result.ok) {
            bookedOnce = true;
            stop = true;
            log('Success — stopping watcher. Manage link is above.');
            return;
          }
          log(`Book failed (${result.error}) — will keep watching`);
        }
      } catch (err) {
        parts.push(`⚠️ ${loc.name}`);
        log(`${loc.name}: ${err.message}`);
      }
    }
    process.stdout.write(`\r[${nowStr()}] ${parts.join(' | ')}${' '.repeat(10)}`);
  } finally {
    checking = false;
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  LOCAL WATCH → book first Miami / NY slot       ║');
  console.log('╚══════════════════════════════════════════════════╝');
  LOCATIONS.forEach((l) => console.log(`  📍 ${l.name}`));
  console.log(`  Poll every ${POLL_MS / 1000}s · HEADED=${process.env.HEADED} · DRY_RUN=${process.env.DRY_RUN === '1' ? '1' : '0'}`);
  console.log('  Ctrl+C to stop\n');

  await checkOnce();
  const timer = setInterval(() => {
    if (stop) {
      clearInterval(timer);
      close().then(() => process.exit(bookedOnce ? 0 : 0));
      return;
    }
    checkOnce().catch((e) => log(e.message));
  }, POLL_MS);

  process.on('SIGINT', async () => {
    console.log('\nStopping…');
    stop = true;
    clearInterval(timer);
    await close();
    process.exit(0);
  });
}

main().catch(async (e) => {
  console.error(e);
  await close();
  process.exit(1);
});
