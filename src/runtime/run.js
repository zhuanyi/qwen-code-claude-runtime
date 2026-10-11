// @ts-check
import { spawn } from 'node:child_process';
import { createStreamParser } from './parser.js';
import { classifyError } from './errors.js';

const GRACE_MS = 3000;
const PIPE_GRACE_MS = 2000;

/**
 * Spawn `claude` (no shell), send one stream-json user message on stdin, yield normalized events.
 * @param {{bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, prompt: string, signal?: AbortSignal}} p
 * @returns {{events: AsyncIterable<any>, done: Promise<{exitCode: number|null, stderr: string}>}}
 */
export function runClaude({ bin, args, cwd, env, prompt, signal }) {
  const child = spawn(bin, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let spawnError = null;
  let exited = false;
  /** @type {NodeJS.Timeout[]} */ const timers = [];

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { if (stderr.length < 65536) stderr = (stderr + d).slice(0, 65536); });
  child.stdin?.on('error', () => {}); // EPIPE when the child exits early
  child.stdin?.end(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');

  /** @type {(v: {exitCode: number|null, stderr: string}) => void} */ let resolveDone = () => {};
  const done = new Promise((resolve) => {
    resolveDone = resolve;
    child.on('error', (e) => { spawnError = e; exited = true; resolve({ exitCode: null, stderr }); });
    child.on('close', (code) => { exited = true; timers.forEach(clearTimeout); resolve({ exitCode: code, stderr }); });
  });

  /** Ask politely now, force after the grace period. */
  const terminate = () => {
    if (exited) return;
    child.kill('SIGTERM');
    const t = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, GRACE_MS);
    t.unref();
    timers.push(t);
  };
  if (signal) {
    if (signal.aborted) terminate();
    else signal.addEventListener('abort', terminate, { once: true });
  }

  const queue = /** @type {string[]} */ ([]);
  let ended = false;
  /** @type {(() => void) | null} */ let wake = null;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { queue.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    wake?.();
  });
  child.stdout.on('end', () => { if (buf) queue.push(buf); buf = ''; ended = true; wake?.(); });
  child.on('error', () => { ended = true; wake?.(); });
  // A grandchild may keep the pipes open after claude exits; stop waiting for 'end'/'close' after a short grace.
  child.on('exit', (code) => {
    exited = true;
    const t = setTimeout(() => {
      if (!ended) { if (buf) queue.push(buf); buf = ''; ended = true; child.stdout.destroy(); wake?.(); }
      resolveDone({ exitCode: code, stderr });
    }, PIPE_GRACE_MS);
    t.unref();
  });

  async function* events() {
    const parser = createStreamParser();
    let sawResult = false;
    try {
      for (;;) {
        while (queue.length) {
          for (const ev of parser.push(/** @type {string} */ (queue.shift()))) {
            yield ev;
            if (ev.type === 'result') {
              sawResult = true;
              const t = setTimeout(terminate, GRACE_MS);
              t.unref();
              timers.push(t);
              return;
            }
          }
        }
        if (ended) break;
        await new Promise((r) => { wake = /** @type {() => void} */ (r); });
        wake = null;
      }
      const r = await done;
      if (signal?.aborted) return;
      throw classifyError({ spawnError, stderr: r.stderr, exitCode: r.exitCode });
    } finally {
      if (!sawResult) terminate();
    }
  }
  return { events: events(), done: /** @type {any} */ (done) };
}
