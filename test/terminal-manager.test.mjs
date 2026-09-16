import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalManager } from '../server/terminal-manager.mjs';

const runFile = promisify(execFile);

async function until(predicate, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(25);
  }
  assert.fail(`Timed out: ${description}`);
}

async function fixture(t, overrides = {}) {
  const base = resolve('work/terminal-tests');
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(join(base, 'run-'));
  await writeFile(join(cwd, '.zshrc'), "PROMPT='PT-READY> '\nRPROMPT=''\n");
  const socketName = `pt-test-${randomUUID()}`;
  const options = { cwd, socketName, env: { HOME: cwd, ZDOTDIR: cwd }, ...overrides };
  const managers = [];
  function makeManager() {
    const manager = new TerminalManager(options);
    managers.push(manager);
    return manager;
  }
  const manager = makeManager();
  t.after(async () => {
    for (const item of managers) await item.close();
    await runFile('tmux', ['-L', socketName, 'kill-server']).catch(() => {});
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { manager, makeManager, cwd, socketName };
}

async function connect(manager, id, { cols = 80, rows = 24, autoAck = true } = {}) {
  let handle;
  let output = '';
  let unacknowledged = 0;
  let acknowledge = autoAck;
  const exits = [];
  handle = await manager.attach(id, {
    cols, rows,
    onData(data) {
      output += data;
      unacknowledged += Buffer.byteLength(data);
      if (acknowledge) queueMicrotask(() => drain());
    },
    onExit(event) { exits.push(event); },
  });
  function drain() {
    if (unacknowledged && handle) {
      const amount = unacknowledged;
      unacknowledged = 0;
      handle.ack(amount);
    }
  }
  return {
    handle, exits,
    get output() { return output; },
    get unacknowledged() { return unacknowledged; },
    clear() { output = ''; },
    stopAck() { acknowledge = false; },
    startAck() { acknowledge = true; drain(); },
    async wait(pattern) {
      try { return await until(() => pattern.test(stripVTControlCharacters(output)), `terminal output ${pattern}`); }
      catch (error) { throw new Error(`${error.message}; tail: ${JSON.stringify(output.slice(-600))}`, { cause: error }); }
    },
  };
}

test('real PTY supports shell input, Unicode, resize, and isolated tmux options', { timeout: 20000 }, async (t) => {
  const { manager, socketName } = await fixture(t);
  assert.deepEqual(await manager.list(), []);
  const session = await manager.create({ name: '我的终端', cols: 88, rows: 30 });
  assert.equal(session.name, '我的终端');
  assert.equal(session.cols, 88);
  assert.equal(session.rows, 30);
  const terminal = await connect(manager, session.id);
  await terminal.wait(/PT-READY>/);
  terminal.clear();
  terminal.handle.write("print $((183 + 296))\r");
  await terminal.wait(/\r?\n479\r?\n/);
  terminal.handle.write("POCKET_TEST_UNICODE='你好，手机 🌙'; print -r -- \"$POCKET_TEST_UNICODE\"\r");
  await terminal.wait(/\r?\n你好，手机 🌙\r?\n/u);
  terminal.handle.resize(101, 35);
  await until(async () => {
    const [info] = await manager.list();
    return info.cols === 101 && info.rows === 35;
  }, 'terminal resize');
  terminal.clear();
  await until(async () => {
    terminal.handle.write('stty size\r');
    await delay(60);
    return /35 101/.test(stripVTControlCharacters(terminal.output));
  }, 'shell PTY resize propagates');
  terminal.handle.resize(1000, 1);
  await until(async () => {
    const [info] = await manager.list();
    return info.cols === 300 && info.rows === 3;
  }, 'terminal size clamp');
  for (const [option, expected] of [['status', 'off'], ['mouse', 'on'], ['history-limit', '50000'], ['default-terminal', 'xterm-256color']]) {
    const { stdout } = await runFile('tmux', ['-L', socketName, 'show-options', '-gv', option]);
    assert.equal(stdout.trim(), expected);
  }
  assert.throws(() => terminal.handle.resize(NaN, 24), { code: 'INVALID_SIZE' });
  assert.throws(() => terminal.handle.write('界'.repeat(12000)), { code: 'INPUT_TOO_LARGE' });
  await manager.destroy(session.id);
  await until(() => terminal.exits.length === 1, 'PTY exit when session destroyed');
  assert.deepEqual(await manager.list(), []);
});

test('detach, process restart, and reattach preserve shell variables and a running job', { timeout: 20000 }, async (t) => {
  const { manager, makeManager, cwd } = await fixture(t);
  const session = await manager.create({ name: '持久会话' });
  const first = await connect(manager, session.id);
  await first.wait(/PT-READY>/);
  first.handle.write("POCKET_TEST_VALUE=survived_detach; (sleep 0.6; print complete > job-result.txt) &\r");
  await first.wait(/\[1\]/);
  first.handle.write('print EARLIER-HISTORY-MARKER; repeat 45 print later-line\r');
  await first.wait(/later-line\r?\n/);
  first.handle.detach();
  await manager.close();
  await until(async () => {
    try { return (await readFile(join(cwd, 'job-result.txt'), 'utf8')).trim() === 'complete'; } catch { return false; }
  }, 'background job survives disconnect');
  const restarted = makeManager();
  const persisted = await restarted.list();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, session.id);
  assert.equal(persisted[0].name, '持久会话');
  assert.match(await restarted.history(session.id), /EARLIER-HISTORY-MARKER/);
  const second = await connect(restarted, session.id, { cols: 62, rows: 18 });
  await second.wait(/PT-READY>/);
  second.clear();
  second.handle.write('print -r -- "$POCKET_TEST_VALUE"\r');
  await second.wait(/\r?\nsurvived_detach\r?\n/);
  assert.throws(() => first.handle.write('echo wrong\r'), { code: 'TERMINAL_DETACHED' });
  const renamed = await restarted.rename(session.id, '重命名 🌙');
  assert.equal(renamed.name, '重命名 🌙');
  await restarted.close();
  assert.equal((await makeManager().list())[0].name, '重命名 🌙');
});

test('strict IDs, encoded names, session limits, and unmanaged-session filtering prevent side effects', { timeout: 20000 }, async (t) => {
  const { manager, cwd, socketName } = await fixture(t, { maxSessions: 2 });
  const injectedName = '; run-shell "touch SHOULD-NOT-EXIST"; #(touch ALSO-NOT)';
  const session = await manager.create({ name: injectedName });
  assert.equal(session.name, injectedName);
  assert.equal((await manager.rename(session.id, ';')).name, ';');
  const absent = join(cwd, 'SHOULD-NOT-EXIST');
  await assert.rejects(access(absent), { code: 'ENOENT' });
  await assert.rejects(access(join(cwd, 'ALSO-NOT')), { code: 'ENOENT' });
  for (const id of ['default', session.id + ';', '*', session.id + ':', '-a', '../default']) {
    await assert.rejects(manager.attach(id, { onData() {} }), { code: 'INVALID_SESSION' });
    await assert.rejects(manager.history(id), { code: 'INVALID_SESSION' });
    assert.throws(() => manager.destroy(id), { code: 'INVALID_SESSION' });
    assert.throws(() => manager.rename(id, 'name'), { code: 'INVALID_SESSION' });
  }
  for (const name of ['\u001b[31m', '', 'a\nb', 'a'.repeat(81), '界'.repeat(81)]) {
    assert.throws(() => manager.create({ name }), { code: 'INVALID_NAME' });
  }
  await assert.rejects(manager.attach(`pt-${randomUUID()}`, { onData() {} }), { code: 'SESSION_NOT_FOUND' });
  await runFile('tmux', ['-L', socketName, 'new-session', '-d', '-s', 'unmanaged', '-c', cwd, '/bin/zsh', '-l']);
  assert.equal((await manager.list()).length, 1);
  await manager.create({ name: '第二个' });
  await assert.rejects(manager.create({ name: '超额' }), { code: 'SESSION_LIMIT' });
  assert.equal((await manager.list()).length, 2);
  await manager.destroy(session.id);
  await runFile('tmux', ['-L', socketName, 'has-session', '-t', '=unmanaged']);
  assert.throws(() => new TerminalManager({ socketName: 'default' }), { code: 'INVALID_SOCKET' });
});

test('acknowledgement flow control pauses output and resumes without truncation', { timeout: 20000 }, async (t) => {
  const { manager } = await fixture(t, { flowControlBytes: 16 * 1024 });
  const session = await manager.create();
  const terminal = await connect(manager, session.id);
  await terminal.wait(/PT-READY>/);
  await delay(100);
  terminal.clear();
  terminal.stopAck();
  terminal.handle.write("printf '%*s\\n' 400000 '' | tr ' ' x; print FLOW-${:-END}\r");
  await until(() => terminal.unacknowledged >= manager.flowControlBytes, 'output reaches flow-control window');
  const pausedLength = Buffer.byteLength(terminal.output);
  await delay(150);
  assert.equal(Buffer.byteLength(terminal.output), pausedLength);
  assert.equal(terminal.unacknowledged, manager.flowControlBytes);
  assert.throws(() => terminal.handle.ack(terminal.unacknowledged + 1), { code: 'INVALID_ACK' });
  assert.throws(() => terminal.handle.ack(-1), { code: 'INVALID_ACK' });
  terminal.startAck();
  await terminal.wait(/FLOW-END/);
  assert.equal(terminal.exits.length, 0);
  assert.match(await manager.history(session.id), /FLOW-END/);
});
