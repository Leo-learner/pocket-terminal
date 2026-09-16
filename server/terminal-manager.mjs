import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import * as pty from 'node-pty';

const runFile = promisify(execFile);
const SESSION_ID = /^pt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const NAME_OPTION = '@pocket-name-b64';
const FORMAT = `#{session_name}\t#{window_width}\t#{window_height}\t#{session_created}\t#{session_attached}\t#{${NAME_OPTION}}`;

function failure(message, code = 'TERMINAL_ERROR') {
  return Object.assign(new Error(message), { code });
}

function validateId(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) {
    throw failure('无效的终端会话。', 'INVALID_SESSION');
  }
  return id;
}

function validateName(name) {
  if (typeof name !== 'string') throw failure('会话名称必须是文字。', 'INVALID_NAME');
  const trimmed = name.trim();
  if (!trimmed || [...trimmed].length > 80 || Buffer.byteLength(trimmed) > 240 || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) {
    throw failure('会话名称须为 1–80 个字符，且不能包含控制字符。', 'INVALID_NAME');
  }
  return trimmed;
}

function dimension(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw failure('终端尺寸必须是有效数字。', 'INVALID_SIZE');
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function dimensions(cols, rows) {
  return { cols: dimension(cols, 80, 20, 300), rows: dimension(rows, 24, 3, 200) };
}

// tmux also parses a trailing semicolon in an argv element as a separator.
// Display names never enter its parser: they are persisted as base64url.
function literal(value) {
  return value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value;
}

function noServer(error) {
  return /no server running|failed to connect|error connecting.*(?:No such file|Connection refused)/i.test(error.stderr ?? '');
}

function metadata(line) {
  const [id, cols, rows, created, attached, encoded] = line.split('\t');
  if (!SESSION_ID.test(id)) return null;
  let name = '终端';
  if (encoded && /^[a-zA-Z0-9_-]+$/.test(encoded)) {
    try { name = validateName(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { /* Recover malformed metadata safely. */ }
  }
  return {
    id, name, cols: Number(cols), rows: Number(rows),
    createdAt: new Date(Number(created) * 1000).toISOString(),
    attached: Number(attached) > 0,
  };
}

/**
 * Real interactive shells in an isolated tmux server. The HTTP layer must
 * authenticate callers before create/attach. No server is started by list().
 * Detached sessions outlive this manager and can be adopted after restart.
 */
export class TerminalManager {
  #handles = new Set();
  #closed = false;
  #mutations = Promise.resolve();

  constructor({
    socketName = 'pocket-terminal', cwd = homedir(), tmuxPath = 'tmux',
    shell = '/bin/zsh', env = {}, maxSessions = 12, flowControlBytes = 128 * 1024,
  } = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(socketName) || socketName === 'default') {
      throw failure('必须使用独立的 tmux socket 名称。', 'INVALID_SOCKET');
    }
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || typeof shell !== 'string' || !isAbsolute(shell)) {
      throw failure('终端目录和 shell 必须是绝对路径。', 'INVALID_CONFIG');
    }
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 12) {
      throw failure('会话数量上限必须介于 1 和 12。', 'INVALID_CONFIG');
    }
    if (!Number.isInteger(flowControlBytes) || flowControlBytes < 4096 || flowControlBytes > MAX_OUTPUT_BYTES / 2) {
      throw failure('无效的终端流控窗口。', 'INVALID_CONFIG');
    }
    this.socketName = socketName;
    this.cwd = cwd;
    this.tmuxPath = tmuxPath;
    this.shell = shell;
    this.maxSessions = maxSessions;
    this.flowControlBytes = flowControlBytes;
    this.env = { ...process.env, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    delete this.env.TMUX;
    delete this.env.TMUX_PANE;
    delete this.env.POCKET_CONFIG;
  }

  #assertOpen() {
    if (this.#closed) throw failure('终端服务已关闭。', 'MANAGER_CLOSED');
  }

  #args(args) { return ['-u', '-L', this.socketName, '-f', '/dev/null', ...args]; }

  async #run(args, { maxBuffer = 1024 * 1024 } = {}) {
    return runFile(this.tmuxPath, this.#args(args), {
      env: this.env, cwd: this.cwd, encoding: 'utf8', timeout: 10_000, maxBuffer,
    });
  }

  #serialize(operation) {
    const result = this.#mutations.then(() => { this.#assertOpen(); return operation(); });
    this.#mutations = result.catch(() => {});
    return result;
  }

  async list() {
    this.#assertOpen();
    try {
      const { stdout } = await this.#run(['list-sessions', '-F', FORMAT]);
      return stdout.trim().split('\n').filter(Boolean).map(metadata).filter(Boolean)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    } catch (error) {
      if (noServer(error)) return [];
      if (error.code === 'ENOENT') throw failure('未找到 tmux，请先安装 tmux。', 'TMUX_UNAVAILABLE');
      throw failure('无法读取终端会话。');
    }
  }

  async #find(id) {
    validateId(id);
    const session = (await this.list()).find((entry) => entry.id === id);
    if (!session) throw failure('终端会话不存在或已经结束。', 'SESSION_NOT_FOUND');
    return session;
  }

  create({ name = '终端', cols, rows } = {}) {
    const validName = validateName(name);
    const size = dimensions(cols, rows);
    return this.#serialize(async () => {
      if ((await this.list()).length >= this.maxSessions) throw failure('最多可以保留 12 个终端会话，请先关闭不再使用的会话。', 'SESSION_LIMIT');
      const id = `pt-${randomUUID()}`;
      const commands = [
        ['start-server'],
        ['set-option', '-g', 'default-shell', literal(this.shell)],
        ['set-option', '-g', 'default-terminal', 'xterm-256color'],
        ['set-option', '-g', 'status', 'off'],
        ['set-option', '-g', 'history-limit', '50000'],
        ['set-option', '-g', 'mouse', 'on'],
        ['set-option', '-g', 'focus-events', 'on'],
        ['set-option', '-s', 'escape-time', '0'],
        ['set-option', '-as', 'terminal-features', ',xterm-256color:RGB'],
        ['set-window-option', '-g', 'window-size', 'latest'],
        ['new-session', '-d', '-s', id, '-c', literal(this.cwd), '-x', String(size.cols), '-y', String(size.rows), literal(this.shell), '-l'],
        ['set-option', '-t', `=${id}:`, NAME_OPTION, Buffer.from(validName).toString('base64url')],
      ];
      try {
        await this.#run(commands.flatMap((command, index) => index ? [';', ...command] : command));
        return await this.#find(id);
      } catch (error) {
        if (error.code === 'ENOENT') throw failure('未找到 tmux，请先安装 tmux。', 'TMUX_UNAVAILABLE');
        // Creation can fail after new-session, so remove only this generated ID.
        await this.#run(['kill-session', '-t', `=${id}`]).catch(() => {});
        if (error.code === 'SESSION_NOT_FOUND') throw error;
        throw Object.assign(failure('无法创建终端会话，请检查 shell 和工作目录。'), { cause: error });
      }
    });
  }

  rename(id, name) {
    validateId(id);
    const validName = validateName(name);
    return this.#serialize(async () => {
      await this.#find(id);
      await this.#run(['set-option', '-t', `=${id}:`, NAME_OPTION, Buffer.from(validName).toString('base64url')]);
      return this.#find(id);
    });
  }

  async history(id) {
    await this.#find(id);
    const { stdout } = await this.#run(['capture-pane', '-p', '-S', '-2000', '-t', `=${id}:`], { maxBuffer: 8 * 1024 * 1024 });
    const bytes = Buffer.from(stdout);
    let start = Math.max(0, bytes.length - MAX_OUTPUT_BYTES);
    // Keep the most recent output without cutting into a UTF-8 code point.
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
    return bytes.subarray(start).toString('utf8');
  }

  destroy(id) {
    validateId(id);
    return this.#serialize(async () => {
      await this.#find(id);
      await this.#run(['kill-session', '-t', `=${id}`]);
    });
  }

  async attach(id, { cols, rows, onData, onExit = () => {} } = {}) {
    this.#assertOpen();
    validateId(id);
    const size = dimensions(cols, rows);
    if (typeof onData !== 'function' || typeof onExit !== 'function') throw failure('缺少终端数据回调。', 'INVALID_CALLBACK');
    await this.#find(id);
    this.#assertOpen();
    const terminal = pty.spawn(this.tmuxPath, this.#args(['attach-session', '-E', '-t', `=${id}`]), {
      name: 'xterm-256color', cols: size.cols, rows: size.rows,
      cwd: this.cwd, env: this.env, encoding: 'utf8',
    });
    let detached = false;
    let outstanding = 0;
    let pending = Buffer.alloc(0);
    let flushing = false;
    let dataSubscription;
    let exitSubscription;

    const detach = () => {
      if (detached) return;
      detached = true;
      this.#handles.delete(handle);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      pending = Buffer.alloc(0);
      outstanding = 0;
      try { terminal.kill('SIGHUP'); } catch { /* PTY may already have exited. */ }
    };

    const flush = () => {
      if (flushing || detached) return;
      flushing = true;
      try {
        while (!detached && pending.length && outstanding < this.flowControlBytes) {
          let length = Math.min(pending.length, this.flowControlBytes - outstanding);
          // Never split a UTF-8 code point between WebSocket messages.
          while (length < pending.length && length > 0 && (pending[length] & 0xc0) === 0x80) length -= 1;
          if (!length) break;
          const output = pending.subarray(0, length).toString('utf8');
          pending = pending.subarray(length);
          outstanding += length;
          try { onData(output); } catch { detach(); }
        }
      } finally {
        flushing = false;
        if (!detached && !pending.length && outstanding < this.flowControlBytes) terminal.resume();
      }
    };

    const handle = {
      write(data) {
        if (detached) throw failure('终端连接已断开。', 'TERMINAL_DETACHED');
        if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES) throw failure('单次终端输入不能超过 32 KiB。', 'INPUT_TOO_LARGE');
        terminal.write(data);
      },
      resize(nextCols, nextRows) {
        if (detached) throw failure('终端连接已断开。', 'TERMINAL_DETACHED');
        const next = dimensions(nextCols, nextRows);
        terminal.resize(next.cols, next.rows);
      },
      ack(bytes) {
        if (detached) return;
        if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > outstanding) throw failure('无效的终端数据确认。', 'INVALID_ACK');
        outstanding -= bytes;
        flush();
      },
      detach,
    };

    dataSubscription = terminal.onData((data) => {
      if (detached) return;
      terminal.pause();
      const chunk = Buffer.from(data);
      if (outstanding + pending.length + chunk.length > MAX_OUTPUT_BYTES) {
        detach();
        try { onExit({ exitCode: 1, reason: 'OUTPUT_LIMIT' }); } catch { /* Consumer disconnected. */ }
        return;
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      flush();
    });
    exitSubscription = terminal.onExit((event) => {
      if (detached) return;
      detached = true;
      this.#handles.delete(handle);
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      pending = Buffer.alloc(0);
      try { onExit(event); } catch { /* Consumer disconnected. */ }
    });
    this.#handles.add(handle);
    return handle;
  }

  async close() {
    this.#closed = true;
    for (const handle of this.#handles) handle.detach();
    await this.#mutations;
    // Deliberately leave the isolated tmux server and shell processes alive.
  }
}

export default TerminalManager;
