import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const QCR = new URL('../bin/qcr.js', import.meta.url).pathname;

test('qcr mcp-skills speaks MCP over stdio', async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qcr-mcp-')));
  const cwd = path.join(tmp, 'proj'), home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const dir = path.join(cwd, '.qwen', 'skills', 'demo');
  fs.mkdirSync(path.join(dir, 'ref'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\nDo the demo.\n');
  fs.writeFileSync(path.join(dir, 'ref', 'a.md'), 'reference text');
  const ext = path.join(home, '.qwen', 'extensions', 'demo');
  fs.mkdirSync(path.join(ext, 'skills', 'pdf-tools'), { recursive: true });
  fs.writeFileSync(path.join(ext, 'qwen-extension.json'), '{"name":"demo-ext"}');
  fs.writeFileSync(path.join(ext, 'skills', 'pdf-tools', 'SKILL.md'), '---\nname: pdf-tools\ndescription: Ext pdf\n---\nExt body.\n');
  const child = spawn(process.execPath, [QCR, 'mcp-skills', '--cwd', cwd], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((r) => child.on('close', r));
  const send = (o) => child.stdin.write((typeof o === 'string' ? o : JSON.stringify({ jsonrpc: '2.0', ...o })) + '\n');
  const call = (id, name, args) => send({ id, method: 'tools/call', params: { name, arguments: args } });
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'ping' });
    send({ id: 3, method: 'tools/list' });
    call(4, 'qwen_skill', { name: 'demo' });
    call(5, 'qwen_skill_file', { name: 'demo', path: 'ref/a.md' });
    call(6, 'qwen_skill', { name: 'nope' });
    call(7, 'qwen_skill_file', { name: 'demo', path: '../../x' });
    call(10, 'qwen_skill', { name: 'demo-ext:pdf-tools' });
    send({ id: 8, method: 'bogus/method' });
    send({ id: 9, method: 'tools/call', params: { name: 'qwen_skill', arguments: {} } });
    send('{not json');
    child.stdin.end();
    await closed;
    const msgs = out.trim().split('\n').map((l) => JSON.parse(l)); // every stdout line is JSON
    const byId = new Map(msgs.map((m) => [m.id, m]));
    assert.equal(msgs.length, 11); // the notification gets no reply
    assert.equal(byId.get(1).result.protocolVersion, '2025-03-26');
    assert.equal(byId.get(1).result.serverInfo.name, 'qwen-skills');
    assert.deepEqual(byId.get(2).result, {});
    const tools = byId.get(3).result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['qwen_skill', 'qwen_skill_file']);
    assert.match(tools[0].description, /- demo: Demo skill/);
    const t4 = byId.get(4).result.content[0].text;
    assert.match(t4, /^# Skill: demo\nBase directory: .*demo\n\nDo the demo\./);
    assert.match(t4, /Supporting files:\n- ref\/a\.md$/);
    assert.match(tools[0].description, /- demo-ext:pdf-tools: Ext pdf/);
    assert.match(byId.get(10).result.content[0].text, /^# Skill: demo-ext:pdf-tools\nExtension: demo-ext\nBase directory: .*pdf-tools\n\nExt body\./);
    assert.equal(byId.get(5).result.content[0].text, 'reference text');
    assert.equal(byId.get(6).result.isError, true);
    assert.equal(byId.get(7).result.isError, true);
    assert.equal(byId.get(8).error.code, -32601);
    assert.equal(byId.get(9).error.code, -32602);
    assert.equal(byId.get(null).error.code, -32700);
  } finally { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
