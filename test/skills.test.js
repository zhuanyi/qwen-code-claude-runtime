import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSkills, listSkillFiles, readSkillFile } from '../src/skills/discover.js';

function setup() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qcr-sk-')));
  const cwd = path.join(tmp, 'proj'), home = path.join(tmp, 'home');
  fs.mkdirSync(cwd); fs.mkdirSync(home);
  const add = (root, dir, content, base = cwd) => {
    const d = path.join(base, root, 'skills', dir);
    fs.mkdirSync(d, { recursive: true });
    if (content !== null) fs.writeFileSync(path.join(d, 'SKILL.md'), content);
    return d;
  };
  return { tmp, cwd, home, add, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
const fm = (name, desc, body = 'Body.') => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;

test('precedence: project .qwen > project .agents > user .qwen > user .agents', () => {
  const t = setup();
  try {
    t.add('.agents', 'a', fm('dup', 'agents'));
    t.add('.qwen', 'b', fm('dup', 'qwen'));
    t.add('.qwen', 'c', fm('dup', 'user'), t.home);
    t.add('.agents', 'd', fm('only-user', 'u'), t.home);
    const { skills } = discoverSkills({ cwd: t.cwd, home: t.home });
    assert.equal(skills.get('dup').description, 'qwen');
    assert.equal(skills.get('dup').scope, 'project');
    assert.equal(skills.get('only-user').scope, 'user');
    assert.equal(skills.size, 2);
  } finally { t.done(); }
});

test('frontmatter variants: quoted, folded, literal, CRLF', () => {
  const t = setup();
  try {
    t.add('.qwen', 'q', `---\nname: "quoted"\ndescription: 'It''s quoted'\n---\nB1`);
    t.add('.qwen', 'f', `---\nname: folded\ndescription: >\n  line one\n  line two\n\n  para two\nother: x\n---\nB2`);
    t.add('.qwen', 'l', `---\nname: literal\ndescription: |\n  a\n  b\n---\nB3`);
    t.add('.qwen', 'crlf', '---\r\nname: crlf\r\ndescription: windows\r\n---\r\nB4\r\n');
    const { skills, warnings } = discoverSkills({ cwd: t.cwd, home: t.home });
    assert.deepEqual(warnings, []);
    assert.equal(skills.get('quoted').description, "It's quoted");
    assert.equal(skills.get('folded').description, 'line one line two\npara two');
    assert.equal(skills.get('literal').description, 'a\nb');
    assert.equal(skills.get('crlf').description, 'windows');
    assert.equal(skills.get('crlf').body, 'B4');
    assert.equal(skills.get('folded').body, 'B2');
  } finally { t.done(); }
});

test('bad skills are skipped with warnings; disabled skills are silent', () => {
  const t = setup();
  try {
    t.add('.qwen', 'nodesc', '---\nname: nodesc\n---\nx');
    t.add('.qwen', 'badname', fm('../evil', 'd'));
    t.add('.qwen', 'nofm', 'just text');
    t.add('.qwen', 'off', `---\nname: off\ndescription: d\ndisable-model-invocation: true\n---\nx`);
    t.add('.qwen', 'empty', null);
    t.add('.qwen', 'ok', fm('ok', 'fine'));
    const { skills, warnings } = discoverSkills({ cwd: t.cwd, home: t.home });
    assert.deepEqual([...skills.keys()], ['ok']);
    assert.equal(warnings.length, 3);
  } finally { t.done(); }
});

test('listSkillFiles: recursive, skips dot dirs, node_modules, symlinked dirs', () => {
  const t = setup();
  try {
    const d = t.add('.qwen', 's', fm('s', 'd'));
    fs.mkdirSync(path.join(d, 'ref'));
    fs.writeFileSync(path.join(d, 'ref', 'a.md'), 'a');
    fs.writeFileSync(path.join(d, 'run.sh'), 'x');
    for (const x of ['.git', 'node_modules']) { fs.mkdirSync(path.join(d, x)); fs.writeFileSync(path.join(d, x, 'z'), 'z'); }
    fs.symlinkSync(t.home, path.join(d, 'link'));
    const skill = discoverSkills({ cwd: t.cwd, home: t.home }).skills.get('s');
    assert.deepEqual(listSkillFiles(skill), ['ref/a.md', 'run.sh']);
  } finally { t.done(); }
});

test('readSkillFile: containment, binary and size limits', () => {
  const t = setup();
  try {
    const d = t.add('.qwen', 's', fm('s', 'd'));
    fs.writeFileSync(path.join(d, 'ok.txt'), 'hello');
    fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([65, 0, 66]));
    fs.writeFileSync(path.join(d, 'big.txt'), 'x'.repeat(256 * 1024 + 1));
    fs.writeFileSync(path.join(t.tmp, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(t.tmp, 'secret.txt'), path.join(d, 'leak.txt'));
    const skill = discoverSkills({ cwd: t.cwd, home: t.home }).skills.get('s');
    assert.equal(readSkillFile(skill, 'ok.txt'), 'hello');
    assert.throws(() => readSkillFile(skill, '../../../../secret.txt'), /escapes/);
    assert.throws(() => readSkillFile(skill, path.join(t.tmp, 'secret.txt')), /relative/);
    assert.throws(() => readSkillFile(skill, 'leak.txt'), /escapes/);
    assert.throws(() => readSkillFile(skill, '.'), /escapes|regular/);
    assert.throws(() => readSkillFile(skill, 'ok\0.txt'), /invalid/);
    assert.throws(() => readSkillFile(skill, 'bin.dat'), /binary/);
    assert.throws(() => readSkillFile(skill, 'big.txt'), /too large/);
    assert.throws(() => readSkillFile(skill, 'missing'), /not found/);
  } finally { t.done(); }
});

test('project skills may not symlink outside the project; user skills may', () => {
  const t = setup();
  try {
    const outside = path.join(t.tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'SKILL.md'), fm('escaped', 'from outside'));
    fs.mkdirSync(path.join(t.cwd, '.qwen', 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(t.cwd, '.qwen', 'skills', 'escaped'));
    const d = t.add('.qwen', 'linkfile', null);
    fs.writeFileSync(path.join(t.tmp, 'other.md'), fm('linkfile', 'x'));
    fs.symlinkSync(path.join(t.tmp, 'other.md'), path.join(d, 'SKILL.md'));
    fs.mkdirSync(path.join(t.home, '.qwen', 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(t.home, '.qwen', 'skills', 'mine'));
    const { skills, warnings } = discoverSkills({ cwd: t.cwd, home: t.home });
    assert.equal(skills.get('escaped')?.scope, 'user'); // only the user-scope link is accepted
    assert.ok(!skills.has('linkfile'));
    assert.ok(warnings.some((w) => w.includes('leaves the project')));
    assert.ok(warnings.some((w) => w.includes('leaves the skill directory')));
  } finally { t.done(); }
});
