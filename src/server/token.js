// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const tokenPath = (/** @type {string} */ home) => path.join(home, '.config', 'qwen-claude-runtime', 'token');

/** QCR_TOKEN if set (>= 16 chars), else a persisted random token (0600). */
export function loadOrCreateToken({ env, home }) {
  if (env.QCR_TOKEN && env.QCR_TOKEN.length >= 16) return env.QCR_TOKEN;
  const file = tokenPath(home);
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch { /* create below */ }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}
