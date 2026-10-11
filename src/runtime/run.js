// @ts-check
import { spawn } from 'node:child_process';

const GRACE_MS = 3000;
const PIPE_GRACE_MS = 2000;

/**
 * Spawn an agent CLI (no shell), write `stdin`, and yield the events its `parser` produces until a `result`.
 * With `killGroup`, the child leads its own process group and termination signals the whole group; use it
 * for CLIs launched through a wrapper that does not forward signals (the npm `reasonix` launcher).
 * @param {{bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin: string, signal?: AbortSignal,
 *   parser: {push(line: string): any[]}, classify: (p: any) => Error, killGroup?: boolean}} p
 * @returns {{events: AsyncIterable<any>, done: Promise<{exitCode: number|null, stderr: string}>}}
 */
export function runAgent({ bin, args, cwd, env, stdin, signal, parser, classify, killGroup = false }) {
  const child = spawn(bin, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: killGroup });
  let stderr = '';
  let spawnError = null;
  let exited = false;
  /** @type {NodeJS.Timeout[]} */ const timers = [];

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { if (stderr.length < 65536) stderr = (stderr + d).slice(0, 65536); });
  child.stdin?.on('error', () => {}); // EPIPE when the child exits early
  child.stdin?.end(stdin);

  /** @type {(v: {exitCode: number|null, stderr: string}) => void} */ let resolveDone = () => {};
  const done = new Promise((resolve) => {
    resolveDone = resolve;
    child.on('error', (e) => { spawnError = e; exited = true; resolve({ exitCode: null, stderr }); });
    child.on('close', (code) => { exited = true; timers.forEach(clearTimeout); resolve({ exitCode: code, stderr }); });
  });

  /** Ask politely now, force after the grace period. */
  const kill = (/** @type {NodeJS.Signals} */ sig) => {
    if (killGroup && child.pid) { try { process.kill(-child.pid, sig); return; } catch { /* group gone; fall back */ } }
    child.kill(sig);
  };
  const terminate = () => {
    if (exited) return;
    kill('SIGTERM');
    const t = setTimeout(() => { if (!exited) kill('SIGKILL'); }, GRACE_MS);
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
      throw classify({ spawnError, stderr: r.stderr, exitCode: r.exitCode });
    } finally {
      if (!sawResult) terminate();
    }
  }
  return { events: events(), done: /** @type {any} */ (done) };
}
