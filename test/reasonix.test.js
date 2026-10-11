import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ConfigError } from '../src/runtime/errors.js';
import { buildReasonixArgs, classifyReasonixError, createReasonixBackend, createReasonixParser, extractJson } from '../src/backends/reasonix.js';

const fixture = (n) => fs.readFileSync(new URL(`./fixtures/reasonix/${n}`, import.meta.url), 'utf8');
const parse = (name) => { const p = createReasonixParser(); return fixture(name).split('\n').filter(Boolean).flatMap((l) => p.push(l)); };
const SID = '20261011-174022.100901000-mock-model';

test('argv: headless stream-json, prompt not in argv, manual by default', () => {
  const a = buildReasonixArgs({ model: 'deepseek-flash', cwd: '/work/p' });
  assert.deepEqual(a, ['-p', '--output-format', 'stream-json', '--model', 'deepseek-flash', '--permission-mode', 'manual', '--dir', '/work/p']);
  assert.ok(buildReasonixArgs({ model: 'deepseek-pro/deepseek-v4-pro', cwd: '/w' }).includes('deepseek-pro/deepseek-v4-pro'));
  assert.ok(buildReasonixArgs({ model: 'm', cwd: '/w', permissionMode: 'acceptEdits' }).includes('acceptEdits'));
});

test('argv: resume always forks with --copy; session id and inputs are validated', () => {
  const a = buildReasonixArgs({ model: 'm', cwd: '/w', resume: SID, allowedTools: ['write_file', 'bash(npm test)'] });
  assert.deepEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 3), ['--resume', SID, '--copy']);
  assert.deepEqual(a.slice(-2), ['--allowed-tools', 'write_file,bash(npm test)']);
  for (const bad of ['--takeover', 'abc', '../x', `${SID} --yolo`]) {
    assert.throws(() => buildReasonixArgs({ model: 'm', cwd: '/w', resume: bad }), ConfigError, bad);
  }
  for (const m of ['--yolo', '-y', 'a b', 'x;y', '', 'a/b/c']) assert.throws(() => buildReasonixArgs({ model: m, cwd: '/w' }), ConfigError, m);
  assert.throws(() => buildReasonixArgs({ model: 'm', cwd: 'rel' }), ConfigError);
  assert.throws(() => buildReasonixArgs({ model: 'm', cwd: '/w', allowedTools: ['--yolo'] }), ConfigError);
});

test('argv: plan and every auto-approve mode are refused', () => {
  for (const pm of ['plan', 'auto', 'bypassPermissions', 'dontAsk', 'yolo']) {
    assert.throws(() => buildReasonixArgs({ model: 'm', cwd: '/w', permissionMode: pm }), ConfigError, pm);
  }
});

test('parser: recorded text turn -> init, streamed text once, usage, result', () => {
  const ev = parse('text-turn.jsonl');
  assert.equal(ev[0].type, 'init');
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello from mock.');
  assert.deepEqual(ev.find((e) => e.type === 'context_usage'), { type: 'context_usage', inputTokens: 100, cachedTokens: 60 });
  const r = ev.at(-1);
  assert.equal(r.type, 'result');
  assert.equal(r.isError, false);
  assert.match(r.sessionId, /^\d{8}-\d{6}\.\d+-mock-model$/);
  assert.equal(r.numTurns, 1);
  // input_tokens is the full prompt split into cache hit/miss; normalized so the parts add up to it.
  assert.equal(r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheCreationTokens, 100);
});

test('parser: recorded tool turn -> one tool_start with summary, tool_end ok, final text', () => {
  const ev = parse('tool-turn.jsonl');
  const starts = ev.filter((e) => e.type === 'tool_start');
  assert.equal(starts.length, 1); // the partial dispatch is skipped
  assert.deepEqual(starts[0], { type: 'tool_start', id: 'call_ls1', name: 'read_file', summary: 'notes.txt' });
  assert.deepEqual(ev.find((e) => e.type === 'tool_end'), { type: 'tool_end', id: 'call_ls1', name: 'read_file', isError: false });
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Tool result received: done.');
  assert.deepEqual(ev.at(-1).permissionDenials, []);
});

test('parser: recorded permission denial -> failed tool_end and a denial on the result', () => {
  const ev = parse('permission-denied.jsonl');
  assert.deepEqual(ev.find((e) => e.type === 'tool_end'), { type: 'tool_end', id: 'call_w1', name: 'write_file', isError: true });
  assert.deepEqual(ev.at(-1).permissionDenials, [{ tool_name: 'write_file' }]);
});

test('parser: message text is used only when no deltas were streamed', () => {
  const p = createReasonixParser();
  assert.deepEqual(p.push('{"kind":"message","messageId":"m1","text":"full"}'), [{ type: 'text', text: 'full' }]);
  p.push('{"kind":"text","messageId":"m2","text":"de"}');
  assert.deepEqual(p.push('{"kind":"message","messageId":"m2","text":"delta"}'), []);
  assert.deepEqual(p.push('not json'), []);
  assert.deepEqual(p.push('{"kind":"read_status"}'), []);
});

test('parser: retrying events become notices and rate-limit hints', () => {
  const ev = parse('retrying-429.jsonl');
  const notices = ev.filter((e) => e.type === 'notice');
  assert.equal(notices.length, 2);
  assert.match(notices[0].text, /Reasonix is retrying \(rate_limit_error, attempt 1\/3\)/);
  assert.ok(ev.some((e) => e.type === 'rate_limit'));
  assert.equal(ev.at(-1).isError, true);
  assert.equal(ev.at(-1).text, 'context canceled');
});

test('classify: recorded error results map to fixed messages and non-5xx statuses', () => {
  const res = (name) => parse(name).at(-1);
  const c1 = classifyReasonixError({ result: res('missing-key.jsonl') });
  assert.deepEqual([c1.code, c1.httpStatus], ['reasonix_not_configured', 401]);
  assert.match(c1.message, /set DEEPSEEK_API_KEY/);
  const c2 = classifyReasonixError({ result: res('auth-401.jsonl') });
  assert.deepEqual([c2.code, c2.httpStatus], ['reasonix_auth_failed', 401]);
  const c3 = classifyReasonixError({ result: res('quota-402.jsonl') });
  assert.deepEqual([c3.code, c3.httpStatus], ['reasonix_quota_exhausted', 429]);
  assert.match(c3.message, /quota exhausted; will reset at/); // Qwen fails fast on this wording
  const c4 = classifyReasonixError({ stderr: fixture('no-session.stderr'), exitCode: 1 });
  assert.deepEqual([c4.code, c4.httpStatus], ['reasonix_session_not_found', 409]);
  const c5 = classifyReasonixError({ spawnError: { code: 'ENOENT' } });
  assert.deepEqual([c5.code, c5.httpStatus], ['reasonix_not_found', 424]);
  const c6 = classifyReasonixError({ stderr: 'error: unknown flag: --copy\n', exitCode: 2 });
  assert.equal(c6.code, 'reasonix_unsupported');
  const c7 = classifyReasonixError({ result: { text: 'boom DEEPSEEK_API_KEY=sk-abc123 leaked' }, stderr: 'secret stderr' });
  assert.deepEqual([c7.code, c7.httpStatus], ['reasonix_failed', 424]);
  assert.ok(!c7.message.includes('sk-abc123') && !c7.message.includes('secret stderr'));
});

test('extractJson: bare, fenced and prose-wrapped replies', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here:\n```json\n{"a":2}\n```\n'), { a: 2 });
  assert.deepEqual(extractJson('Sure! {"a":3} done'), { a: 3 });
  assert.throws(() => extractJson('no json here'));
});

test('backend: model ids, footer with and without a complete cost', () => {
  const b = createReasonixBackend({ cwd: '/w' });
  assert.equal(b.modelFromId('reasonix/deepseek-flash'), 'deepseek-flash');
  assert.equal(b.modelFromId('claude-code/sonnet'), null);
  assert.deepEqual(b.models, ['reasonix/deepseek-flash', 'reasonix/deepseek-pro']);
  assert.equal(b.footer({ numTurns: 2, cost: { amount: null, currency: '', complete: false } }), '\n\n_reasonix · 2 turns_');
  assert.equal(b.footer({ numTurns: 1, cost: { amount: 0.0123, currency: 'CNY', complete: true } }), '\n\n_reasonix · 1 turns · 0.0123 CNY_');
});
