import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/http.js';
import { SessionStore } from '../src/server/sessions.js';

const FAKE = new URL('./fake-claude.js', import.meta.url).pathname;
const fixture = (n) => new URL(`./fixtures/${n}`, import.meta.url).pathname;
const SID = '99999999-0000-4000-8000-000000000001';
const TOKEN = 'test-token-0123456789abcdef';

/** Boot a shim against the fake claude. */
async function boot({ fake = {}, cfg = {}, home } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qcr-it-'));
  const argvLog = path.join(tmp, 'argv.log');
  const stdinLog = path.join(tmp, 'stdin.log');
  const pidFile = path.join(tmp, 'pid');
  const sysLog = path.join(tmp, 'sys.log');
  const cwd = path.join(tmp, 'proj'); fs.mkdirSync(cwd);
  home ??= path.join(tmp, 'home'); fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, FAKE_CLAUDE_ARGV_LOG: argvLog, FAKE_CLAUDE_STDIN_LOG: stdinLog, FAKE_CLAUDE_PID_FILE: pidFile, FAKE_CLAUDE_SYSPROMPT_LOG: sysLog, FAKE_CLAUDE_SESSION_ID: SID,
    ...Object.fromEntries(Object.entries(fake).map(([k, v]) => [k.startsWith('FAKE_') ? k : 'FAKE_CLAUDE_' + k, v])) };
  if (fake.fixture) env.FAKE_CLAUDE_FIXTURE = fixture(fake.fixture);
  delete env.FAKE_CLAUDE_fixture;
  const s = await startServer({ bin: FAKE, cwd, home, env, sessions: new SessionStore(), ...cfg }, { port: 0, token: TOKEN, log: () => {} });
  const base = `http://127.0.0.1:${s.port}`;
  const post = (body, headers = {}, signal) => fetch(base + '/v1/chat/completions', {
    signal, method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return {
    base, cwd, home, post, port: s.port,
    argv: () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    stdin: () => (fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, 'utf8') : ''),
    pid: () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0),
    sysPrompt: () => (fs.existsSync(sysLog) ? fs.readFileSync(sysLog, 'utf8') : ''),
    close: async () => { await s.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

async function sse(res) {
  const raw = await res.text();
  const frames = raw.split('\n\n').filter(Boolean).map((f) => f.replace(/^data: /, ''));
  assert.equal(frames.at(-1), '[DONE]');
  const chunks = frames.slice(0, -1).map((f) => JSON.parse(f));
  const text = chunks.map((c) => c.choices[0].delta.content ?? '').join('');
  return { chunks, text, usage: chunks.find((c) => c.usage)?.usage, raw };
}

const body = (messages, extra = {}) => ({ model: 'claude-code/sonnet', stream: true, messages, ...extra });
const user = (content) => ({ role: 'user', content });
const noDanger = (b) => b.argv().flat().forEach((a) => assert.ok(!/dangerously|bypassPermissions/.test(a)));

test('streaming text turn', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' } });
  try {
    const res = await b.post(body([user('hi')]));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('x-should-retry'), 'false');
    const r = await sse(res);
    assert.ok(r.text.startsWith('Hello world.'));
    assert.match(r.text, /_claude-code · 1 turns · \$0\.0010_/);
    assert.equal(r.usage.prompt_tokens, 1003);
    assert.equal(r.usage.completion_tokens, 5);
    assert.equal(r.usage.prompt_tokens_details.cached_tokens, 900);
    assert.equal(r.chunks.at(-1).choices[0].finish_reason, 'stop');
    assert.ok(!r.raw.includes('tool_calls'));
    assert.match(b.stdin(), /"content":"hi"/);
    noDanger(b);
  } finally { await b.close(); }
});

test('tool turn shows progress and never emits tool_calls', async () => {
  const b = await boot({ fake: { fixture: 'tool-turn.jsonl' } });
  try {
    const r = await sse(await b.post(body([user('read a.txt')])));
    assert.match(r.text, /> ⚙ Read · \/work\/project\/a\.txt/);
    assert.match(r.text, /just one word: "hello\."/);
    assert.ok(!r.raw.includes('tool_calls'));
  } finally { await b.close(); }
});

test('permission denials are explained, failed tools flagged', async () => {
  const b = await boot({ fake: { fixture: 'permission-denied.jsonl' } });
  try {
    const r = await sse(await b.post(body([user('clean')])));
    assert.match(r.text, /✗ Bash failed/);
    assert.match(r.text, /⛔ Claude was denied: Bash/);
  } finally { await b.close(); }
});

test('second turn resumes with fork and sends only the new message', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl', KNOWN_SESSIONS: SID } });
  try {
    const m1 = [user('first question')];
    const r1 = await sse(await b.post(body(m1)));
    const m2 = [...m1, { role: 'assistant', content: r1.text }, user('<system-reminder>qwen only</system-reminder>second question')];
    await sse(await b.post(body(m2)));
    const [a1, a2] = b.argv();
    assert.ok(!a1.includes('--resume'));
    assert.deepEqual(a2.slice(a2.indexOf('--resume'), a2.indexOf('--resume') + 3), ['--resume', SID, '--fork-session']);
    const stdins = b.stdin().split('\n').filter(Boolean);
    assert.match(stdins[1], /second question/);
    assert.ok(!/first question|prior_conversation|qwen only/.test(stdins[1]));
    noDanger(b);
  } finally { await b.close(); }
});

test('unknown session falls back to a fresh session with transcript', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl', KNOWN_SESSIONS: 'nothing' } });
  try {
    const m1 = [user('first question')];
    const r1 = await sse(await b.post(body(m1)));
    const m2 = [...m1, { role: 'assistant', content: r1.text }, user('second question')];
    const r2 = await sse(await b.post(body(m2)));
    assert.match(r2.text, /^Hello world\./);
    const argv = b.argv();
    assert.equal(argv.length, 3);
    assert.ok(argv[1].includes('--resume'));
    assert.ok(!argv[2].includes('--resume'));
    const last = b.stdin().trim().split('\n').at(-1);
    assert.match(last, /<prior_conversation>/);
    assert.match(last, /first question/);
    assert.match(last, /second question/);
  } finally { await b.close(); }
});

test('not-logged-in result after init is shown as content', async () => {
  const b = await boot({ fake: { fixture: 'not-logged-in.jsonl' } });
  try {
    const res = await b.post(body([user('hi')]));
    assert.equal(res.status, 200);
    const r = await sse(res);
    assert.match(r.text, /Claude Code is not logged in/);
    assert.equal(r.chunks.at(-1).choices[0].finish_reason, 'stop');
  } finally { await b.close(); }
});

test('rate limit message includes reset time', async () => {
  const b = await boot({ fake: { fixture: 'rate-limited.jsonl' } });
  try {
    const r = await sse(await b.post(body([user('hi')])));
    assert.match(r.text, /Claude quota exhausted; will reset at 2030-01-01T00:00:00\.000Z/);
  } finally { await b.close(); }
});

test('exit without output and "Not logged in" stderr -> HTTP 401', async () => {
  const b = await boot({ fake: { STDERR: 'Not logged in', EXIT: '1' } });
  try {
    const res = await b.post(body([user('hi')]));
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-should-retry'), 'false');
    assert.equal((await res.json()).error.code, 'claude_not_logged_in');
  } finally { await b.close(); }
});

test('missing claude binary -> 503', async () => {
  const b = await boot({ cfg: { bin: '/nonexistent/claude-bin' } });
  try {
    const res = await b.post(body([user('hi')]));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'claude_not_found');
  } finally { await b.close(); }
});

test('auth, host and content-type checks', async () => {
  const b = await boot();
  try {
    for (const authorization of [undefined, 'Bearer wrong-token-0123456789abcd', 'Bearer short']) {
      const res = await fetch(b.base + '/v1/models', { headers: authorization ? { authorization } : {} });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error.code, 'invalid_shim_token');
    }
    const ok = await fetch(b.base + '/v1/models', { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual((await ok.json()).data.map((m) => m.id), ['claude-code/sonnet', 'claude-code/opus', 'claude-code/haiku']);
    assert.equal(ok.headers.get('access-control-allow-origin'), null);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: b.port, path: '/v1/models', headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}` } },
        (r) => { r.resume(); resolve(r.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    const res = await b.post(body([user('x')]), { 'content-type': 'text/plain' });
    assert.equal(res.status, 415);
    const bad = await fetch(b.base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    const badModel = await b.post({ model: 'gpt-4', messages: [user('x')] });
    assert.equal(badModel.status, 400);
    assert.deepEqual(b.argv(), []);
  } finally { await b.close(); }
});

test('side query with forced function returns tool_calls from structured output', async () => {
  const b = await boot({ fake: { fixture: 'side-query-json.jsonl' } });
  try {
    const schema = { type: 'object', properties: { answer: { type: 'boolean' }, why: { type: 'string' } }, required: ['answer', 'why'] };
    const res = await b.post({ model: 'claude-code/haiku', messages: [{ role: 'system', content: 'Be terse.' }, user('Is the sky blue?')],
      tools: [{ type: 'function', function: { name: 'respond_in_schema', parameters: schema } }], tool_choice: 'required' });
    assert.equal(res.status, 200);
    const j = await res.json();
    const choice = j.choices[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(choice.message.tool_calls[0].function.name, 'respond_in_schema');
    assert.equal(JSON.parse(choice.message.tool_calls[0].function.arguments).answer, true);
    const [a] = b.argv();
    assert.equal(a[a.indexOf('--tools') + 1], '');
    assert.ok(a.includes('--system-prompt-file'));
    assert.deepEqual(JSON.parse(a[a.indexOf('--json-schema') + 1]), schema);
    assert.ok(!a.includes('--resume') && a.includes('--no-session-persistence'));
    noDanger(b);
  } finally { await b.close(); }
});

test('plain side query returns content', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' } });
  try {
    const j = await (await b.post({ model: 'claude-code/haiku', messages: [user('title?')] })).json();
    assert.equal(j.choices[0].message.content, 'Hello world.');
    assert.equal(j.choices[0].finish_reason, 'stop');
  } finally { await b.close(); }
});

test('Qwen MCP servers are passed through; temp config is removed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qcr-home-'));
  fs.mkdirSync(path.join(home, '.qwen'));
  fs.writeFileSync(path.join(home, '.qwen', 'settings.json'),
    '{ // comment\n "mcpServers": { "files": { "command": "npx", "args": ["x"], "trust": true }, "other": { "command": "y" } } }');
  const b = await boot({ home, fake: { fixture: 'text-turn.jsonl' }, cfg: { allowedTools: ['Read'] } });
  try {
    await sse(await b.post(body([user('hi')])));
    const [a] = b.argv();
    const cfgPath = a[a.indexOf('--mcp-config') + 1];
    assert.ok(cfgPath.includes('qcr-'));
    assert.equal(a[a.indexOf('--allowedTools') + 1], 'Read,mcp__files__*');
    assert.ok(!fs.existsSync(cfgPath));
  } finally { await b.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('mcp=false skips MCP flags', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' }, cfg: { mcp: false } });
  try {
    await sse(await b.post(body([user('hi')])));
    assert.ok(!b.argv()[0].includes('--mcp-config'));
  } finally { await b.close(); }
});

test('working directory mismatch is refused', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' } });
  try {
    const res = await b.post(body([user("<system-reminder>I'm currently working in the directory: /somewhere/else</system-reminder>hi")]));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'cwd_mismatch');
    const ok = await b.post(body([user(`I'm currently working in the directory: ${b.cwd}\nhi`)]));
    assert.equal(ok.status, 200);
    await ok.text();
  } finally { await b.close(); }
});

test('keepalive chunks while claude is quiet', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl', DELAY_MS: '120' }, cfg: { keepaliveMs: 50 } });
  try {
    const r = await sse(await b.post(body([user('hi')])));
    const empties = r.chunks.filter((c) => c.choices[0].delta.content === '' && !c.choices[0].delta.role);
    assert.ok(empties.length >= 2, `got ${empties.length}`);
    assert.match(r.text, /^Hello world\./);
  } finally { await b.close(); }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25); } return false; }

test('project MCP servers are ignored by default; opted-in ones are never auto-allowed', async () => {
  for (const projectMcp of [false, true]) {
    const b = await boot({ fake: { fixture: 'text-turn.jsonl' }, cfg: { projectMcp } });
    try {
      fs.mkdirSync(path.join(b.cwd, '.qwen'));
      fs.writeFileSync(path.join(b.cwd, '.qwen', 'settings.json'), '{"mcpServers":{"evil":{"command":"x","trust":true}}}');
      await sse(await b.post(body([user('hi')])));
      const [a] = b.argv();
      assert.equal(a.includes('--mcp-config'), projectMcp);
      assert.ok(!a.includes('--allowedTools'));
    } finally { await b.close(); }
  }
});

test('concurrency cap returns qcr_busy 429 without quota wording', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl', DELAY_MS: '150' }, cfg: { maxConcurrent: 1 } });
  try {
    const first = b.post(body([user('one')]));
    await sleep(100);
    const res = await b.post(body([user('two')]));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('x-should-retry'), 'false');
    const e = (await res.json()).error;
    assert.equal(e.code, 'qcr_busy');
    assert.equal(e.message, 'qcr is already running 1 Claude turns; try again when one finishes');
    await sse(await first);
    assert.equal((await b.post(body([user('three')]))).status, 200);
  } finally { await b.close(); }
});

test('turn timeout: 504 before commit, warning line after', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl', START_DELAY_MS: '5000' }, cfg: { turnTimeoutMs: 150 } });
  try {
    const res = await b.post(body([user('hi')]));
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error.code, 'claude_timeout');
    assert.ok(await until(() => !alive(b.pid())));
  } finally { await b.close(); }
  const c = await boot({ fake: { fixture: 'text-turn.jsonl', DELAY_MS: '400' }, cfg: { turnTimeoutMs: 200 } });
  try {
    const r = await sse(await c.post(body([user('hi')])));
    assert.match(r.text, /⚠ Claude turn exceeded the time limit/);
  } finally { await c.close(); }
});

test('client abort kills the claude child', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl', DELAY_MS: '3000' }, cfg: { commitMs: 20 } });
  try {
    const ac = new AbortController();
    const res = await b.post(body([user('hi')]), {}, ac.signal);
    assert.equal(res.status, 200);
    assert.ok(await until(() => b.pid() > 0));
    assert.ok(alive(b.pid()));
    ac.abort();
    res.body.cancel().catch(() => {});
    assert.ok(await until(() => !alive(b.pid())), 'child still running');
  } finally { await b.close(); }
});

test('side query: system prompt file reaches claude; last user message is the unfenced prompt', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' } });
  try {
    const msgs = [{ role: 'system', content: 'SYS-MARKER be terse' }, user('first'), { role: 'assistant', content: 'ok' }, user('LAST question')];
    await (await b.post({ model: 'claude-code/haiku', messages: msgs })).json();
    assert.match(b.sysPrompt(), /SYS-MARKER be terse/);
    const line = JSON.parse(b.stdin().trim().split('\n').filter(Boolean)[0]).message.content;
    assert.match(line, /<prior_conversation>[\s\S]*first[\s\S]*<\/prior_conversation>\n\nLAST question$/);
    assert.ok(!/SYS-MARKER|LAST/.test(line.slice(0, line.indexOf('</prior_conversation>'))));
    await (await b.post({ model: 'claude-code/haiku', messages: [user('solo')] })).json();
    const solo = JSON.parse(b.stdin().trim().split('\n').filter(Boolean)[1]).message.content;
    assert.equal(solo, 'solo');
  } finally { await b.close(); }
});

test('side query rejects non-object or oversized function parameters', async () => {
  const b = await boot({ fake: { fixture: 'side-query-json.jsonl' } });
  try {
    for (const parameters of [[1, 2], 'str', { type: 'object', description: 'x'.repeat(70000) }]) {
      const res = await b.post({ model: 'claude-code/haiku', messages: [user('q')], tool_choice: 'required',
        tools: [{ type: 'function', function: { name: 'f', parameters } }] });
      assert.equal(res.status, 400);
    }
    assert.deepEqual(b.argv(), []);
  } finally { await b.close(); }
});

test('oversized body gets a readable 413', async () => {
  const b = await boot();
  try {
    const res = await b.post({ model: 'claude-code/sonnet', messages: [user('x'.repeat(9 * 1024 * 1024))] });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'payload_too_large');
  } finally { await b.close(); }
});

test('working directory check follows symlinks', async () => {
  const b = await boot({ fake: { fixture: 'text-turn.jsonl' } });
  const link = b.cwd + '-link';
  try {
    fs.symlinkSync(b.cwd, link);
    const ok = await b.post(body([user(`I'm currently working in the directory: ${link}\nhi`)]));
    assert.equal(ok.status, 200);
    await ok.text();
  } finally { fs.rmSync(link, { force: true }); await b.close(); }
});

test('a grandchild holding the pipe does not hang the turn', async () => {
  const b = await boot({ fake: { STDERR: 'Not logged in', EXIT: '1', GRANDCHILD_MS: '4500' }, cfg: { commitMs: 5000 } });
  try {
    const t = Date.now();
    const res = await b.post(body([user('hi')]));
    assert.equal(res.status, 401);
    assert.ok(Date.now() - t < 4000);
  } finally { await b.close(); }
});
