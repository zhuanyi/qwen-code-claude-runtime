import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadQwenMcpServers, parseJsonc, toClaudeMcpConfig } from '../src/runtime/mcp.js';
import { withTempDir } from '../src/runtime/tempdir.js';

const put = (base, text) => { fs.mkdirSync(path.join(base, '.qwen'), { recursive: true }); fs.writeFileSync(path.join(base, '.qwen', 'settings.json'), text); };

test('JSONC parsing', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "x//y", /* b */ "b": [1,2,], }'), { a: 'x//y', b: [1, 2] });
});

test('loader: project overrides user, tolerates missing and broken files', async () => {
  await withTempDir(async (d) => {
    const home = path.join(d, 'h'), cwd = path.join(d, 'p');
    fs.mkdirSync(home); fs.mkdirSync(cwd);
    assert.deepEqual(loadQwenMcpServers({ cwd, home }), { servers: {}, warnings: [] });
    put(home, '{"mcpServers":{"a":{"command":"x"},"b":{"command":"user"}}}');
    put(cwd, '{ // project\n "mcpServers":{"b":{"command":"proj",},}}');
    const r = loadQwenMcpServers({ cwd, home });
    assert.equal(r.servers.a.command, 'x');
    assert.equal(r.servers.b.command, 'proj');
    put(cwd, '{broken');
    const r2 = loadQwenMcpServers({ cwd, home });
    assert.equal(r2.warnings.length, 1);
    assert.equal(r2.servers.b.command, 'user');
  });
});

test('converter', () => {
  const { config, trustedNames, warnings } = toClaudeMcpConfig({
    fs: { command: 'npx', args: ['-y', 'x'], env: { A: '1' }, cwd: '/tmp', trust: true },
    web: { httpUrl: 'https://h/mcp', headers: { Authorization: 'secret' } },
    old: { url: 'https://h/sse' },
    tcpy: { tcp: 'h:1' },
    'bad name!': { command: 'x' },
    inc: { command: 'y', includeTools: ['a'] },
  });
  assert.deepEqual(Object.keys(config.mcpServers), ['fs', 'web', 'old', 'inc']);
  assert.deepEqual(config.mcpServers.fs, { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } });
  assert.equal(config.mcpServers.web.type, 'http');
  assert.equal(config.mcpServers.old.type, 'sse');
  assert.deepEqual(trustedNames, ['fs']);
  assert.ok(warnings.some((w) => /cwd/.test(w)));
  assert.ok(warnings.some((w) => /ignored/.test(w)));
  assert.ok(warnings.some((w) => /skipped/.test(w)));
  assert.ok(!warnings.join().includes('secret'));
});

test('tempdir is private and removed', async () => {
  let dir, file;
  await withTempDir(async (d, write) => {
    dir = d; file = await write('x.txt', 'hi');
    assert.equal(fs.statSync(d).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
  assert.ok(!fs.existsSync(dir));
  assert.ok(dir.startsWith(os.tmpdir()));
});
