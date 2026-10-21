/** Random temporary guest details for placeholder bookings. */

const FIRST = [
  'Jordan', 'Ava', 'Miles', 'Nora', 'Kai', 'Elena', 'Theo', 'Maya', 'Leo', 'Ivy',
  'Owen', 'Ruby', 'Ezra', 'Chloe', 'Felix', 'Luna', 'Hugo', 'Iris', 'Asher', 'Zoe',
];
const LAST = [
  'Ellis', 'Morgan', 'Hayes', 'Brooks', 'Reed', 'Coleman', 'Bennett', 'Parker',
  'Sullivan', 'Walsh', 'Grant', 'Blake', 'Porter', 'Quinn', 'Hayes', 'Foster',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function digit() {
  return Math.floor(Math.random() * 10);
}
/** NANP: first digit of area/exchange must be 2–9 (Waitwhile rejects 0/1xxx). */
function nxx() {
  return `${2 + Math.floor(Math.random() * 8)}${digit()}${digit()}`;
}

function randomPhone() {
  // E.164 US number that passes libphonenumber-style checks
  return `+1${nxx()}${nxx()}${digit()}${digit()}${digit()}${digit()}`;
}

function randomGuest() {
  const firstName = pick(FIRST);
  const lastName = pick(LAST);
  const stamp = Date.now().toString(36);
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${stamp}@mailinator.com`,
    phone: randomPhone(),
    partySize: 1,
  };
}

module.exports = { randomGuest };
