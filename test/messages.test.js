import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractWorkingDir, fingerprint, messageText, renderTranscript, splitForResume, stripSystemReminders } from '../src/server/messages.js';
import { SessionStore } from '../src/server/sessions.js';
import { loadOrCreateToken } from '../src/server/token.js';

test('messageText / reminders', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(stripSystemReminders('x<system-reminder>\nfoo\n</system-reminder>y'), 'xy');
});

test('fingerprint ignores reminders, system and tool messages', () => {
  const a = [{ role: 'user', content: '<system-reminder>r1</system-reminder>hi' }, { role: 'assistant', content: 'yo\r\n' }];
  const b = [{ role: 'system', content: 'S' }, { role: 'user', content: '<system-reminder>other</system-reminder>hi' },
    { role: 'assistant', content: 'yo', tool_calls: [{}] }, { role: 'tool', content: 'zzz' }];
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint([...a, { role: 'user', content: 'more' }]));
});

test('splitForResume', () => {
  const m = [{ role: 'user', content: '1' }, { role: 'assistant', content: 'a' }, { role: 'user', content: '2' }, { role: 'user', content: '3' }];
  const s = splitForResume(m);
  assert.equal(s.prefix.length, 2);
  assert.deepEqual(s.tail.map((x) => x.content), ['2', '3']);
  assert.equal(splitForResume([m[0]]).prefix.length, 0);
});

test('transcript is fenced and keeps the recent part', () => {
  const m = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg${i} ` + 'x'.repeat(500) }));
  const t = renderTranscript(m, 5000);
  assert.match(t, /untrusted reference data/);
  assert.match(t, /<prior_conversation>[\s\S]*<\/prior_conversation>$/);
  assert.ok(Buffer.byteLength(t) < 5600);
  assert.ok(t.includes('msg99') && !t.includes('msg0 '));
  assert.ok(renderTranscript([{ role: 'tool', content: 'y'.repeat(5000) }]).includes('[tool result]: yyy'));
  assert.ok(renderTranscript([{ role: 'user', content: 'y'.repeat(5000) }]).length < 2500);
});

test('extractWorkingDir', () => {
  const m = [{ role: 'user', content: "<system-reminder>This is the Qwen Code.\nI'm currently working in the directory: /w/proj\nmore</system-reminder>" }];
  assert.equal(extractWorkingDir(m), '/w/proj');
  assert.equal(extractWorkingDir([{ role: 'user', content: 'hi' }]), null);
});

test('LRU session store', () => {
  const s = new SessionStore(2);
  s.set('a', '1'); s.set('b', '2'); s.get('a'); s.set('c', '3');
  assert.equal(s.get('b'), undefined);
  assert.equal(s.get('a'), '1');
  s.delete('a');
  assert.equal(s.get('a'), undefined);
});

test('token file is 0600 and stable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qcr-home-'));
  try {
    const t = loadOrCreateToken({ env: {}, home });
    assert.match(t, /^[0-9a-f]{64}$/);
    const f = path.join(home, '.config', 'qwen-claude-runtime', 'token');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(f)).mode & 0o777, 0o700);
    assert.equal(loadOrCreateToken({ env: {}, home }), t);
    assert.equal(loadOrCreateToken({ env: { QCR_TOKEN: 'x'.repeat(20) }, home }), 'x'.repeat(20));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
