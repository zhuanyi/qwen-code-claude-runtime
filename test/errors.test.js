import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, redact } from '../src/runtime/errors.js';

test('classification', () => {
  const c = (p) => classifyError(p);
  assert.equal(c({ spawnError: { code: 'ENOENT' } }).code, 'claude_not_found');
  assert.equal(c({ spawnError: { code: 'ENOENT' } }).httpStatus, 503);
  assert.equal(c({ stderr: 'Error: Not logged in' }).httpStatus, 401);
  assert.equal(c({ result: { text: 'Invalid API key', apiErrorStatus: null } }).code, 'claude_not_logged_in');
  const rl = c({ result: { text: "You've hit your usage limit", apiErrorStatus: 429 }, resetsAt: 1893456000 });
  assert.equal(rl.code, 'claude_rate_limited');
  assert.equal(rl.httpStatus, 429);
  assert.match(rl.message, /^Claude quota exhausted; will reset at 2030-01-01T00:00:00\.000Z/);
  assert.match(c({ result: { text: 'quota', apiErrorStatus: null } }).message, /will reset at unknown/);
  assert.equal(c({ stderr: 'No conversation found with session ID: abc' }).code, 'claude_session_not_found');
  assert.equal(c({ result: { text: 'bad', apiErrorStatus: 400 } }).httpStatus, 400);
  assert.equal(c({ result: { text: 'issue with the selected model (nope)' } }).code, 'claude_bad_request');
  assert.equal(c({ stderr: 'boom', exitCode: 1 }).code, 'claude_failed');
  assert.equal(c({ exitCode: 1 }).httpStatus, 502);
});

test('redact', () => {
  const s = redact('key sk-ant-abc_123-x and Bearer abc.def ok');
  assert.ok(!s.includes('sk-ant') && !s.includes('abc.def'));
  assert.equal(redact('x'.repeat(5000)).length, 2000);
});
