/**
 * Auto-Book rules:
 * Days: Sunday, Wednesday, Thursday, Friday (America/New_York)
 * Times: 11:00, 12:00, 13:00 ET
 */

const DEFAULT_DAYS = (process.env.AUTO_BOOK_DAYS || '0,3,4,5')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => !Number.isNaN(n));
// 0=Sun ... 6=Sat

const DEFAULT_HOURS = (process.env.AUTO_BOOK_HOURS_ET || '11,12,13')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => !Number.isNaN(n));

function etParts(isoLocal) {
  // Waitwhile dates are location-local wall times without Z, e.g. "2026-10-22T11:00"
  // For Chrome Hearts NY/Miami those are America/New_York.
  // For Las Vegas they are America/Los_Angeles — auto-book rules are defined in ET,
  // so we interpret the slot's clock time as ET hours for matching (per product rules).
  const m = String(isoLocal).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  // Day-of-week for that calendar date in ET: construct as UTC noon of that Y-M-D then format in ET
  const probe = new Date(Date.UTC(y, mo - 1, d, 16, 0, 0)); // ~noon ET
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(probe);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { year: y, month: mo, day: d, hour: h, minute: mi, weekday: map[weekday] };
}

function isAutoBookSlot(slot, { days = DEFAULT_DAYS, hours = DEFAULT_HOURS } = {}) {
  if (process.env.AUTO_BOOK_ENABLED === '0') return false;
  const parts = etParts(slot.date);
  if (!parts) return false;
  if (!days.includes(parts.weekday)) return false;
  if (!hours.includes(parts.hour)) return false;
  // Prefer exact :00 starts; still allow if Waitwhile uses other minutes for those hours
  return true;
}

function filterAutoBookSlots(slots) {
  return (slots || []).filter((s) => isAutoBookSlot(s));
}

module.exports = {
  isAutoBookSlot,
  filterAutoBookSlots,
  DEFAULT_DAYS,
  DEFAULT_HOURS,
};
