import express from 'express';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { LoginLimiter, SessionStore, loadAuthConfig, sessionCookie, sessionTokenFromCookie, verifyPassword, validatePasswordRecord } from './auth.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const ID_PATTERN = /^pt-[a-f0-9-]{36}$/;

function validDimensions(cols, rows) {
  return Number.isInteger(cols) && cols >= 20 && cols <= 300
    && Number.isInteger(rows) && rows >= 3 && rows <= 200;
}

function validName(name) {
  return typeof name === 'string' && name.trim().length > 0 && [...name].length <= 80
    && Buffer.byteLength(name) <= 240 && !/[\x00-\x1f\x7f]/.test(name);
}

function rejectUpgrade(socket, status = 401) {
  const reason = status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Unauthorized';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
}

export async function buildServer({
  manager,
  authConfig,
  configPath = process.env.POCKET_CONFIG || path.join(projectRoot, '.runtime/auth.json'),
  origin = process.env.POCKET_ORIGIN || 'http://localhost:4321',
  distDir = path.join(projectRoot, 'dist'),
  now = Date.now,
  sessionTtlMs,
  ticketTtlMs,
  trustProxy = ['1', 'true'].includes(process.env.POCKET_TRUST_PROXY || ''),
} = {}) {
  const publicUrl = new URL(origin);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.origin !== origin || publicUrl.username || publicUrl.password) {
    throw new Error('POCKET_ORIGIN must be an exact HTTP(S) origin without a path.');
  }
  if (publicUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)) {
    throw new Error('Remote access requires an HTTPS origin.');
  }
  const secure = publicUrl.protocol === 'https:';
  const config = authConfig || await loadAuthConfig(configPath);
  validatePasswordRecord(config.password);
  if (!manager) {
    const { TerminalManager } = await import('./terminal-manager.mjs');
    manager = new TerminalManager();
  }
  const sessions = new SessionStore({ now, ...(sessionTtlMs ? { sessionTtlMs } : {}), ...(ticketTtlMs ? { ticketTtlMs } : {}) });
  const limiter = new LoginLimiter({ now });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy ? 'loopback' : false);
  const wsOrigin = origin.replace(/^http/, 'ws');

  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${wsOrigin}; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/') || req.path === '/healthz') res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Origin is mandatory even on localhost. Cookies alone never authorize a mutation.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) return res.status(403).json({ error: 'Origin not allowed' });
    next();
  });
  app.use('/api', express.json({ limit: '16kb', strict: true }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.post('/api/login', async (req, res) => {
    // Production enables this only behind nginx, which overwrites forwarded IPs.
    if (!limiter.take((trustProxy ? req.ip : req.socket.remoteAddress) || 'unknown')) {
      res.setHeader('Retry-After', '600');
      return res.status(429).json({ error: 'Too many login attempts. Try again in 10 minutes.' });
    }
    if (!await verifyPassword(req.body?.password, config.password)) return res.status(401).json({ error: 'Invalid access key' });
    sessions.revoke(sessionTokenFromCookie(req.headers.cookie, secure));
    const { token, session } = sessions.createSession();
    res.setHeader('Set-Cookie', sessionCookie(token, secure, Math.max(1, Math.floor((session.expiresAt - now()) / 1000))));
    res.json({ authenticated: true, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  app.use('/api', (req, res, next) => {
    const session = sessions.getSession(sessionTokenFromCookie(req.headers.cookie, secure));
    if (!session) return res.status(401).json({ error: 'Authentication required' });
    req.authSession = session;
    next();
  });
  app.get('/api/me', (req, res) => res.json({ authenticated: true, expiresAt: new Date(req.authSession.expiresAt).toISOString() }));
  app.post('/api/logout', (req, res) => {
    sessions.revokeById(req.authSession.id);
    res.setHeader('Set-Cookie', sessionCookie('', secure, 0));
    res.json({ ok: true });
  });
  app.get('/api/sessions', async (_req, res) => res.json({ sessions: await manager.list() }));
  app.post('/api/sessions', async (req, res) => {
    const { name, cols = 80, rows = 24 } = req.body || {};
    if ((name !== undefined && !validName(name)) || !validDimensions(cols, rows)) return res.status(400).json({ error: 'Invalid session name or dimensions' });
    const session = await manager.create({ name: name?.trim(), cols, rows });
    res.status(201).json({ session });
  });
  app.param('id', (req, res, next, id) => {
    if (!ID_PATTERN.test(id)) return res.status(400).json({ error: 'Invalid session ID' });
    next();
  });
  app.patch('/api/sessions/:id', async (req, res) => {
    if (!validName(req.body?.name)) return res.status(400).json({ error: 'Invalid session name' });
    await manager.rename(req.params.id, req.body.name.trim());
    const session = (await manager.list()).find(item => item.id === req.params.id);
    res.json({ session });
  });
  app.delete('/api/sessions/:id', async (req, res) => {
    await manager.destroy(req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/sessions/:id/history', async (req, res) => res.json({ text: await manager.history(req.params.id) }));
  app.post('/api/ticket', async (req, res) => {
    if (!ID_PATTERN.test(req.body?.sessionId || '')) return res.status(400).json({ error: 'Invalid session ID' });
    if (!(await manager.list()).some(item => item.id === req.body.sessionId)) return res.status(404).json({ error: 'Session not found' });
    res.json({ ticket: sessions.issueTicket(req.authSession, req.body.sessionId) });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(distDir, { index: false, dotfiles: 'deny', maxAge: '1h' }));
  app.get('/', async (_req, res) => {
    const filename = path.join(distDir, 'index.html');
    try { await stat(filename); }
    catch { return res.status(503).type('text').send('Frontend is not built. Run npm run build.'); }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(filename);
  });
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
    if (['SESSION_NOT_FOUND', 'NOT_FOUND'].includes(error.code)) return res.status(404).json({ error: 'Session not found' });
    if (['SESSION_LIMIT', 'LIMIT_REACHED'].includes(error.code)) return res.status(409).json({ error: 'Session limit reached' });
    if (typeof error.code === 'string' && error.code.startsWith('INVALID_')) return res.status(400).json({ error: 'Invalid session request' });
    res.status(500).json({ error: 'The terminal operation could not be completed' });
  });

  const server = createServer({ maxHeaderSize: 16 * 1024 }, app);
  server.headersTimeout = 15_000;
  server.requestTimeout = 20_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let url;
    try { url = new URL(req.url, origin); }
    catch { return rejectUpgrade(socket, 404); }
    if (url.pathname !== '/ws') return rejectUpgrade(socket, 404);
    if (req.headers.origin !== origin) return rejectUpgrade(socket, 403);
    const authorization = sessions.consumeTicket(url.searchParams.get('ticket'), sessionTokenFromCookie(req.headers.cookie, secure));
    if (!authorization) return rejectUpgrade(socket);
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req, authorization);
    });
  });

  wss.on('connection', (ws, _req, { session, terminalId }) => {
    let handle;
    let pendingSize = { cols: 80, rows: 24 };
    let pendingAck = 0;
    let alive = true;
    let isClosed = false;
    session.sockets.add(ws);
    const send = message => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const encoded = JSON.stringify(message);
      if (ws.bufferedAmount + Buffer.byteLength(encoded) > MAX_BUFFERED_BYTES) {
        ws.close(1013, 'Connection too slow; reconnect');
        return;
      }
      ws.send(encoded, error => { if (error) ws.terminate(); });
    };
    const finish = () => {
      if (isClosed) return;
      isClosed = true;
      clearTimeout(expiryTimer);
      clearInterval(heartbeat);
      session.sockets.delete(ws);
      if (handle) Promise.resolve(handle.detach()).catch(() => {});
    };
    const expiryTimer = setTimeout(() => sessions.revokeById(session.id), Math.max(1, session.expiresAt - now()));
    expiryTimer.unref();
    const heartbeat = setInterval(() => {
      if (!sessions.isActive(session)) return;
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    heartbeat.unref();
    ws.on('pong', () => { alive = true; });
    ws.on('error', () => {});
    ws.on('close', finish);
    ws.on('message', (raw, isBinary) => {
      if (!sessions.isActive(session) || isClosed) return;
      if (isBinary) return ws.close(1003, 'Text messages required');
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return ws.close(1008, 'Invalid message'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return ws.close(1008, 'Invalid message');
      try {
        if (message.type === 'resize' && validDimensions(message.cols, message.rows)) {
          pendingSize = { cols: message.cols, rows: message.rows };
          if (handle) handle.resize(message.cols, message.rows);
        } else if (message.type === 'input' && typeof message.data === 'string' && Buffer.byteLength(message.data) <= MAX_INPUT_BYTES) {
          if (!handle) return ws.close(1013, 'Terminal is not ready');
          handle.write(message.data);
        } else if (message.type === 'ack' && Number.isSafeInteger(message.bytes) && message.bytes > 0 && message.bytes <= MAX_BUFFERED_BYTES) {
          if (handle) handle.ack(message.bytes);
          else {
            pendingAck += message.bytes;
            if (pendingAck > MAX_BUFFERED_BYTES) ws.close(1008, 'Invalid acknowledgment');
          }
        } else {
          ws.close(1008, 'Invalid message');
        }
      } catch { ws.close(1011, 'Terminal operation failed'); }
    });
    Promise.resolve().then(() => manager.attach(terminalId, {
      ...pendingSize,
      onData: data => send({ type: 'output', data }),
      onExit: result => {
        send({ type: 'exit', exitCode: result?.exitCode ?? null });
        ws.close(1000, 'Terminal detached');
      },
    })).then(attached => {
      handle = attached;
      if (isClosed || ws.readyState !== WebSocket.OPEN || !sessions.isActive(session)) return Promise.resolve(handle.detach());
      handle.resize(pendingSize.cols, pendingSize.rows);
      if (pendingAck) handle.ack(pendingAck);
      send({ type: 'ready', sessionId: terminalId });
    }).catch(() => {
      if (ws.readyState === WebSocket.OPEN) {
        send({ type: 'error', error: 'Could not attach to the terminal. Refresh sessions and try again.' });
        ws.close(1011, 'Terminal unavailable');
      }
    });
  });

  const pruneTimer = setInterval(() => sessions.prune(), 15_000);
  pruneTimer.unref();
  let closed = false;
  return {
    app, server, wss,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(pruneTimer);
      sessions.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
      await manager.close();
    },
  };
}

async function main() {
  const port = Number(process.env.POCKET_PORT || 4321);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('POCKET_PORT must be a valid TCP port.');
  const runtime = await buildServer();
  runtime.server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`Pocket Terminal listening on 127.0.0.1:${port}\n`);
  });
  runtime.server.on('error', () => {
    process.stderr.write('The terminal server could not listen on the configured port.\n');
    runtime.close().finally(() => { process.exitCode = 1; });
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    runtime.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Startup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
