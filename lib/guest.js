/** Random temporary guest details for placeholder bookings. */

const FIRST = [
  'Jordan', 'Ava', 'Miles', 'Nora', 'Kai', 'Elena', 'Theo', 'Maya', 'Leo', 'Ivy',
  'Owen', 'Ruby', 'Ezra', 'Chloe', 'Felix', 'Luna', 'Hugo', 'Iris', 'Asher', 'Zoe',
];
const LAST = [
  'Ellis', 'Morgan', 'Hayes', 'Brooks', 'Reed', 'Coleman', 'Bennett', 'Parker',
  'Sullivan', 'Walsh', 'Grant', 'Blake', 'Porter', 'Quinn', 'Hayes', 'Foster',
];

/** Real US area codes — random NXX often fails Waitwhile/libphonenumber validation */
const AREA_CODES = [
  '212', '646', '917', '718', '347', '929', '516', '914', '845',
  '305', '786', '954', '561', '407', '321', '813', '727', '239', '904',
  '312', '773', '872', '708', '847', '630', '224',
  '213', '323', '310', '424', '818', '747', '626', '661', '714', '949',
  '415', '628', '510', '341', '925', '650', '408', '669',
  '617', '857', '781', '339', '508', '774',
  '202', '301', '240', '410', '443',
  '404', '678', '470', '770',
  '214', '469', '972', '817', '682', '713', '281', '832', '512', '737',
  '206', '253', '425', '360',
  '503', '971', '541',
  '602', '480', '623', '520',
  '702', '725', '775',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function digit() {
  return Math.floor(Math.random() * 10);
}

/** Exchange NXX: first digit 2–9, not N11 */
function exchange() {
  for (;;) {
    const a = 2 + Math.floor(Math.random() * 8);
    const b = digit();
    const c = digit();
    if (b === 1 && c === 1) continue; // avoid 211/311/…
    return `${a}${b}${c}`;
  }
}

function randomPhone() {
  const area = pick(AREA_CODES);
  const line = `${digit()}${digit()}${digit()}${digit()}`;
  // E.164 — format that already succeeded in live LV tests
  return `+1${area}${exchange()}${line}`;
}

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += digit();
  return s;
}

/** Plausible Gmail-looking address (not a real inbox we control). */
function randomGmail(firstName, lastName) {
  const f = firstName.toLowerCase();
  const l = lastName.toLowerCase();
  const styles = [
    () => `${f}.${l}${randomDigits(2 + (digit() % 3))}`,
    () => `${f}${l}${randomDigits(2)}`,
    () => `${f}.${l[0]}${randomDigits(3)}`,
    () => `${f[0]}${l}${randomDigits(3)}`,
    () => `${f}_${l}${randomDigits(2)}`,
  ];
  return `${pick(styles)()}@gmail.com`;
}

function randomGuest() {
  const firstName = pick(FIRST);
  const lastName = pick(LAST);
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    email: randomGmail(firstName, lastName),
    phone: randomPhone(),
    partySize: 1,
  };
}

module.exports = { randomGuest };
