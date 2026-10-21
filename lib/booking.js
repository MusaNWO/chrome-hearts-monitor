/**
 * Book a Waitwhile public appointment with random guest details.
 */
const {
  getLocation,
  apiPost,
  pickServiceId,
  manageUrl,
} = require('./waitwhile');
const { getRecaptchaToken } = require('./captcha');
const { randomGuest } = require('./guest');

const inFlight = new Map(); // slotKey -> Promise
const bookedKeys = new Set();

function slotKey(locationId, date) {
  return `${locationId}|${date}`;
}

/**
 * @param {object} opts
 * @param {string} opts.locationId - Waitwhile shortName (e.g. chromeheartsmiami)
 * @param {object} opts.slot - slot object from first-available-slots
 * @param {boolean} [opts.dryRun]
 */
async function bookSlot({ locationId, slot, dryRun = false, guest = null }) {
  const key = slotKey(locationId, slot.date);
  if (bookedKeys.has(key)) {
    return { ok: false, error: 'Already booked this slot in this session', key };
  }
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const work = (async () => {
    const location = await getLocation(locationId);
    const serviceId = pickServiceId(slot, location);
    const person = guest || randomGuest();

    const payload = {
      state: 'BOOKED',
      firstName: person.firstName,
      lastName: person.lastName,
      name: person.name,
      email: person.email,
      phone: person.phone,
      partySize: person.partySize || 1,
      serviceIds: serviceId ? [serviceId] : [],
      date: slot.date,
      duration: slot.duration || 3600,
    };

    if (dryRun || process.env.DRY_RUN === '1') {
      const fakeId = `dry_${Date.now().toString(36)}`;
      const visit = {
        id: fakeId,
        publicId: fakeId.slice(0, 8),
        state: 'BOOKED',
        ...payload,
        dryRun: true,
      };
      bookedKeys.add(key);
      return {
        ok: true,
        dryRun: true,
        visit,
        guest: person,
        serviceId,
        serviceName: location.servicesById?.[serviceId]?.name || serviceId,
        store: location.displayName || location.name || locationId,
        date: slot.date,
        manageUrl: manageUrl(locationId, visit),
        status: 'BOOKED (dry-run)',
      };
    }

    const { token, source } = await getRecaptchaToken();
    if (!token) throw new Error('Could not obtain reCAPTCHA token');

    const res = await apiPost(`/visits/${locationId}`, payload, { recaptchaToken: token });
    if (!res.ok) {
      const msg = res.body?.message || JSON.stringify(res.body);
      return {
        ok: false,
        statusCode: res.status,
        error: msg,
        captchaSource: source,
        guest: person,
        payload,
      };
    }

    const visit = res.body;
    bookedKeys.add(key);
    return {
      ok: true,
      dryRun: false,
      visit,
      guest: person,
      serviceId,
      serviceName: location.servicesById?.[serviceId]?.name || serviceId,
      store: location.displayName || location.name || locationId,
      date: slot.date,
      manageUrl: manageUrl(locationId, visit),
      status: visit.state || 'BOOKED',
      captchaSource: source,
    };
  })();

  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

function formatWallClock(isoLocal) {
  // Waitwhile returns location-local wall times without timezone, e.g. "2026-10-22T13:00"
  const m = String(isoLocal).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return { dateStr: isoLocal, timeStr: '' };
  const [, y, mo, d, h, mi] = m;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // Day-of-week from calendar date (UTC noon avoids DST edge cases)
  const dow = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 12)).getUTCDay();
  let hour = Number(h);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return {
    dateStr: `${weekdays[dow]}, ${months[Number(mo) - 1]} ${Number(d)}, ${y}`,
    timeStr: `${hour}:${mi} ${ampm} (store local time)`,
  };
}

function formatBookingResult(result) {
  if (!result.ok) {
    return [
      '❌ BOOKING FAILED',
      `Error: ${result.error}`,
      result.statusCode ? `HTTP: ${result.statusCode}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const { dateStr, timeStr } = formatWallClock(result.date);

  return [
    result.dryRun ? '🧪 DRY-RUN BOOKING (not real)' : '✅ BOOKED',
    `Store: ${result.store}`,
    `Date: ${dateStr}`,
    `Time: ${timeStr}`,
    `Status: ${result.status}`,
    `Guest (temp): ${result.guest.name} / ${result.guest.email} / ${result.guest.phone}`,
    `Service: ${result.serviceName}`,
    `Manage: ${result.manageUrl}`,
  ].join('\n');
}

module.exports = {
  bookSlot,
  slotKey,
  bookedKeys,
  formatBookingResult,
};
