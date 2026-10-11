import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, redact } from '../src/runtime/errors.js';

test('classification', () => {
  const c = (p) => classifyError(p);
  assert.equal(c({ spawnError: { code: 'ENOENT' } }).code, 'claude_not_found');
  assert.equal(c({ spawnError: { code: 'ENOENT' } }).httpStatus, 424);
  assert.equal(c({ stderr: 'Not logged in' }).httpStatus, 401);
  assert.equal(c({ result: { text: 'Invalid API key', apiErrorStatus: null } }).code, 'claude_not_logged_in');
  const rl = c({ result: { text: "You've hit your usage limit", apiErrorStatus: 429 }, resetsAt: 1893456000 });
  assert.equal(rl.code, 'claude_rate_limited');
  assert.equal(rl.httpStatus, 429);
  assert.match(rl.message, /^Claude quota exhausted; will reset at 2030-01-01T00:00:00\.000Z/);
  assert.match(c({ result: { text: "You've hit your usage limit", apiErrorStatus: null } }).message, /will reset at unknown/);
  assert.equal(c({ result: { text: 'x', apiErrorStatus: null }, rejected: true }).code, 'claude_rate_limited');
  assert.equal(c({ result: { text: 'x', apiErrorStatus: 403 } }).code, 'claude_not_logged_in');
  assert.equal(c({ result: { text: 'x', apiErrorStatus: 404 } }).code, 'claude_bad_request');
  assert.equal(c({ result: { text: 'quota exceeded', apiErrorStatus: null } }).code, 'claude_failed');
  assert.equal(c({ stderr: 'No conversation found with session ID: abc' }).code, 'claude_session_not_found');
  assert.equal(c({ result: { text: 'bad', apiErrorStatus: 400 } }).httpStatus, 400);
  assert.equal(c({ result: { text: 'issue with the selected model (nope)' } }).code, 'claude_bad_request');
  assert.equal(c({ stderr: 'boom', exitCode: 1 }).code, 'claude_failed');
  assert.equal(c({ exitCode: 1 }).httpStatus, 424);
});

test('false positives and no stderr leakage', () => {
  const c = (p) => classifyError(p);
  assert.equal(c({ stderr: 'MCP server "gh": GitHub API rate limit exceeded', exitCode: 1 }).code, 'claude_failed');
  assert.equal(c({ result: { text: 'Context limit reached', apiErrorStatus: null } }).code, 'claude_failed');
  assert.equal(c({ stderr: 'MCP server "linear" failed to authenticate', exitCode: 1 }).code, 'claude_failed');
  assert.equal(c({ stderr: 'MCP server "x": Invalid API key', exitCode: 1 }).code, 'claude_failed');
  const e = c({ stderr: 'secret stderr sk-ant-zzz', exitCode: 1 });
  assert.ok(!e.message.includes('secret') && /code 1/.test(e.message));
  const long = c({ result: { text: 'boom '.repeat(200) + 'sk-ant-abc', apiErrorStatus: 500 } });
  assert.equal(long.code, 'claude_failed');
  assert.ok(long.message.length <= 300);
  assert.ok(!c({ stderr: 'No conversation found with session ID: abc /home/x' }).message.includes('/home'));
});

test('redact', () => {
  const s = redact('key sk-ant-abc_123-x and Bearer abc.def ok');
  assert.ok(!s.includes('sk-ant') && !s.includes('abc.def'));
  assert.equal(redact('x'.repeat(5000)).length, 2000);
  for (const secret of ['sk-proj-abc_123', 'ghp_abcDEF123', 'github_pat_11AB_cd', 'xoxb-123-abc', 'authorization: tok123', 'x-api-key=k99', 'MY_API_KEY=abc', 'DB_PASSWORD = hunter2']) {
    const out = redact(`before ${secret} after`);
    assert.ok(!/sk-proj|ghp_|github_pat|xoxb|tok123|k99|abc|hunter2/.test(out), out);
  }
});
