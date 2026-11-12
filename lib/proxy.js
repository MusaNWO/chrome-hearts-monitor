/**
 * Residential / rotating proxy helpers for Waitwhile + CapSolver.
 *
 * Env:
 *   WAITWHILE_PROXY=http://user:pass@host:port
 *   WAITWHILE_PROXIES=url1,url2,...          (round-robin pool)
 *   WAITWHILE_PROXY_ROTATE=1                 (new sticky session id on each rotate)
 *   WAITWHILE_PROXY_COUNTRY=us               (optional; injected into user if {country})
 *
 * Many residential providers rotate IP when the username session id changes, e.g.
 *   user-session-abc123-country-us
 */
function parseProxyUrl(raw) {
  if (!raw || !String(raw).trim()) return null;
  let s = String(raw).trim();

  // CapSolver-style: scheme:host:port:user:pass
  const colonParts = s.split(':');
  if (!/^https?:\/\//i.test(s) && !/^socks5:\/\//i.test(s) && colonParts.length >= 4) {
    const [scheme, host, port, user, ...rest] = colonParts;
    const pass = rest.join(':');
    s = `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!u.hostname || !u.port) return null;
  const protocol = (u.protocol || 'http:').replace(':', '');
  return {
    raw: s,
    protocol,
    server: `${protocol}://${u.hostname}:${u.port}`,
    host: u.hostname,
    port: Number(u.port),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

function listConfiguredProxies() {
  const multi = (process.env.WAITWHILE_PROXIES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (multi.length) return multi;
  const single =
    process.env.WAITWHILE_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    '';
  return single ? [single] : [];
}

function randomSessionId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Inject / replace a sticky session id so the gateway hands out a new IP.
 * Supports templates with {session} / {country}, or common user-session-XXX patterns.
 */
function withRotatedSession(proxyUrl) {
  const parsed = parseProxyUrl(proxyUrl);
  if (!parsed) return proxyUrl;
  const rotate = process.env.WAITWHILE_PROXY_ROTATE !== '0';
  if (!rotate) return proxyUrl;

  const country = (process.env.WAITWHILE_PROXY_COUNTRY || 'us').toLowerCase();
  const session = randomSessionId();
  let user = parsed.username || '';

  if (user.includes('{session}') || user.includes('{country}')) {
    user = user.replace(/\{session\}/gi, session).replace(/\{country\}/gi, country);
  } else if (/session-/i.test(user)) {
    user = user.replace(/session-[a-z0-9_-]+/i, `session-${session}`);
    if (country && !/country-/i.test(user)) user = `${user}-country-${country}`;
  } else if (user) {
    // Append session segment (works for many gateways that ignore unknown suffixes)
    user = `${user}-session-${session}-country-${country}`;
  }

  const auth =
    user && parsed.password != null
      ? `${encodeURIComponent(user)}:${encodeURIComponent(parsed.password)}@`
      : '';
  return `${parsed.protocol}://${auth}${parsed.host}:${parsed.port}`;
}

let poolIndex = 0;
let currentRaw = null;
let currentParsed = null;
let rotateCount = 0;

function pickNextProxyRaw({ forceNew = false } = {}) {
  const pool = listConfiguredProxies();
  if (!pool.length) {
    currentRaw = null;
    currentParsed = null;
    return null;
  }
  if (!forceNew && currentRaw) return currentRaw;

  const base = pool[poolIndex % pool.length];
  poolIndex += 1;
  currentRaw = withRotatedSession(base);
  currentParsed = parseProxyUrl(currentRaw);
  rotateCount += 1;
  return currentRaw;
}

function getPlaywrightProxy() {
  if (!currentParsed) pickNextProxyRaw({ forceNew: !currentRaw });
  if (!currentParsed) return null;
  const out = { server: currentParsed.server };
  if (currentParsed.username) out.username = currentParsed.username;
  if (currentParsed.password) out.password = currentParsed.password;
  return out;
}

/** CapSolver proxy string: http:host:port:user:pass */
function getCapSolverProxyString() {
  if (!currentParsed) pickNextProxyRaw({ forceNew: !currentRaw });
  if (!currentParsed) return null;
  const { protocol, host, port, username, password } = currentParsed;
  if (username && password != null) {
    return `${protocol}:${host}:${port}:${username}:${password}`;
  }
  return `${protocol}:${host}:${port}`;
}

function rotateProxy() {
  return pickNextProxyRaw({ forceNew: true });
}

function hasProxy() {
  return listConfiguredProxies().length > 0;
}

function proxyStatus() {
  return {
    configured: hasProxy(),
    rotateCount,
    current: currentParsed
      ? `${currentParsed.protocol}://${currentParsed.host}:${currentParsed.port}`
      : null,
  };
}

module.exports = {
  parseProxyUrl,
  listConfiguredProxies,
  getPlaywrightProxy,
  getCapSolverProxyString,
  rotateProxy,
  pickNextProxyRaw,
  hasProxy,
  proxyStatus,
};
