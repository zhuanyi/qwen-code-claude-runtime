import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, modelAliasFromId } from '../src/runtime/argv.js';
import { ConfigError } from '../src/runtime/errors.js';
import { buildChildEnv } from '../src/runtime/env.js';

const UUID = '11111111-2222-3333-4444-555555555555';

test('defaults: manual permissions, no prompts, no resume', () => {
  const a = buildClaudeArgs({ model: 'sonnet' });
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 4),
    ['--permission-mode', 'manual', '--permission-prompts', 'none']);
  assert.ok(a.includes('--include-partial-messages'));
  assert.ok(!a.includes('--resume'));
});

test('default maps to manual; bypass-like modes are rejected', () => {
  assert.ok(buildClaudeArgs({ model: 'a', permissionMode: 'default' }).includes('manual'));
  for (const m of ['bypassPermissions', 'auto', 'dontAsk', '--dangerously-skip-permissions']) {
    assert.throws(() => buildClaudeArgs({ model: 'a', permissionMode: m }), ConfigError);
  }
  assert.ok(buildClaudeArgs({ model: 'a', permissionMode: 'acceptEdits' }).includes('acceptEdits'));
});

test('resume needs a UUID and forks', () => {
  const a = buildClaudeArgs({ model: 'a', resume: UUID });
  assert.deepEqual(a.slice(a.indexOf('--resume')), ['--resume', UUID, '--fork-session']);
  assert.throws(() => buildClaudeArgs({ model: 'a', resume: 'abc' }), ConfigError);
  assert.throws(() => buildClaudeArgs({ model: 'a', resume: '--foo' }), ConfigError);
});

test('model alias validation', () => {
  for (const m of ['--foo', 'a b', 'sonnet;rm', '', 'a'.repeat(65), '-x']) {
    assert.throws(() => buildClaudeArgs({ model: m }), ConfigError, m);
  }
  assert.ok(buildClaudeArgs({ model: 'opus[1m]' }));
  assert.equal(modelAliasFromId('claude-code/sonnet'), 'sonnet');
  assert.equal(modelAliasFromId('qwen3-coder'), null);
});

test('allowed tools are validated and joined', () => {
  const a = buildClaudeArgs({ model: 'a', allowedTools: ['Bash(git status)', 'mcp__x__*'] });
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Bash(git status),mcp__x__*');
  assert.throws(() => buildClaudeArgs({ model: 'a', allowedTools: ['--evil'] }), ConfigError);
  assert.throws(() => buildClaudeArgs({ model: 'a', allowedTools: ['a;b'] }), ConfigError);
});

test('side query flags', () => {
  const a = buildClaudeArgs({ model: 'haiku', side: { systemPromptFile: '/t/s.txt', jsonSchema: { type: 'object' } } });
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.ok(a.includes('--no-session-persistence'));
  assert.equal(a[a.indexOf('--system-prompt-file') + 1], '/t/s.txt');
  assert.equal(a[a.indexOf('--json-schema') + 1], '{"type":"object"}');
  assert.ok(!a.includes('--resume'));
  for (const x of a) assert.ok(!/dangerously|bypassPermissions/.test(x));
});

test('env scrubbing', () => {
  const src = { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', QCR_TOKEN: 'q', PATH: '/bin' };
  assert.deepEqual(buildChildEnv(src), { PATH: '/bin' });
  assert.deepEqual(buildChildEnv(src, { keepAnthropicEnv: true }),
    { ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', PATH: '/bin' });
});

test('env scrubbing removes every ANTHROPIC_* and cloud-provider flag unless kept', () => {
  const src = { ANTHROPIC_MODEL: 'm', ANTHROPIC_CUSTOM_HEADERS: 'h', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1', QCR_TOKEN: 'q', PATH: '/bin' };
  assert.deepEqual(buildChildEnv(src), { PATH: '/bin' });
  const kept = buildChildEnv(src, { keepAnthropicEnv: true });
  assert.equal(Object.keys(kept).length, 6);
  assert.ok(!('QCR_TOKEN' in kept));
});
