#!/usr/bin/env node
/**
 * One-shot book helper for local testing.
 *
 * Examples:
 *   DRY_RUN=1 node book.js --location lasvegas-fontaine
 *   node book.js --location lasvegas-fontaine --date 2026-10-22T15:00
 *   CAPSOLVER_API_KEY=xxx node book.js --location lasvegas-fontaine
 */
require('dotenv').config();
const {
  getAvailableSlots,
  close,
} = require('./lib/waitwhile');
const { bookSlot, formatBookingResult } = require('./lib/booking');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
function isoDatetime(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00`;
}

(async () => {
  const locationId = arg('location', process.env.LOCATION_ID || 'lasvegas-fontaine');
  const wantDate = arg('date', null);
  const dryRun = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

  console.log(`Fetching slots for ${locationId}...`);
  const slots = await getAvailableSlots(locationId, {
    fromDate: isoDatetime(0),
    toDate: isoDatetime(60),
    maxNumSlots: 20,
  });

  if (!slots.length) {
    console.error('No available slots.');
    await close();
    process.exit(1);
  }

  let slot = slots[0];
  if (wantDate) {
    slot = slots.find((s) => s.date === wantDate || s.date.startsWith(wantDate));
    if (!slot) {
      console.error(`Slot ${wantDate} not found. Available:`);
      slots.forEach((s) => console.log(' -', s.date));
      await close();
      process.exit(1);
    }
  }

  console.log(`Booking ${slot.date} (${slot.numAvailableSpots} spots)...`);
  const result = await bookSlot({ locationId, slot, dryRun });
  console.log('\n' + formatBookingResult(result));
  await close();
  process.exit(result.ok ? 0 : 2);
})().catch(async (e) => {
  console.error(e);
  await close();
  process.exit(1);
});
