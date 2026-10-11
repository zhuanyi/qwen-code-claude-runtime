// @ts-check
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
