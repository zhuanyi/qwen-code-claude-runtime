// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const tokenPath = (/** @type {string} */ home) => path.join(home, '.config', 'qwen-claude-runtime', 'token');

/** Read a token file, refusing group/other-accessible or foreign-owned files. @param {string} file */
function readChecked(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    if ((st.mode & 0o077) !== 0) throw new Error(`${file} is accessible by group/others; run chmod 600 on it`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${file} is not owned by the current user`);
    return fs.readFileSync(fd, 'utf8').trim();
  } finally { fs.closeSync(fd); }
}

/** QCR_TOKEN if set (>= 16 chars), else a persisted random token (0600). */
export function loadOrCreateToken({ env, home }) {
  if (env.QCR_TOKEN && env.QCR_TOKEN.length >= 16) return env.QCR_TOKEN;
  const file = tokenPath(home);
  try {
    const t = readChecked(file);
    if (t.length >= 16) return t;
  } catch (e) { if (/** @type {any} */ (e).code !== 'ENOENT') throw e; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, token + '\n', { flag: 'wx', mode: 0o600 });
    return token;
  } catch (e) {
    if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
    const t = readChecked(file);
    if (t.length >= 16) return t;
    throw new Error(`${file} exists but does not contain a valid token; delete it`);
  }
}
