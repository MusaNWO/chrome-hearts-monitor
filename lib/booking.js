/**
 * Book a Waitwhile public appointment with random guest details.
 * Captcha + POST happen in the SAME browser page (required for Waitwhile to accept tokens).
 */
const {
  getApiPage,
  pickServiceId,
  manageUrl,
  API,
  RECAPTCHA_SITE_KEY,
} = require('./waitwhile');
const { randomGuest } = require('./guest');

const ACTION = 'PUB_CREATE_VISIT';
const inFlight = new Map();
const bookedKeys = new Set();

function slotKey(locationId, date) {
  return `${locationId}|${date}`;
}

async function getRecaptchaOnPage(page) {
  const hasRender = await page.evaluate(
    () => !!document.querySelector('script[src*="recaptcha/api.js?render="]')
  );
  if (!hasRender) {
    await page.addScriptTag({
      url: `https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`,
    });
    await page.waitForTimeout(2500);
  }
  await page.waitForFunction(() => window.grecaptcha && window.grecaptcha.execute, {
    timeout: 25_000,
  });
  const token = await page.evaluate(
    async ({ siteKey, action }) => {
      await new Promise((r) => grecaptcha.ready(r));
      return grecaptcha.execute(siteKey, { action });
    },
    { siteKey: RECAPTCHA_SITE_KEY, action: ACTION }
  );
  if (!token) throw new Error('grecaptcha.execute returned empty token');
  return token;
}

/**
 * @param {object} opts
 * @param {string} opts.locationId
 * @param {object} opts.slot
 * @param {boolean} [opts.dryRun]
 * @param {object} [opts.guest]
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
    let person = guest || randomGuest();
    const pageUrl = `https://waitwhile.com/locations/${locationId}?registration=booking`;

    const page = await getApiPage(pageUrl);
    // Light humanization
    await page.mouse.move(100 + Math.random() * 200, 140 + Math.random() * 120);
    await page.waitForTimeout(400);
    await page.mouse.move(320 + Math.random() * 180, 300 + Math.random() * 100);
    await page.evaluate(() => window.scrollBy(0, 200));
    await page.waitForTimeout(600);

    const locRes = await page.request.get(`${API}/locations/${locationId}`, {
      headers: { Accept: 'application/json' },
    });
    if (!locRes.ok()) {
      throw new Error(`location HTTP ${locRes.status()} ${(await locRes.text()).slice(0, 150)}`);
    }
    const location = await locRes.json();
    const serviceId = pickServiceId(slot, location);

    const buildPayload = (p) => ({
      state: 'BOOKED',
      firstName: p.firstName,
      lastName: p.lastName,
      name: p.name,
      email: p.email,
      phone: p.phone,
      partySize: p.partySize || 1,
      serviceIds: serviceId ? [serviceId] : [],
      date: slot.date,
      duration: slot.duration || 3600,
    });

    if (dryRun || process.env.DRY_RUN === '1') {
      const payload = buildPayload(person);
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

    let lastFail = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0 && !guest) person = randomGuest();
      const payload = buildPayload(person);

      let token;
      try {
        token = await getRecaptchaOnPage(page);
      } catch (err) {
        lastFail = { ok: false, error: `captcha: ${err.message}`, guest: person, payload };
        continue;
      }

      const postUrl = `${API}/visits/${locationId}?recaptcha=${encodeURIComponent(token)}`;
      const res = await page.request.post(postUrl, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: 'https://waitwhile.com',
          Referer: pageUrl,
        },
        data: payload,
        timeout: 30_000,
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 300) };
      }

      if (res.ok()) {
        const visit = body;
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
          captchaSource: 'browser-same-session',
          captchaAttempts: attempt + 1,
        };
      }

      const msg = body?.message || JSON.stringify(body);
      lastFail = {
        ok: false,
        statusCode: res.status(),
        error: msg,
        captchaSource: 'browser-same-session',
        guest: person,
        payload,
      };
      const retryable =
        (res.status() === 403 && /recaptcha|captcha/i.test(String(msg))) ||
        (res.status() === 400 && /phone/i.test(String(msg)));
      if (!retryable) return lastFail;
      await page.waitForTimeout(1500);
    }
    return lastFail;
  })();

  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

function formatWallClock(isoLocal) {
  const m = String(isoLocal).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return String(isoLocal);
  const [, y, mo, d, h, mi] = m;
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const weekdays = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const dow = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 12)).getUTCDay();
  let hour = Number(h);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return `${weekdays[dow]}, ${months[Number(mo) - 1]} ${Number(d)}, ${y} · ${hour}:${mi} ${ampm}`;
}

function formatBookingResult(result) {
  if (!result.ok) {
    return [
      '❌ BOOKING FAILED',
      `Error: ${result.error || 'unknown'}`,
      result.statusCode ? `HTTP: ${result.statusCode}` : '',
      result.captchaSource ? `Captcha: ${result.captchaSource}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    result.dryRun ? '🧪 DRY-RUN BOOKING (not real)' : '✅ BOOKED',
    `Store: ${result.store}`,
    `Date: ${formatWallClock(result.date)} (store local time)`,
    `Status: ${result.status}`,
    `Guest (temp): ${result.guest.name} / ${result.guest.email} / ${result.guest.phone}`,
    `Service: ${result.serviceName || result.serviceId || ''}`,
    `Manage: ${result.manageUrl}`,
  ].join('\n');
}

module.exports = {
  bookSlot,
  bookedKeys,
  formatBookingResult,
  slotKey,
};
