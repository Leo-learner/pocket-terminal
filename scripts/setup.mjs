import { randomBytes } from 'node:crypto';
import { mkdir, open, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPasswordRecord } from '../server/auth.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.resolve(process.env.POCKET_CONFIG || path.join(projectRoot, '.runtime/auth.json'));
const directory = path.dirname(configPath);
const keyPath = path.join(directory, 'access-key.txt');

async function createPrivateFile(filename, content) {
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(content, 'utf8'); }
  finally { await handle.close(); }
}

async function setup() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Configuration directory must be a real directory.');
  for (const filename of [configPath, keyPath]) {
    try { await lstat(filename); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Existing credentials were preserved. Move the existing configuration and key files before creating new ones.');
  }
  const password = randomBytes(32).toString('base64url');
  const passwordRecord = await createPasswordRecord(password);
  await createPrivateFile(keyPath, `${password}\n`);
  try { await createPrivateFile(configPath, `${JSON.stringify({ version: 1, password: passwordRecord }, null, 2)}\n`); }
  catch (error) { await unlink(keyPath); throw error; }
  process.stdout.write(`Authentication configured. Access key saved privately at:\n${keyPath}\n`);
}

setup().catch(error => {
  process.stderr.write(`Setup failed: ${error.message}\n`);
  process.exitCode = 1;
});
