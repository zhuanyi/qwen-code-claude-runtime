#!/usr/bin/env node
// Fake `reasonix` for tests: replays a recorded `reasonix -p --output-format stream-json` transcript.
// Behaviour is driven by FAKE_REASONIX_* env vars (see README in fixtures/).
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_REASONIX_ARGV_LOG) fs.appendFileSync(env.FAKE_REASONIX_ARGV_LOG, JSON.stringify(argv) + '\n');
if (env.FAKE_REASONIX_ENV_LOG) fs.writeFileSync(env.FAKE_REASONIX_ENV_LOG, JSON.stringify(Object.keys(env).filter((k) => /^(ANTHROPIC_|QCR_|DEEPSEEK_)/.test(k)).sort()));
if (env.FAKE_REASONIX_PID_FILE) fs.writeFileSync(env.FAKE_REASONIX_PID_FILE, String(process.pid));
// Like the npm launcher, keep a child running in our process group that only dies if the group is signalled.
if (env.FAKE_REASONIX_GRANDCHILD_PID_FILE) {
  const gc = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0));setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  fs.writeFileSync(env.FAKE_REASONIX_GRANDCHILD_PID_FILE, String(gc.pid));
  process.on('SIGTERM', () => {}); // the wrapper itself ignores SIGTERM, as spawnSync does not forward it
}

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const d of process.stdin) stdin += d;
if (env.FAKE_REASONIX_STDIN_LOG) fs.appendFileSync(env.FAKE_REASONIX_STDIN_LOG, JSON.stringify(stdin) + '\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sid = env.FAKE_REASONIX_SESSION_ID;
const out = (s) => process.stdout.write(s + '\n');

const ri = argv.indexOf('--resume');
if (ri >= 0 && !(env.FAKE_REASONIX_KNOWN_SESSIONS ?? '').split(',').includes(argv[ri + 1])) {
  process.stderr.write(`error: no session matches "${argv[ri + 1]}"\n`);
  process.exit(1);
}

let isError = false;
if (env.FAKE_REASONIX_FIXTURE) {
  for (const line of fs.readFileSync(env.FAKE_REASONIX_FIXTURE, 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(line);
    if (o.type === 'result') { isError = o.is_error === true; if (sid && 'session_id' in o) o.session_id = sid; }
    out(JSON.stringify(o));
    if (env.FAKE_REASONIX_DELAY_MS) await sleep(Number(env.FAKE_REASONIX_DELAY_MS));
  }
}
if (env.FAKE_REASONIX_HANG_MS) await sleep(Number(env.FAKE_REASONIX_HANG_MS));
process.exitCode = Number(env.FAKE_REASONIX_EXIT ?? (isError ? 1 : 0));
