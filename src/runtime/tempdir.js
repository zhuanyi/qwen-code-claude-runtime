// @ts-check
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Private (0700) temp dir, removed afterwards. writeFile returns the written path (mode 0600).
 * @template T
 * @param {(dir: string, writeFile: (name: string, content: string) => Promise<string>) => Promise<T>} fn
 */
export async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qcr-'));
  try {
    await fs.chmod(dir, 0o700);
    return await fn(dir, async (name, content) => {
      const p = path.join(dir, name);
      await fs.writeFile(p, content, { mode: 0o600 });
      return p;
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Best-effort removal of stale `qcr-*` temp dirs owned by this user (older than maxAgeMs). */
export function cleanStaleTempDirs({ dir = os.tmpdir(), maxAgeMs = 86400000, now = Date.now() } = {}) {
  try {
    for (const name of fsSync.readdirSync(dir)) {
      if (!name.startsWith('qcr-')) continue;
      try {
        const p = path.join(dir, name);
        const st = fsSync.lstatSync(p);
        if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
        if (typeof process.getuid === 'function' && st.uid !== process.getuid()) continue;
        fsSync.rmSync(p, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
