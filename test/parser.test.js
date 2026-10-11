import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStreamParser } from '../src/runtime/parser.js';

const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8').split('\n').filter(Boolean);
const parse = (lines) => { const p = createStreamParser(); return lines.flatMap((l) => p.push(l)); };

test('recorded tool turn', () => {
  const ev = parse(fx('tool-turn.jsonl'));
  assert.equal(ev[0].type, 'init');
  assert.equal(ev[0].sessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(ev.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'The file contains just one word: "hello."');
  const starts = ev.filter((e) => e.type === 'tool_start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].name, 'Read');
  assert.match(starts[0].summary, /a\.txt/);
  const ends = ev.filter((e) => e.type === 'tool_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].name, 'Read');
  assert.equal(ends[0].isError, false);
  const usage = ev.filter((e) => e.type === 'context_usage');
  assert.deepEqual(usage.at(-1), { type: 'context_usage', inputTokens: 2 + 34226 + 151, cachedTokens: 34226 });
  const r = ev.at(-1);
  assert.equal(r.type, 'result');
  assert.equal(r.isError, false);
  assert.equal(r.sessionId, '11111111-2222-3333-4444-555555555555');
  assert.ok(Math.abs(r.costUsd - 0.00289508) < 1e-9);
  assert.equal(r.usage.outputTokens, 237);
  assert.equal(r.numTurns, 2);
});

test('structured output side query', () => {
  const ev = parse(fx('side-query-json.jsonl'));
  assert.ok(!ev.some((e) => e.type === 'tool_start'));
  assert.equal(ev.at(-1).structuredOutput.answer, true);
});

test('fallback: text from assistant message when no deltas, no duplication', () => {
  const lines = fx('text-turn.jsonl').filter((l) => !l.includes('text_delta'));
  const text = parse(lines).filter((e) => e.type === 'text');
  assert.deepEqual(text.map((e) => e.text), ['Hello world.']);
  const withDeltas = parse(fx('text-turn.jsonl')).filter((e) => e.type === 'text');
  assert.equal(withDeltas.map((e) => e.text).join(''), 'Hello world.');
});

test('ignores junk, subagent events, unknown types', () => {
  const p = createStreamParser();
  assert.deepEqual(p.push('not json'), []);
  assert.deepEqual(p.push('{"type":"mystery"}'), []);
  assert.deepEqual(p.push(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { id: 'm', content: [{ type: 'text', text: 'sub' }] } })), []);
});

test('rate limit, permission denials and error results', () => {
  const rl = parse(fx('rate-limited.jsonl'));
  assert.deepEqual(rl.find((e) => e.type === 'rate_limit'), { type: 'rate_limit', status: 'rejected', resetsAt: 1893456000 });
  assert.equal(rl.at(-1).isError, true);
  assert.equal(rl.at(-1).apiErrorStatus, 429);
  const pd = parse(fx('permission-denied.jsonl'));
  assert.equal(pd.find((e) => e.type === 'tool_end').isError, true);
  assert.equal(pd.at(-1).permissionDenials[0].tool_name, 'Bash');
});
