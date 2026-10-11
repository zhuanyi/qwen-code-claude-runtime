import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createBackend } from '../src/backends/index.js';
import { startServer } from '../src/server/http.js';
import { SessionStore } from '../src/server/sessions.js';

const FAKE = new URL('./fake-reasonix.js', import.meta.url).pathname;
const QCR = new URL('../bin/qcr.js', import.meta.url).pathname;
const fixture = (n) => new URL(`./fixtures/reasonix/${n}`, import.meta.url).pathname;
const SID = '20261011-180000.000000001-mock-model';
const TOKEN = 'test-token-0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return fn(); };

/** A temp dir whose bin/ holds `reasonix` -> fake-reasonix.js, prepended to PATH like a real install. */
function sandbox() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qcr-rx-')));
  const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
  fs.symlinkSync(FAKE, path.join(bin, 'reasonix'));
  const cwd = path.join(tmp, 'proj'); fs.mkdirSync(cwd);
  const logs = { argv: path.join(tmp, 'argv.log'), stdin: path.join(tmp, 'stdin.log'), gc: path.join(tmp, 'gc.pid') };
  return { tmp, bin, cwd, logs, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}

/** process.env.PATH minus every dir that holds `bin`, so a real install on the dev machine can't leak into "not on PATH" tests. */
const pathWithout = (bin) => (process.env.PATH ?? '').split(path.delimiter)
  .filter((d) => ![bin, `${bin}.cmd`, `${bin}.exe`].some((n) => fs.existsSync(path.join(d, n)))).join(path.delimiter);

async function boot({ fake = {}, cfg = {}, onPath = true, extraEnv = {} } = {}) {
  const sb = sandbox();
  const env = { ...process.env, ...extraEnv, PATH: onPath ? sb.PATH : pathWithout('reasonix'), FAKE_REASONIX_ARGV_LOG: sb.logs.argv,
    FAKE_REASONIX_STDIN_LOG: sb.logs.stdin, FAKE_REASONIX_SESSION_ID: SID, FAKE_REASONIX_KNOWN_SESSIONS: SID,
    ...Object.fromEntries(Object.entries(fake).map(([k, v]) => [k === 'fixture' ? 'FAKE_REASONIX_FIXTURE' : 'FAKE_REASONIX_' + k, k === 'fixture' ? fixture(v) : v])) };
  const backend = createBackend('reasonix', { permissionMode: cfg.permissionMode, cwd: sb.cwd });
  const s = await startServer({ bin: 'reasonix', backend, cwd: sb.cwd, home: path.join(sb.tmp, 'home'), env,
    sessions: new SessionStore(), ...cfg }, { port: 0, token: TOKEN, log: () => {} });
  const base = `http://127.0.0.1:${s.port}`;
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return {
    ...sb, base,
    post: (b, signal) => fetch(base + '/v1/chat/completions', { signal, method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(b) }),
    argv: () => read(sb.logs.argv), stdin: () => read(sb.logs.stdin),
    close: async () => { await s.close(); fs.rmSync(sb.tmp, { recursive: true, force: true }); },
  };
}

async function sse(res) {
  const raw = await res.text();
  const frames = raw.split('\n\n').filter(Boolean).map((f) => f.replace(/^data: /, ''));
  assert.equal(frames.at(-1), '[DONE]');
  const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
  return { chunks, raw, text: chunks.map((c) => c.choices[0].delta.content ?? '').join(''), last: chunks.at(-1) };
}
const body = (messages, extra = {}) => ({ model: 'reasonix/deepseek-flash', stream: true, messages, ...extra });
const user = (content) => ({ role: 'user', content });
const noDanger = (b) => b.argv().flat().forEach((a) => assert.ok(!/dangerously|bypass|yolo|^-y$|^--auto$|^--takeover$/i.test(a), a));

test('reasonix: streaming text turn maps to SSE with usage, footer and [DONE]', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' } });
  try {
    const res = await b.post(body([user('hi')]));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-should-retry'), 'false');
    const r = await sse(res);
    assert.equal(r.text, 'Hello from mock.\n\n_reasonix · 1 turns_');
    assert.equal(r.last.choices[0].finish_reason, 'stop');
    assert.deepEqual(r.last.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } });
    assert.ok(!r.raw.includes('tool_calls'));
    const [argv] = b.argv();
    assert.deepEqual(argv, ['-p', '--output-format', 'stream-json', '--model', 'deepseek-flash', '--permission-mode', 'manual', '--dir', b.cwd]);
    assert.deepEqual(b.stdin(), ['hi']); // the prompt travels on stdin, raw
    noDanger(b);
  } finally { await b.close(); }
});

test('reasonix: child env keeps provider keys (incl. ANTHROPIC_*) but never the shim token', async () => {
  const envLog = path.join(os.tmpdir(), `qcr-rx-env-${process.pid}.json`);
  const b = await boot({ fake: { fixture: 'text-turn.jsonl', ENV_LOG: envLog },
    extraEnv: { DEEPSEEK_API_KEY: 'dummy-deepseek', ANTHROPIC_API_KEY: 'dummy-anthropic', QCR_TOKEN: TOKEN } });
  try {
    await sse(await b.post(body([user('hi')])));
    const keys = JSON.parse(fs.readFileSync(envLog, 'utf8'));
    assert.ok(keys.includes('DEEPSEEK_API_KEY') && keys.includes('ANTHROPIC_API_KEY'), keys.join(','));
    assert.ok(!keys.includes('QCR_TOKEN'));
  } finally { await b.close(); fs.rmSync(envLog, { force: true }); }
});

test('reasonix: tool use renders progress lines and never tool_calls', async () => {
  const b = await boot({ fake: { fixture: 'tool-turn.jsonl' } });
  try {
    const r = await sse(await b.post(body([user('read notes')])));
    assert.match(r.text, /^\n> ⚙ read_file · notes\.txt\nTool result received: done\./);
    assert.ok(!r.raw.includes('tool_calls'));
  } finally { await b.close(); }
});

test('reasonix: permission denial is reported with a hint', async () => {
  const b = await boot({ fake: { fixture: 'permission-denied.jsonl' } });
  try {
    const r = await sse(await b.post(body([user('write it')])));
    assert.match(r.text, /> ✗ write_file failed\n/);
    assert.match(r.text, /> ⛔ Reasonix was denied: write_file\. Allow them via QCR_PERMISSION_MODE=acceptEdits or QCR_ALLOWED_TOOLS\./);
  } finally { await b.close(); }
});

test('reasonix: second turn resumes a copy of the session with only the new message', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' } });
  try {
    const m1 = [user('first question')];
    const r1 = await sse(await b.post(body(m1)));
    const m2 = [...m1, { role: 'assistant', content: r1.text }, user('<system-reminder>qwen only</system-reminder>second question')];
    await sse(await b.post(body(m2)));
    const [a1, a2] = b.argv();
    assert.ok(!a1.includes('--resume'));
    assert.deepEqual(a2.slice(a2.indexOf('--resume'), a2.indexOf('--resume') + 3), ['--resume', SID, '--copy']);
    assert.equal(b.stdin()[1], 'second question');
  } finally { await b.close(); }
});

test('reasonix: unknown session falls back to a fresh session with the transcript', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl', KNOWN_SESSIONS: 'nothing' } });
  try {
    const m1 = [user('first question')];
    const r1 = await sse(await b.post(body(m1)));
    const r2 = await sse(await b.post(body([...m1, { role: 'assistant', content: r1.text }, user('second question')])));
    assert.match(r2.text, /^Hello from mock\./);
    const argv = b.argv();
    assert.equal(argv.length, 3);
    assert.ok(argv[1].includes('--resume') && !argv[2].includes('--resume'));
    assert.match(b.stdin()[2], /<prior_conversation>[\s\S]*first question[\s\S]*<\/prior_conversation>[\s\S]*second question$/);
  } finally { await b.close(); }
});

test('reasonix: missing API key before any output -> 401 reasonix_not_configured', async () => {
  const b = await boot({ fake: { fixture: 'missing-key.jsonl' } });
  try {
    const res = await b.post(body([user('hi')]));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-should-retry'), 'false');
    const e = (await res.json()).error;
    assert.equal(e.code, 'reasonix_not_configured');
    assert.match(e.message, /set DEEPSEEK_API_KEY/);
  } finally { await b.close(); }
});

test('reasonix: auth failure after the stream started -> warning line, stream still ends with [DONE]', async () => {
  const b = await boot({ fake: { fixture: 'auth-401.jsonl' } });
  try {
    const r = await sse(await b.post(body([user('hi')])));
    assert.match(r.text, /> ⚠ Reasonix's model provider rejected the API key/);
  } finally { await b.close(); }
});

test('reasonix: binary not on PATH -> 424 reasonix_not_found', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' }, onPath: false });
  try {
    const res = await b.post(body([user('hi')]));
    assert.equal(res.status, 424);
    assert.equal((await res.json()).error.code, 'reasonix_not_found');
  } finally { await b.close(); }
});

test('reasonix: concurrency cap returns qcr_busy', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl', DELAY_MS: '100' }, cfg: { maxConcurrent: 1 } });
  try {
    const first = b.post(body([user('one')]));
    await sleep(150);
    const res = await b.post(body([user('two')]));
    assert.equal(res.status, 429);
    const e = (await res.json()).error;
    assert.equal(e.code, 'qcr_busy');
    assert.equal(e.message, 'qcr is already running 1 Reasonix turns; try again when one finishes');
    await sse(await first);
  } finally { await b.close(); }
});

test('reasonix: claude-code model ids are rejected and /v1/models lists reasonix ids', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' } });
  try {
    const res = await b.post({ ...body([user('hi')]), model: 'claude-code/sonnet' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /reasonix\/<model>/);
    const models = await (await fetch(b.base + '/v1/models', { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    assert.deepEqual(models.data.map((m) => m.id), ['reasonix/deepseek-flash', 'reasonix/deepseek-pro']);
    assert.equal(b.argv().length, 0);
  } finally { await b.close(); }
});

test('reasonix: schema side query returns the JSON as a respond_in_schema tool call', async () => {
  const sb = sandbox();
  const json = path.join(sb.tmp, 'json-turn.jsonl'); // the recorded text turn, with a JSON reply
  fs.writeFileSync(json, fs.readFileSync(fixture('text-turn.jsonl'), 'utf8').replaceAll('Hello from mock.', '```json\\n{\\"answer\\":true}\\n```'));
  const b = await boot({ fake: { FIXTURE: json } });
  try {
    const schema = { type: 'object', properties: { answer: { type: 'boolean' } }, required: ['answer'] };
    const res = await b.post({ model: 'reasonix/deepseek-flash', messages: [{ role: 'system', content: 'You classify.' }, user('Is it?')],
      tools: [{ type: 'function', function: { name: 'respond_in_schema', parameters: schema } }], tool_choice: 'required' });
    assert.equal(res.status, 200);
    const c = await res.json();
    assert.equal(c.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(JSON.parse(c.choices[0].message.tool_calls[0].function.arguments), { answer: true });
    const stdin = b.stdin()[0];
    assert.match(stdin, /<instructions>\nYou classify\.\n<\/instructions>/);
    assert.match(stdin, /Is it\?\n\nReply with only a JSON object that matches this JSON Schema/);
    assert.ok(!b.argv()[0].includes('--resume'));
  } finally { await b.close(); fs.rmSync(sb.tmp, { recursive: true, force: true }); }
});

test('reasonix: abort kills a grandchild that ignores the wrapper being signalled', async () => {
  const sb = sandbox();
  const gcFile = path.join(sb.tmp, 'gc.pid');
  // No fixture: the fake hangs before printing anything, so the turn is still running when the client aborts.
  const b = await boot({ fake: { HANG_MS: '30000', GRANDCHILD_PID_FILE: gcFile } });
  try {
    const ac = new AbortController();
    const p = b.post(body([user('hi')]), ac.signal).then((r) => r.text()).catch(() => {});
    assert.ok(await until(() => fs.existsSync(gcFile)));
    const gc = Number(fs.readFileSync(gcFile, 'utf8'));
    assert.ok(alive(gc));
    ac.abort();
    await p;
    // Well under the runner's 3 s SIGKILL grace: the group SIGTERM itself must reach the grandchild.
    assert.ok(await until(() => !alive(gc), 1000), 'grandchild still running after abort');
  } finally { await b.close(); fs.rmSync(sb.tmp, { recursive: true, force: true }); }
});

test('reasonix: end to end through bin/qcr.js with QCR_BACKEND=reasonix and the fake on PATH', async () => {
  const sb = sandbox();
  const home = path.join(sb.tmp, 'home'); fs.mkdirSync(home);
  const child = spawn(process.execPath, [QCR, 'serve', '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'], env: {
    ...process.env, PATH: sb.PATH, HOME: home, QCR_BACKEND: 'reasonix', QCR_TOKEN: TOKEN, QCR_CWD: sb.cwd,
    FAKE_REASONIX_FIXTURE: fixture('text-turn.jsonl'), FAKE_REASONIX_ARGV_LOG: sb.logs.argv } });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  try {
    assert.ok(await until(() => /listening on http:\/\/127\.0\.0\.1:\d+\/v1 \(backend: reasonix/.test(err), 5000), err);
    const port = /127\.0\.0\.1:(\d+)/.exec(err)[1];
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body([user('hi')])) });
    const r = await sse(res);
    assert.match(r.text, /^Hello from mock\./);
    const argv = JSON.parse(fs.readFileSync(sb.logs.argv, 'utf8').trim());
    assert.equal(argv[argv.indexOf('--dir') + 1], sb.cwd);
    assert.match(err, /claude-only/); // MCP/skills note
  } finally { child.kill(); fs.rmSync(sb.tmp, { recursive: true, force: true }); }
});
