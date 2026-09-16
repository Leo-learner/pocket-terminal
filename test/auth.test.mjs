import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, readFile, chmod, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { createPasswordRecord, verifyPassword, SessionStore, sessionTokenFromCookie, LoginLimiter, loadAuthConfig } from '../server/auth.mjs';
import { buildServer } from '../server/index.mjs';

const password = 'integration-test-access-key-only';
const authConfig = { version: 1, password: await createPasswordRecord(password) };
const terminalId = 'pt-3ed95c58-62df-4b17-a501-61f5e90e4cce';
const origin = 'http://localhost:4321';
const run = promisify(execFile);

test('scrypt verifies access keys and rejects incorrect or oversized passwords', async () => {
  assert.equal(await verifyPassword(password, authConfig.password), true);
  assert.equal(await verifyPassword(`${password}x`, authConfig.password), false);
  assert.equal(await verifyPassword(undefined, authConfig.password), false);
  assert.equal(await verifyPassword('a'.repeat(1025), authConfig.password), false);
  assert.notEqual((await createPasswordRecord(password)).hash, authConfig.password.hash);
});

test('cookies, one-use tickets, expiry, and revocation protect the same login session', () => {
  let time = 1_000;
  const store = new SessionStore({ now: () => time, sessionTtlMs: 100, ticketTtlMs: 30 });
  const first = store.createSession();
  const second = store.createSession();
  const cookie = `unrelated=1; pocket_session=${first.token}; another=2`;
  assert.equal(sessionTokenFromCookie(cookie), first.token);
  assert.equal(sessionTokenFromCookie(`${cookie}; pocket_session=${second.token}`), null);
  assert.equal(sessionTokenFromCookie('pocket_session=garbage'), null);
  const ticket = store.issueTicket(first.session, terminalId);
  assert.equal(store.consumeTicket(ticket, second.token), null);
  assert.equal(store.consumeTicket(ticket, first.token), null, 'an attempted ticket use burns the ticket');
  const valid = store.issueTicket(first.session, terminalId);
  assert.equal(store.consumeTicket(valid, first.token).terminalId, terminalId);
  assert.equal(store.consumeTicket(valid, first.token), null);
  const expired = store.issueTicket(first.session, terminalId);
  time += 31;
  assert.equal(store.consumeTicket(expired, first.token), null);
  const closed = [];
  first.session.sockets.add({ close: (...args) => closed.push(args) });
  const revoked = store.issueTicket(first.session, terminalId);
  store.revoke(first.token);
  assert.equal(store.getSession(first.token), null);
  assert.equal(store.consumeTicket(revoked, first.token), null);
  assert.equal(closed[0][0], 1008);
  time += 100;
  assert.equal(store.getSession(second.token), null);
});

test('login limits apply per peer and across all peers, then expire', () => {
  let time = 0;
  const limiter = new LoginLimiter({ now: () => time, windowMs: 100, perIp: 2, global: 3 });
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  assert.equal(limiter.take('b'), true);
  assert.equal(limiter.take('c'), false);
  time = 101;
  assert.equal(limiter.take('a'), true);
});

test('private config permissions are enforced and setup never prints the access key', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pocket-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'private/auth.json');
  const script = fileURLToPath(new URL('../scripts/setup.mjs', import.meta.url));
  const { stdout, stderr } = await run(process.execPath, [script], { env: { ...process.env, POCKET_CONFIG: filename } });
  const key = (await readFile(path.join(directory, 'private/access-key.txt'), 'utf8')).trim();
  assert.equal(key.length, 43);
  assert.equal(stdout.includes(key), false);
  assert.equal(stderr.includes(key), false);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(directory, 'private/access-key.txt'))).mode & 0o777, 0o600);
  assert.equal(await verifyPassword(key, (await loadAuthConfig(filename)).password), true);
  await assert.rejects(run(process.execPath, [script], { env: { ...process.env, POCKET_CONFIG: filename } }));
  assert.equal((await readFile(path.join(directory, 'private/access-key.txt'), 'utf8')).trim(), key);
  await chmod(filename, 0o644);
  await assert.rejects(loadAuthConfig(filename), /mode 600/);
  await chmod(filename, 0o600);
  const link = path.join(directory, 'linked.json');
  await symlink(filename, link);
  await assert.rejects(loadAuthConfig(link), /regular file/);
});

function stubManager() {
  const events = new EventEmitter();
  const terminals = [{ id: terminalId, name: 'Shell', cols: 80, rows: 24 }];
  const attachments = [];
  return {
    events, attachments, terminals,
    async list() { return [...terminals]; },
    async create(value) { const session = { ...value, id: terminalId }; terminals.push(session); return session; },
    async rename(id, name) { terminals.find(item => item.id === id).name = name; },
    async destroy(id) { terminals.splice(terminals.findIndex(item => item.id === id), 1); },
    async history() { return 'previous command output\n'; },
    async attach(id, options) {
      const attached = { id, options, detached: false };
      attachments.push(attached);
      return {
        write(data) { events.emit('write', data); },
        resize(cols, rows) { events.emit('resize', { cols, rows }); },
        ack(bytes) { events.emit('ack', bytes); },
        detach() { attached.detached = true; events.emit('detach'); },
      };
    },
    async close() {},
  };
}

async function runtime(t, extra = {}) {
  const manager = stubManager();
  const instance = await buildServer({ manager, authConfig, origin, ...extra });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  t.after(() => instance.close());
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const request = (route, { method = 'GET', body, cookie, requestOrigin, ...options } = {}) => fetch(base + route, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(requestOrigin !== undefined ? { Origin: requestOrigin } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...options,
  });
  const login = async () => {
    const response = await request('/api/login', { method: 'POST', requestOrigin: origin, body: { password } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { ...instance, manager, base, request, login };
}

function connect(base, ticket, cookie, requestOrigin = origin) {
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?ticket=${encodeURIComponent(ticket)}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}) } });
  const messages = [];
  const waiters = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex(item => item.type === message.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else messages.push(message);
  });
  ws.on('error', () => {});
  return {
    ws,
    next(type) {
      const index = messages.findIndex(item => item.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Missing WebSocket message: ${type}`)), 2000);
        timeout.unref();
        waiters.push({ type, resolve: value => { clearTimeout(timeout); resolve(value); } });
      });
    },
  };
}

async function rejectedSocket(base, ticket, cookie, requestOrigin) {
  const { ws } = connect(base, ticket, cookie, requestOrigin);
  return new Promise((resolve, reject) => {
    ws.once('open', () => { ws.terminate(); reject(new Error('WebSocket was unexpectedly authorized')); });
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode);
    });
  });
}

test('real HTTP rejects unauthenticated access and cross-origin login/mutations', async t => {
  const { request, manager } = await runtime(t);
  for (const route of ['/api/me', '/api/sessions']) assert.equal((await request(route)).status, 401);
  assert.equal((await request('/healthz')).status, 200);
  for (const requestOrigin of [undefined, 'https://attacker.example', 'null']) {
    assert.equal((await request('/api/login', { method: 'POST', requestOrigin, body: { password } })).status, 403);
  }
  const response = await request('/api/login', { method: 'POST', requestOrigin: origin, body: { password } });
  assert.equal(response.status, 200);
  const cookieHeader = response.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const cookie = cookieHeader.split(';')[0];
  assert.equal((await request('/api/me', { cookie })).status, 200);
  const listed = await request('/api/sessions', { cookie });
  assert.deepEqual((await listed.json()).sessions, manager.terminals);
  assert.deepEqual(await (await request(`/api/sessions/${terminalId}/history`, { cookie })).json(), { text: 'previous command output\n' });
  assert.equal((await request('/api/sessions', { cookie, method: 'POST', body: { name: 'Test' } })).status, 403);
  assert.equal((await request('/api/sessions', { cookie, method: 'POST', requestOrigin: origin, body: { cols: 10000 } })).status, 400);
  assert.equal((await request(`/api/sessions/${terminalId}`, { cookie, method: 'PATCH', requestOrigin: origin, body: { name: 'Renamed' } })).status, 200);
  assert.equal(manager.terminals[0].name, 'Renamed');
});

test('real HTTP login throttles repeated invalid keys', async t => {
  const { request } = await runtime(t);
  for (let i = 0; i < 5; i++) assert.equal((await request('/api/login', { method: 'POST', requestOrigin: origin, body: { password: 'incorrect' } })).status, 401);
  const response = await request('/api/login', { method: 'POST', requestOrigin: origin, body: { password } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '600');
});

test('WebSockets require origin, cookie, and a single-use ticket; logout detaches without destroying the shell', async t => {
  const { request, login, base, manager } = await runtime(t);
  const cookie = await login();
  const issue = async () => (await (await request('/api/ticket', { method: 'POST', requestOrigin: origin, cookie, body: { sessionId: terminalId } })).json()).ticket;
  assert.equal(await rejectedSocket(base, 'invalid', cookie, origin), 401);
  const ticket = await issue();
  assert.equal(await rejectedSocket(base, ticket, cookie, 'https://attacker.example'), 403);
  const { ws, next } = connect(base, ticket, cookie);
  t.after(() => ws.terminate());
  assert.equal((await next('ready')).sessionId, terminalId);
  assert.equal(await rejectedSocket(base, ticket, cookie, origin), 401);
  assert.equal(await rejectedSocket(base, await issue(), null, origin), 401);
  assert.equal(manager.attachments.length, 1);
  const write = once(manager.events, 'write');
  ws.send(JSON.stringify({ type: 'input', data: 'echo hello\r' }));
  assert.deepEqual(await write, ['echo hello\r']);
  manager.attachments[0].options.onData('hello\r\n中文');
  assert.equal((await next('output')).data, 'hello\r\n中文');
  const ack = once(manager.events, 'ack');
  ws.send(JSON.stringify({ type: 'ack', bytes: Buffer.byteLength('hello\r\n中文') }));
  assert.deepEqual(await ack, [13]);
  const resize = once(manager.events, 'resize');
  ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }));
  assert.deepEqual(await resize, [{ cols: 90, rows: 30 }]);
  const closed = once(ws, 'close');
  const response = await request('/api/logout', { method: 'POST', requestOrigin: origin, cookie });
  assert.equal(response.status, 200);
  assert.equal((await closed)[0], 1008);
  assert.equal(manager.terminals.length, 1);
  assert.equal(manager.attachments[0].detached, true);
  assert.equal((await request('/api/me', { cookie })).status, 401);
});

test('oversized terminal input closes the connection before it reaches the PTY', async t => {
  const { request, login, base, manager } = await runtime(t);
  const cookie = await login();
  const ticket = (await (await request('/api/ticket', { method: 'POST', requestOrigin: origin, cookie, body: { sessionId: terminalId } })).json()).ticket;
  const { ws, next } = connect(base, ticket, cookie);
  t.after(() => ws.terminate());
  await next('ready');
  let writes = 0;
  manager.events.on('write', () => { writes++; });
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'input', data: '中'.repeat(11000) }));
  assert.equal((await closed)[0], 1008);
  assert.equal(writes, 0);
});

test('an established WebSocket loses authorization at the login expiry', async t => {
  const { request, login, base, manager } = await runtime(t, { sessionTtlMs: 350 });
  const cookie = await login();
  const ticket = (await (await request('/api/ticket', { method: 'POST', requestOrigin: origin, cookie, body: { sessionId: terminalId } })).json()).ticket;
  const { ws, next } = connect(base, ticket, cookie);
  t.after(() => ws.terminate());
  await next('ready');
  const [code] = await once(ws, 'close');
  assert.equal(code, 1008);
  assert.equal(manager.terminals.length, 1);
  assert.equal((await request('/api/me', { cookie })).status, 401);
});
