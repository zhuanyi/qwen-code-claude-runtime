#!/usr/bin/env node
// Fake `claude` for tests. Behaviour is driven by FAKE_CLAUDE_* env vars (see README in fixtures/).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_CLAUDE_ARGV_LOG) fs.appendFileSync(env.FAKE_CLAUDE_ARGV_LOG, JSON.stringify(argv) + '\n');
if (env.FAKE_CLAUDE_PID_FILE) fs.writeFileSync(env.FAKE_CLAUDE_PID_FILE, String(process.pid));
const si = argv.indexOf('--system-prompt-file');
if (env.FAKE_CLAUDE_SYSPROMPT_LOG && si >= 0) fs.appendFileSync(env.FAKE_CLAUDE_SYSPROMPT_LOG, fs.readFileSync(argv[si + 1], 'utf8') + '\n');
// A grandchild that keeps our stdout open after we exit.
if (env.FAKE_CLAUDE_GRANDCHILD_MS) {
  spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Number(env.FAKE_CLAUDE_GRANDCHILD_MS)})`], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref();
}

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const d of process.stdin) stdin += d;
if (env.FAKE_CLAUDE_STDIN_LOG) fs.appendFileSync(env.FAKE_CLAUDE_STDIN_LOG, stdin + '\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = env.FAKE_CLAUDE_SESSION_ID;
const out = (s) => process.stdout.write(s + '\n');

if (env.FAKE_CLAUDE_START_DELAY_MS) await sleep(Number(env.FAKE_CLAUDE_START_DELAY_MS));

const ri = argv.indexOf('--resume');
if (ri >= 0) {
  const known = (env.FAKE_CLAUDE_KNOWN_SESSIONS ?? '').split(',');
  if (!known.includes(argv[ri + 1])) {
    const msg = `No conversation found with session ID: ${argv[ri + 1]}`;
    process.stderr.write(msg + '\n');
    out(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid ?? 'x',
      errors: [msg], total_cost_usd: 0, usage: {}, permission_denials: [], num_turns: 0 }));
    process.exit(1);
  }
}

if (env.FAKE_CLAUDE_FIXTURE) {
  const lines = fs.readFileSync(env.FAKE_CLAUDE_FIXTURE, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let o = JSON.parse(line);
    if (sid && 'session_id' in o) o.session_id = sid;
    out(JSON.stringify(o));
    if (env.FAKE_CLAUDE_DELAY_MS) await sleep(Number(env.FAKE_CLAUDE_DELAY_MS));
  }
}
if (env.FAKE_CLAUDE_STDERR) process.stderr.write(env.FAKE_CLAUDE_STDERR + '\n');
process.exitCode = Number(env.FAKE_CLAUDE_EXIT ?? 0);
