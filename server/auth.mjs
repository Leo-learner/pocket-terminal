import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { lstat, readFile } from 'node:fs/promises';

const scrypt = promisify(scryptCallback);
const SESSION_TTL = 12 * 60 * 60 * 1000;
const TICKET_TTL = 30 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const COOKIE_NAME = 'pocket_session';
const cookieName = secure => secure ? `__Host-${COOKIE_NAME}` : COOKIE_NAME;

export async function createPasswordRecord(password) {
  const salt = randomBytes(32);
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { algorithm: 'scrypt', salt: salt.toString('base64url'), hash: hash.toString('base64url') };
}

export function validatePasswordRecord(record) {
  if (!record || record.algorithm !== 'scrypt'
    || typeof record.salt !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.salt)
    || typeof record.hash !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(record.hash)) {
    throw new Error('Invalid authentication configuration. Run node scripts/setup.mjs.');
  }
}

export async function verifyPassword(password, record) {
  validatePasswordRecord(record);
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || !password.length) return false;
  const actual = await scrypt(password, Buffer.from(record.salt, 'base64url'), 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, Buffer.from(record.hash, 'base64url'));
}

export async function loadAuthConfig(configPath) {
  let stat;
  try { stat = await lstat(configPath); }
  catch { throw new Error('Authentication is not configured. Run node scripts/setup.mjs first.'); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size > 16384) {
    throw new Error('Authentication configuration must be a private, owned regular file with mode 600.');
  }
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { throw new Error('Authentication configuration cannot be read. Run node scripts/setup.mjs.'); }
  if (config.version !== 1) throw new Error('Unsupported authentication configuration.');
  validatePasswordRecord(config.password);
  return config;
}

// Duplicate session cookies are rejected rather than choosing a potentially attacker-controlled one.
export function sessionTokenFromCookie(header = '', secure = false) {
  if (typeof header !== 'string' || header.length > 16384) return null;
  const name = cookieName(secure);
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(token) ? token : null;
}

export function sessionCookie(token, secure = false, maxAgeSeconds = SESSION_TTL / 1000) {
  return `${cookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

const digest = value => createHash('sha256').update(value).digest('hex');

export class SessionStore {
  constructor({ now = Date.now, sessionTtlMs = SESSION_TTL, ticketTtlMs = TICKET_TTL, maxSessions = 20 } = {}) {
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
    this.ticketTtlMs = ticketTtlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.tickets = new Map();
  }

  createSession() {
    this.prune();
    while (this.sessions.size >= this.maxSessions) this.revokeById(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    const id = digest(token);
    const session = { id, expiresAt: this.now() + this.sessionTtlMs, sockets: new Set() };
    this.sessions.set(id, session);
    return { token, session };
  }

  getSession(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const session = this.sessions.get(digest(token));
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.revokeById(session.id);
      return null;
    }
    return session;
  }

  isActive(session) {
    if (!session || this.sessions.get(session.id) !== session) return false;
    if (session.expiresAt <= this.now()) {
      this.revokeById(session.id);
      return false;
    }
    return true;
  }

  revoke(token) {
    if (typeof token === 'string' && TOKEN_PATTERN.test(token)) this.revokeById(digest(token));
  }

  revokeById(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const [key, ticket] of this.tickets) if (ticket.sessionId === id) this.tickets.delete(key);
    for (const socket of session.sockets) {
      socket.close(1008, 'Authentication ended');
      const timeout = setTimeout(() => socket.terminate?.(), 1000);
      timeout.unref();
      socket.once?.('close', () => clearTimeout(timeout));
    }
    session.sockets.clear();
  }

  issueTicket(session, terminalId) {
    this.prune();
    if (!this.isActive(session)) throw new Error('Authentication required');
    const active = [...this.tickets.entries()].filter(([, value]) => value.sessionId === session.id);
    if (active.length >= 32) this.tickets.delete(active[0][0]);
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(digest(ticket), { sessionId: session.id, terminalId, expiresAt: this.now() + this.ticketTtlMs });
    return ticket;
  }

  consumeTicket(ticket, token) {
    if (typeof ticket !== 'string' || !TOKEN_PATTERN.test(ticket)) return null;
    const key = digest(ticket);
    const value = this.tickets.get(key);
    this.tickets.delete(key);
    const session = this.getSession(token);
    if (!value || !session || value.expiresAt <= this.now() || value.sessionId !== session.id) return null;
    return { session, terminalId: value.terminalId };
  }

  prune() {
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.revokeById(id);
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(key);
  }

  close() {
    for (const id of this.sessions.keys()) this.revokeById(id);
    this.tickets.clear();
  }
}

export class LoginLimiter {
  constructor({ now = Date.now, windowMs = 10 * 60 * 1000, perIp = 5, global = 30 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.perIp = perIp;
    this.global = global;
    this.attempts = [];
  }

  take(ip) {
    const now = this.now();
    this.attempts = this.attempts.filter(attempt => attempt.at > now - this.windowMs);
    if (this.attempts.length >= this.global || this.attempts.filter(attempt => attempt.ip === ip).length >= this.perIp) return false;
    this.attempts.push({ ip, at: now });
    return true;
  }
}
