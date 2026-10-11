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

// --- settings, custom directories, extensions ---
const writeJson = (file, o) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o)); };
const settings = (base, skills) => writeJson(path.join(base, '.qwen', 'settings.json'), `// comment\n{"skills": ${JSON.stringify(skills)},}`);
function addExt(t, dir, name, skillNames = ['pdf-tools'], manifest = 'qwen-extension.json') {
  const root = path.join(t.home, '.qwen', 'extensions', dir);
  writeJson(path.join(root, manifest), { name });
  for (const s of skillNames) t.add('', s, fm(s, `ext ${s}`), root);
  return root;
}
const names = (t) => [...discoverSkills({ cwd: t.cwd, home: t.home }).skills.keys()].sort();
const enablement = (t, o) => writeJson(path.join(t.home, '.qwen', 'extensions', 'extension-enablement.json'), o);

test('custom user directories: tilde, relative to home, user settings only', () => {
  const t = setup();
  try {
    t.add('.qwen', 'builtin', fm('dup', 'default user'), t.home);
    fs.mkdirSync(path.join(t.home, 'mine'));
    const d1 = path.join(t.home, 'mine', 'skills-a'), d2 = path.join(t.home, 'rel');
    for (const [d, n, desc] of [[d1, 'a', 'custom a'], [d2, 'b', 'custom b'], [d2, 'dup', 'custom dup']]) {
      fs.mkdirSync(path.join(d, n), { recursive: true });
      fs.writeFileSync(path.join(d, n, 'SKILL.md'), fm(n, desc));
    }
    const evil = path.join(t.tmp, 'evil');
    fs.mkdirSync(path.join(evil, 'x'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'x', 'SKILL.md'), fm('x', 'evil'));
    settings(t.home, { directories: ['~/mine/skills-a', 'rel'] });
    settings(t.cwd, { directories: [evil] });
    const { skills, warnings } = discoverSkills({ cwd: t.cwd, home: t.home });
    assert.deepEqual([...skills.keys()].sort(), ['a', 'b', 'dup']);
    assert.equal(skills.get('dup').description, 'default user'); // custom dirs come after default user roots
    assert.equal(skills.get('a').scope, 'user');
    assert.ok(warnings.some((w) => w.includes('ignoring skills.directories')));
  } finally { t.done(); }
});

test('disabledLevels and disabled names', () => {
  const t = setup();
  try {
    t.add('.qwen', 'p', fm('proj', 'p'));
    t.add('.qwen', 'u', fm('usr', 'u'), t.home);
    addExt(t, 'e1', 'ext');
    assert.deepEqual(names(t), ['ext:pdf-tools', 'proj', 'usr']);
    settings(t.home, { disabledLevels: ['user'] });
    assert.deepEqual(names(t), ['ext:pdf-tools', 'proj']);
    settings(t.cwd, { disabledLevels: ['project', 'extension'] });
    assert.deepEqual(names(t), []);
    settings(t.home, { disabled: ['PROJ'] });
    settings(t.cwd, { disabled: ['Ext:PDF-tools'] });
    assert.deepEqual(names(t), ['usr']);
    settings(t.home, { disabled: [] });
    settings(t.cwd, { disabled: ['pdf-tools'] }); // authored name matches an extension skill too
    assert.deepEqual(names(t), ['proj', 'usr']);
  } finally { t.done(); }
});

test('extensions: qualified names, manifests, ignored entries, coexist with plain skills', () => {
  const t = setup();
  try {
    t.add('.qwen', 'pdf', fm('pdf', 'project pdf'));
    addExt(t, 'demo', 'demo-ext');
    addExt(t, 'legacy', 'old-ext', ['x'], 'gemini-extension.json');
    addExt(t, 'extension-store', 'store-ext', ['s']);
    fs.mkdirSync(path.join(t.home, '.qwen', 'extensions', 'nomanifest', 'skills', 'n'), { recursive: true });
    fs.writeFileSync(path.join(t.home, '.qwen', 'extensions', 'nomanifest', 'skills', 'n', 'SKILL.md'), fm('n', 'd'));
    const { skills } = discoverSkills({ cwd: t.cwd, home: t.home });
    assert.deepEqual([...skills.keys()].sort(), ['demo-ext:pdf-tools', 'old-ext:x', 'pdf']);
    assert.equal(skills.get('demo-ext:pdf-tools').scope, 'extension');
    assert.equal(skills.get('demo-ext:pdf-tools').ext, 'demo-ext');
  } finally { t.done(); }
});

test('extension enablement: default, user scope, workspace scope, re-enable, realpath', () => {
  const t = setup();
  try {
    addExt(t, 'demo', 'demo-ext');
    const ws = path.join(t.home, 'ws'), outside = t.cwd; // ws is under home, outside is not
    fs.mkdirSync(ws);
    const on = (cwd) => [...discoverSkills({ cwd, home: t.home }).skills.keys()].length === 1;
    assert.ok(on(ws));
    enablement(t, { 'demo-ext': { overrides: [`!${t.home}/*`] } });
    assert.ok(!on(ws) && on(outside));
    enablement(t, { 'demo-ext': { overrides: [`!${t.home}/*`, `${ws}/`] } });
    assert.ok(on(ws));
    enablement(t, { 'demo-ext': { overrides: [`${ws}/`, `!${t.home}/*`] } }); // last matching rule wins
    assert.ok(!on(ws));
    enablement(t, { 'demo-ext': { overrides: [`!${outside}`] } }); // workspace scope: only that directory
    assert.ok(!on(outside) && on(ws));
    assert.ok(on(path.join(outside, 'sub')));
    enablement(t, '{not json');
    assert.ok(on(outside));
    // rules are also checked against the realpath of cwd
    const link = path.join(t.tmp, 'link');
    fs.symlinkSync(t.cwd, link);
    enablement(t, { 'demo-ext': { overrides: [`!${t.cwd}/`] } });
    assert.ok(!on(link));
  } finally { t.done(); }
});

test('extension skills may not symlink outside their extension; linked extension dirs are allowed', () => {
  const t = setup();
  try {
    const root = addExt(t, 'demo', 'demo-ext', []);
    const outside = path.join(t.tmp, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'SKILL.md'), fm('escaped', 'x'));
    fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'skills', 'escaped'));
    const d = t.add('', 'linkfile', null, root);
    fs.writeFileSync(path.join(t.tmp, 'o.md'), fm('linkfile', 'x'));
    fs.symlinkSync(path.join(t.tmp, 'o.md'), path.join(d, 'SKILL.md'));
    const linked = path.join(t.tmp, 'linked-src');
    writeJson(path.join(linked, 'qwen-extension.json'), { name: 'linked' });
    fs.mkdirSync(path.join(linked, 'skills', 'ok'), { recursive: true });
    fs.writeFileSync(path.join(linked, 'skills', 'ok', 'SKILL.md'), fm('ok', 'fine'));
    fs.symlinkSync(linked, path.join(t.home, '.qwen', 'extensions', 'linked'));
    const { skills, warnings } = discoverSkills({ cwd: t.cwd, home: t.home });
    assert.deepEqual([...skills.keys()], ['linked:ok']);
    assert.ok(warnings.some((w) => w.includes('leaves the extension')));
    assert.ok(warnings.some((w) => w.includes('leaves the skill directory')));
  } finally { t.done(); }
});
