// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc } from '../runtime/mcp.js';

/** @typedef {{name: string, description: string, dir: string, file: string, body: string, scope: 'project'|'user'|'extension', ext?: string}} Skill */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BYTES = 256 * 1024;

/** Minimal frontmatter: top-level scalar keys only. @param {string} text */
function parseFrontmatter(text) {
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
  if (!m) return null;
  /** @type {Record<string, string>} */ const data = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/.exec(lines[i]);
    if (!kv) continue;
    let [, key, val] = kv;
    const cont = [];
    while (i + 1 < lines.length && (/^[ \t]/.test(lines[i + 1]) || lines[i + 1] === '')) cont.push(lines[++i]);
    const block = /^([>|])[+-]?$/.exec(val);
    if (block) {
      const ls = cont.map((l) => l.trim());
      while (ls.length && !ls.at(-1)) ls.pop();
      val = block[1] === '|' ? ls.join('\n') : ls.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/\n\n/g, '\n');
    } else {
      val = [val, ...cont.map((l) => l.trim())].filter(Boolean).join(' ');
      if (/^".*"$/.test(val)) { try { val = JSON.parse(val); } catch { val = val.slice(1, -1); } }
      else if (/^'.*'$/.test(val)) val = val.slice(1, -1).replace(/''/g, "'");
    }
    data[key] = val;
  }
  return { data, body: m[2] ?? '' };
}

/** `skills` section of a Qwen settings file ({} if absent or unparsable). @param {string} file @param {string[]} warnings */
function readSkillSettings(file, warnings) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  try { const s = parseJsonc(text)?.skills; return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; }
  catch { warnings.push(`could not parse ${file}; ignoring its skills settings`); return {}; }
}
const strings = (/** @type {any} */ v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/** Enablement overrides: later rules win, a leading `!` disables, a trailing `*` includes subdirectories. */
function extensionEnabled(/** @type {any} */ rules, /** @type {string[]} */ paths) {
  const norm = (/** @type {string} */ p) => { let s = p.replace(/\\/g, '/'); if (!s.startsWith('/')) s = '/' + s; return s.endsWith('/') ? s : s + '/'; };
  const targets = paths.map(norm);
  let enabled = true;
  for (const rule of strings(rules)) {
    const off = rule.startsWith('!');
    let r = off ? rule.slice(1) : rule;
    const subdirs = r.endsWith('*');
    if (subdirs) r = r.slice(0, -1);
    r = norm(r);
    if (targets.some((t) => t === r || (subdirs && t.startsWith(r)))) enabled = !off;
  }
  return enabled;
}

/**
 * @param {{cwd: string, home: string}} p
 * @returns {{skills: Map<string, Skill>, warnings: string[]}}
 */
export function discoverSkills({ cwd, home }) {
  /** @type {Map<string, Skill>} */ const skills = new Map();
  /** @type {string[]} */ const warnings = [];
  const userFile = path.join(home, '.qwen', 'settings.json'), projFile = path.join(cwd, '.qwen', 'settings.json');
  const us = readSkillSettings(userFile, warnings), ps = readSkillSettings(projFile, warnings);
  if (ps.directories !== undefined) warnings.push(`ignoring skills.directories in ${projFile}; custom skill directories are honoured only from the user settings`);
  const levels = new Set([...strings(us.disabledLevels), ...strings(ps.disabledLevels)]);
  const hidden = new Set([...strings(us.disabled), ...strings(ps.disabled)].map((n) => n.toLowerCase()));
  const custom = strings(us.directories).map((d) => (d === '~' ? home : d.startsWith('~/') ? path.join(home, d.slice(2)) : path.resolve(home, d)));
  const roots = /** @type {[string, 'project'|'user'][]} */ ([
    [path.join(cwd, '.qwen', 'skills'), 'project'], [path.join(cwd, '.agents', 'skills'), 'project'],
    [path.join(home, '.qwen', 'skills'), 'user'], [path.join(home, '.agents', 'skills'), 'user'],
    ...custom.map((d) => /** @type {[string, 'user']} */ ([d, 'user']))]);

  /** @param {string} root @param {Skill['scope']} scope @param {{name: string, real: string}} [ext] */
  const load = (root, scope, ext) => {
    if (levels.has(scope)) return;
    let entries, realRoot;
    try { entries = fs.readdirSync(root).sort(); realRoot = fs.realpathSync(root); } catch { return; }
    const bound = ext ? ext.real : realRoot; // project and extension skills must stay inside this directory
    if (scope !== 'user' && realRoot !== bound && !realRoot.startsWith(bound + path.sep)) { warnings.push(`skills ${root}: symlink leaves the ${ext ? 'extension' : 'project'}; skipped`); return; }
    for (const entry of entries) {
      const file = path.join(root, entry, 'SKILL.md');
      try {
        const dir = fs.realpathSync(path.join(root, entry));
        if (!fs.statSync(dir).isDirectory()) continue;
        // A repository must not point a project skill (or its SKILL.md) outside the project via symlinks.
        if (scope !== 'user' && !dir.startsWith(bound + path.sep)) { warnings.push(`skill ${file}: symlink leaves the ${ext ? 'extension' : 'project'}; skipped`); continue; }
        if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
        const real = fs.realpathSync(path.join(dir, 'SKILL.md'));
        if (!real.startsWith(dir + path.sep)) { warnings.push(`skill ${file}: SKILL.md symlink leaves the skill directory; skipped`); continue; }
        const buf = Buffer.alloc(MAX_BYTES);
        const fd = fs.openSync(real, 'r');
        const n = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
        fs.closeSync(fd);
        const fm = parseFrontmatter(buf.toString('utf8', 0, n));
        if (!fm) { warnings.push(`skill ${file}: missing frontmatter; skipped`); continue; }
        const { name: authored, description } = fm.data;
        if (!authored || !description) { warnings.push(`skill ${file}: name and description are required; skipped`); continue; }
        if (!NAME_RE.test(authored)) { warnings.push(`skill ${file}: invalid name "${authored.slice(0, 40)}"; skipped`); continue; }
        if (fm.data['disable-model-invocation'] === 'true') continue;
        const name = ext ? `${ext.name}:${authored}` : authored;
        if (hidden.has(name.toLowerCase()) || hidden.has(authored.toLowerCase())) continue;
        if (skills.has(name)) continue;
        skills.set(name, { name, description, dir, file: real, body: fm.body.trim(), scope, ...(ext && { ext: ext.name }) });
      } catch (e) {
        warnings.push(`skill ${file}: ${/** @type {Error} */ (e).message}; skipped`);
      }
    }
  };
  for (const [root, scope] of roots) load(root, scope);

  // Extensions: <home>/.qwen/extensions/<dir>/{qwen,gemini}-extension.json + skills/<skill>/SKILL.md.
  const extRoot = path.join(home, '.qwen', 'extensions');
  let extDirs = [];
  if (!levels.has('extension')) try { extDirs = fs.readdirSync(extRoot).sort(); } catch { /* none installed */ }
  /** @type {any} */ let enablement = {};
  try { enablement = JSON.parse(fs.readFileSync(path.join(extRoot, 'extension-enablement.json'), 'utf8')) ?? {}; } catch { /* all enabled */ }
  let realCwd = cwd;
  try { realCwd = fs.realpathSync(cwd); } catch { /* keep lexical */ }
  for (const entry of extDirs) {
    if (entry === 'extension-enablement.json' || entry === 'extension-store') continue;
    try {
      const real = fs.realpathSync(path.join(extRoot, entry)); // a symlink here is a user-installed (linked) extension
      if (!fs.statSync(real).isDirectory()) continue;
      let name;
      for (const f of ['qwen-extension.json', 'gemini-extension.json']) {
        try { name = JSON.parse(fs.readFileSync(path.join(real, f), 'utf8')).name; break; } catch { /* try next */ }
      }
      if (name === undefined) continue;
      if (typeof name !== 'string' || !NAME_RE.test(name)) { warnings.push(`extension ${entry}: invalid name; skipped`); continue; }
      if (!extensionEnabled(enablement?.[name]?.overrides, [cwd, realCwd])) continue;
      load(path.join(real, 'skills'), 'extension', { name, real });
    } catch (e) {
      warnings.push(`extension ${entry}: ${/** @type {Error} */ (e).message}; skipped`);
    }
  }
  return { skills, warnings };
}

/** @param {Skill} skill @returns {string[]} */
export function listSkillFiles(skill) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ rel, /** @type {number} */ depth) => {
    let ents;
    try { ents = fs.readdirSync(path.join(skill.dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return; }
    for (const e of ents) {
      if (out.length >= 200) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 4 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(r, depth + 1);
      } else if (e.isFile() && r !== 'SKILL.md') out.push(r);
    }
  };
  walk('', 1);
  return out;
}

/** @param {Skill} skill @param {string} relPath @returns {string} */
export function readSkillFile(skill, relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0')) throw new Error('invalid path');
  if (path.isAbsolute(relPath)) throw new Error('path must be relative to the skill directory');
  let real;
  try { real = fs.realpathSync(path.join(skill.dir, relPath)); } catch { throw new Error(`file not found: ${relPath}`); }
  if (!real.startsWith(skill.dir + path.sep)) throw new Error('path escapes the skill directory');
  const st = fs.statSync(real);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > MAX_BYTES) throw new Error(`file too large (limit ${MAX_BYTES} bytes)`);
  const buf = fs.readFileSync(real);
  if (buf.subarray(0, 8192).includes(0)) throw new Error('binary file');
  return buf.toString('utf8');
}
