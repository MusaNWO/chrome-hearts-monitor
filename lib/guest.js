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

function randomPhone() {
  // Valid US-looking mobile format (not a real assigned line)
  const n = () => Math.floor(Math.random() * 10);
  const area = `2${n()}${n()}`; // 2xx often unused for toll-free confusion avoidance
  const mid = `${n()}${n()}${n()}`;
  const last = `${n()}${n()}${n()}${n()}`;
  return `+1${area}${mid}${last}`;
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
