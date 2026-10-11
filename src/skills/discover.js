// @ts-check
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{name: string, description: string, dir: string, file: string, body: string, scope: 'project'|'user'}} Skill */

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

/**
 * @param {{cwd: string, home: string}} p
 * @returns {{skills: Map<string, Skill>, warnings: string[]}}
 */
export function discoverSkills({ cwd, home }) {
  /** @type {Map<string, Skill>} */ const skills = new Map();
  /** @type {string[]} */ const warnings = [];
  const roots = /** @type {[string, 'project'|'user'][]} */ ([
    [path.join(cwd, '.qwen', 'skills'), 'project'], [path.join(cwd, '.agents', 'skills'), 'project'],
    [path.join(home, '.qwen', 'skills'), 'user'], [path.join(home, '.agents', 'skills'), 'user']]);
  for (const [root, scope] of roots) {
    let entries, realRoot;
    try { entries = fs.readdirSync(root).sort(); realRoot = fs.realpathSync(root); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(root, entry, 'SKILL.md');
      try {
        const dir = fs.realpathSync(path.join(root, entry));
        if (!fs.statSync(dir).isDirectory()) continue;
        // A repository must not point a project skill (or its SKILL.md) outside the project via symlinks.
        if (scope === 'project' && !dir.startsWith(realRoot + path.sep)) { warnings.push(`skill ${file}: symlink leaves the project; skipped`); continue; }
        if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
        const real = fs.realpathSync(path.join(dir, 'SKILL.md'));
        if (!real.startsWith(dir + path.sep)) { warnings.push(`skill ${file}: SKILL.md symlink leaves the skill directory; skipped`); continue; }
        const buf = Buffer.alloc(MAX_BYTES);
        const fd = fs.openSync(real, 'r');
        const n = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
        fs.closeSync(fd);
        const fm = parseFrontmatter(buf.toString('utf8', 0, n));
        if (!fm) { warnings.push(`skill ${file}: missing frontmatter; skipped`); continue; }
        const { name, description } = fm.data;
        if (!name || !description) { warnings.push(`skill ${file}: name and description are required; skipped`); continue; }
        if (!NAME_RE.test(name)) { warnings.push(`skill ${file}: invalid name "${name.slice(0, 40)}"; skipped`); continue; }
        if (fm.data['disable-model-invocation'] === 'true') continue;
        if (skills.has(name)) continue;
        skills.set(name, { name, description, dir, file: real, body: fm.body.trim(), scope });
      } catch (e) {
        warnings.push(`skill ${file}: ${/** @type {Error} */ (e).message}; skipped`);
      }
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
