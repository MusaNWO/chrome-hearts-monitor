/**
 * Book a Waitwhile public appointment with random guest details.
 * Captcha + POST happen in the SAME browser page (required for Waitwhile to accept tokens).
 * On Railway, CapSolver is used as a fallback when browser reCAPTCHA scores fail.
 */
const {
  getApiPage,
  pickServiceId,
  manageUrl,
  getDataFields,
  buildPublicDataFieldAnswers,
  resetSession,
  hasProxy,
  proxyStatus,
  acquireBookingLock,
  releaseBookingLock,
  waitForPollIdle,
  API,
  RECAPTCHA_SITE_KEY,
} = require('./waitwhile');
const { randomGuest } = require('./guest');
const { getRecaptchaToken } = require('./captcha');

const ACTION = 'PUB_CREATE_VISIT';
const inFlight = new Map();
const bookedKeys = new Set();

function slotKey(locationId, date) {
  return `${locationId}|${date}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
function isoDatetime(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00`;
}

/** Waitwhile durations are seconds; guard against minute-sized values. */
function normalizeDuration(raw, fallback = 3600) {
  let d = Number(raw);
  if (!Number.isFinite(d) || d <= 0) return fallback;
  // If someone passed minutes (e.g. 30 / 60), convert to seconds
  if (d > 0 && d <= 180) d = d * 60;
  return d;
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
  // Residential proxy still needs dwell + interaction for a usable v3 score
  try {
    await page.mouse.move(120 + Math.random() * 300, 160 + Math.random() * 220);
    await page.waitForTimeout(400);
    await page.mouse.move(280 + Math.random() * 260, 320 + Math.random() * 180);
    await page.evaluate(() => window.scrollBy(0, 120 + Math.floor(Math.random() * 180)));
  } catch (_) {}
  const dwell = hasProxy()
    ? 8000 + Math.floor(Math.random() * 3000)
    : process.env.RAILWAY_ENVIRONMENT
      ? 3500
      : 800;
  await page.waitForTimeout(dwell);
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

/** POST visit from inside the page so egress IP matches grecaptcha exactly. */
async function postVisitInPage(page, { locationId, token, payload, pageUrl }) {
  const url = `${API}/visits/${locationId}?recaptcha=${encodeURIComponent(token)}`;
  const result = await page.evaluate(
    async ({ url, payload, pageUrl }) => {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: 'https://waitwhile.com',
          Referer: pageUrl,
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text };
    },
    { url, payload, pageUrl }
  );
  let body;
  try {
    body = JSON.parse(result.text);
  } catch {
    body = { raw: String(result.text).slice(0, 300) };
  }
  return { ok: result.ok, status: result.status, body };
}

async function refreshSlot(page, locationId, date) {
  const q = new URLSearchParams({
    fromDate: isoDatetime(0),
    toDate: isoDatetime(60),
    maxNumSlots: '30',
  });
  const url = `${API}/visits/${locationId}/first-available-slots?${q}`;
  try {
    const res = await page.request.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 20_000,
    });
    if (!res.ok()) return null;
    const slots = await res.json();
    return (slots || []).find((s) => s.date === date) || null;
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (!/disposed|closed|Target/i.test(msg)) throw err;
    // Shared browser was recycled mid-request — reopen and retry once
    const pageUrl = `https://waitwhile.com/locations/${locationId}?registration=booking`;
    const freshPage = await getApiPage(pageUrl);
    const res = await freshPage.request.get(url, {
      headers: { Accept: 'application/json' },
      timeout: 20_000,
    });
    if (!res.ok()) return null;
    const slots = await res.json();
    return (slots || []).find((s) => s.date === date) || null;
  }
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
    acquireBookingLock();
    try {
    // Let the current poll finish so we own the browser/proxy session alone
    await waitForPollIdle();
    let person = guest || randomGuest();
    const pageUrl = `https://waitwhile.com/locations/${locationId}?registration=booking`;

    let page = await getApiPage(pageUrl);
    await page.mouse.move(100 + Math.random() * 200, 140 + Math.random() * 120);
    await page.waitForTimeout(400);
    await page.mouse.move(320 + Math.random() * 180, 300 + Math.random() * 100);
    await page.evaluate(() => window.scrollBy(0, 200));
    await page.waitForTimeout(process.env.RAILWAY_ENVIRONMENT ? 2000 : 600);

    // Re-check availability right before booking (slots go fast)
    const fresh = await refreshSlot(page, locationId, slot.date);
    if (!fresh || !(fresh.numAvailableSpots > 0)) {
      return {
        ok: false,
        statusCode: 400,
        error: `Slot ${slot.date} was taken before we could book — try another time`,
        guest: person,
      };
    }
    slot = fresh;

    const locRes = await page.request.get(`${API}/locations/${locationId}`, {
      headers: { Accept: 'application/json' },
    });
    if (!locRes.ok()) {
      throw new Error(`location HTTP ${locRes.status()} ${(await locRes.text()).slice(0, 150)}`);
    }
    const location = await locRes.json();
    const serviceId = pickServiceId(slot, location);
    if (!serviceId) {
      return { ok: false, error: 'No bookable service with open spots', guest: person };
    }
    const duration = normalizeDuration(slot.duration, 3600);

    // Chrome Hearts booking questionnaire (Yes / N/A acknowledgments)
    const rawFields = await getDataFields(locationId, { page });
    const dataFields = buildPublicDataFieldAnswers(rawFields);

    const buildPayload = (p) => {
      const payload = {
        state: 'BOOKED',
        firstName: p.firstName,
        lastName: p.lastName,
        name: p.name,
        email: p.email,
        phone: p.phone,
        partySize: p.partySize || 1,
        serviceIds: [serviceId],
        date: slot.date,
        duration,
      };
      if (dataFields.length) payload.dataFields = dataFields;
      return payload;
    };

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
    const maxAttempts = hasProxy() ? 5 : 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0 && !guest) person = randomGuest();
      const payload = buildPayload(person);

      // Rotate IP only after a rejected token — keep solve+POST on the same sticky IP
      if (attempt > 0 && hasProxy()) {
        await resetSession({ rotateIp: true, force: true });
        page = await getApiPage(pageUrl);
        await page.waitForTimeout(1000);
        const still = await refreshSlot(page, locationId, slot.date);
        if (!still || !(still.numAvailableSpots > 0)) {
          return {
            ok: false,
            statusCode: 400,
            error: `Slot ${slot.date} was taken before we could book — try another time`,
            guest: person,
            proxy: proxyStatus(),
          };
        }
        slot = still;
      }

      let token;
      let captchaSource = hasProxy() ? 'browser+proxy' : 'browser-same-session';
      try {
        // Prefer same-page browser token (IP always matches POST). CapSolver only
        // after 2 browser rejects, and only with the current sticky proxy.
        if (attempt < 2 || !process.env.CAPSOLVER_API_KEY) {
          token = await getRecaptchaOnPage(page);
        } else {
          const r = await getRecaptchaToken({ locationId, prefer: 'capsolver' });
          token = r.token;
          captchaSource = r.source || 'capsolver';
        }
      } catch (err) {
        lastFail = {
          ok: false,
          error: `captcha: ${err.message}`,
          guest: person,
          payload,
          proxy: proxyStatus(),
        };
        continue;
      }

      // Log egress IP for debugging captcha/IP mismatch
      try {
        const egress = await page.evaluate(async () => {
          try {
            const j = await (await fetch('https://api.ipify.org?format=json')).json();
            return j.ip;
          } catch {
            return null;
          }
        });
        if (egress) console.log(`[booking] egress IP ${egress} via ${captchaSource}`);
      } catch (_) {}

      let post;
      try {
        post = await postVisitInPage(page, { locationId, token, payload, pageUrl });
      } catch (err) {
        // Fallback to page.request if in-page fetch fails
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
        post = { ok: res.ok(), status: res.status(), body };
      }

      if (post.ok) {
        const visit = post.body;
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
          captchaSource,
          captchaAttempts: attempt + 1,
          proxy: proxyStatus(),
        };
      }

      const msg = post.body?.message || JSON.stringify(post.body);
      lastFail = {
        ok: false,
        statusCode: post.status,
        error: msg,
        captchaSource,
        guest: person,
        payload,
        proxy: proxyStatus(),
      };

      if (post.status === 400 && /no available spots/i.test(String(msg))) {
        lastFail.error = `Slot was taken (${slot.date}). Tap another BOOK button or the Waitwhile link.`;
        return lastFail;
      }

      const retryable =
        (post.status === 403 && /recaptcha|captcha/i.test(String(msg))) ||
        (post.status === 400 && /phone/i.test(String(msg)));
      if (!retryable) return lastFail;
      console.log(
        `[booking] captcha rejected (${captchaSource}) attempt ${attempt + 1}/${maxAttempts}`
      );
      await page.waitForTimeout(1200);
    }
    return lastFail;
    } finally {
      releaseBookingLock();
    }
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
