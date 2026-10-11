// @ts-check
import fs from 'node:fs';
import readline from 'node:readline';
import { discoverSkills, listSkillFiles, readSkillFile } from './discover.js';

const VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const MAX_DESC = 8000;

/** @param {Map<string, import('./discover.js').Skill>} skills */
function skillTool(skills) {
  const head = 'Load a Qwen Code skill (instructions + base directory + supporting file list). Use when a task matches a skill below.\n\nAvailable skills:';
  const lines = [...skills.values()].map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ')}`);
  let description = 'No Qwen skills are installed.';
  if (lines.length) {
    let text = head, used = 0;
    for (const l of lines) {
      if (text.length + l.length + 1 > MAX_DESC - 30) break;
      text += '\n' + l; used++;
    }
    description = used < lines.length ? `${text}\n… (${lines.length - used} more)` : text;
  }
  return { name: 'qwen_skill', description, inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } };
}

const FILE_TOOL = {
  name: 'qwen_skill_file',
  description: "Read a supporting file (e.g. a reference or script) from a Qwen skill's directory; paths are relative to the skill directory.",
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['name', 'path'] },
};

class RpcError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** @param {{cwd: string, home: string}} p @param {any} params */
function callTool({ cwd, home }, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name !== 'qwen_skill' && name !== 'qwen_skill_file') throw new RpcError(-32602, `unknown tool: ${String(name).slice(0, 60)}`);
  if (typeof args.name !== 'string' || (name === 'qwen_skill_file' && typeof args.path !== 'string')) {
    throw new RpcError(-32602, 'invalid arguments');
  }
  try {
    const skill = discoverSkills({ cwd, home }).skills.get(args.name);
    if (!skill) throw new Error(`unknown skill: ${args.name.slice(0, 60)}`);
    if (name === 'qwen_skill_file') return { content: [{ type: 'text', text: readSkillFile(skill, args.path) }] };
    const files = listSkillFiles(skill);
    const text = `# Skill: ${skill.name}\n${skill.ext ? `Extension: ${skill.ext}\n` : ''}Base directory: ${skill.dir}\n\n${skill.body}` +
      (files.length ? `\n\nSupporting files:\n${files.map((f) => `- ${f}`).join('\n')}` : '');
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: /** @type {Error} */ (e).message }], isError: true };
  }
}

/** @param {{cwd: string, home: string}} ctx @param {any} msg */
function dispatch(ctx, msg) {
  const { method, params } = msg;
  switch (method) {
    case 'initialize': {
      const v = params?.protocolVersion;
      return { protocolVersion: VERSIONS.includes(v) ? v : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'qwen-skills', version: VERSION } };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: [skillTool(discoverSkills(ctx).skills), FILE_TOOL] };
    case 'tools/call': return callTool(ctx, params);
    default: throw new RpcError(-32601, `method not found: ${String(method).slice(0, 60)}`);
  }
}

/** @param {{cwd: string, home: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} o */
export async function runSkillsMcpServer({ cwd, home, input = process.stdin, output = process.stdout }) {
  const send = (/** @type {any} */ o) => output.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ id: null, error: { code: -32700, message: 'parse error' } }); continue; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      send({ id: msg?.id ?? null, error: { code: -32600, message: 'invalid request' } });
      continue;
    }
    if (!('id' in msg)) continue; // notification
    try { send({ id: msg.id, result: dispatch({ cwd, home }, msg) }); }
    catch (e) {
      const code = e instanceof RpcError ? e.code : -32603;
      if (!(e instanceof RpcError)) console.error(`[qcr-skills] ${/** @type {Error} */ (e).message}`);
      send({ id: msg.id, error: { code, message: e instanceof RpcError ? e.message : 'internal error' } });
    }
  }
}
