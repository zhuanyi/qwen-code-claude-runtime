#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildClaudeArgs } from '../src/runtime/argv.js';
import { cleanStaleTempDirs } from '../src/runtime/tempdir.js';
import { SessionStore } from '../src/server/sessions.js';
import { startServer } from '../src/server/http.js';
import { loadOrCreateToken, tokenPath } from '../src/server/token.js';

const HELP = `qcr - run Qwen Code turns on your local Claude Code CLI

Usage:
  qcr serve [--port N]   start the local OpenAI-compatible shim (default port 8787)
  qcr token              print the shim bearer token (use it as the API key in Qwen Code)
  qcr --help

Environment: QCR_PORT, QCR_CLAUDE_BIN, QCR_CWD, QCR_PERMISSION_MODE (manual|acceptEdits|plan),
QCR_ALLOWED_TOOLS (comma list), QCR_KEEP_ANTHROPIC_ENV=1, QCR_MCP=off,
QCR_TOOL_PROGRESS (content|off), QCR_FOOTER=off, QCR_TOKEN, QCR_PROJECT_MCP=1,
QCR_MAX_CONCURRENCY (default 4), QCR_TURN_TIMEOUT_MS (default 1800000)`;

const die = (/** @type {string} */ msg) => { console.error(msg); process.exit(2); };
const posInt = (/** @type {string|undefined} */ v, /** @type {number} */ dflt, /** @type {string} */ name) => {
  if (!v) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) die(`invalid ${name}`);
  return n;
};

/** Resolve the claude binary once to an absolute path (absolute PATH entries only). @param {string} bin */
function resolveBin(bin) {
  if (bin.includes('/') || bin.includes(path.sep)) return path.resolve(bin);
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  console.error(`warning: could not find "${bin}" in PATH; requests will fail with claude_not_found (set QCR_CLAUDE_BIN)`);
  return bin;
}

const [cmd, ...rest] = process.argv.slice(2);
const home = os.homedir();
const env = process.env;

if (cmd === 'token') {
  console.log(loadOrCreateToken({ env, home }));
} else if (cmd === 'serve') {
  const i = rest.indexOf('--port');
  const port = Number(i >= 0 ? rest[i + 1] : env.QCR_PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('invalid port'); process.exit(2); }
  const toolProgress = env.QCR_TOOL_PROGRESS || 'content';
  if (toolProgress !== 'content' && toolProgress !== 'off') die('QCR_TOOL_PROGRESS must be content or off');
  const permissionMode = env.QCR_PERMISSION_MODE || 'manual';
  const allowedTools = (env.QCR_ALLOWED_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  try { buildClaudeArgs({ model: 'sonnet', permissionMode, allowedTools }); }
  catch (e) { die(`invalid configuration: ${/** @type {Error} */ (e).message}`); }
  const token = loadOrCreateToken({ env, home });
  cleanStaleTempDirs();
  const cfg = {
    bin: resolveBin(env.QCR_CLAUDE_BIN || 'claude'),
    cwd: env.QCR_CWD || process.cwd(),
    home,
    permissionMode,
    allowedTools,
    keepAnthropicEnv: env.QCR_KEEP_ANTHROPIC_ENV === '1',
    mcp: env.QCR_MCP !== 'off',
    projectMcp: env.QCR_PROJECT_MCP === '1',
    maxConcurrent: posInt(env.QCR_MAX_CONCURRENCY, 4, 'QCR_MAX_CONCURRENCY'),
    turnTimeoutMs: posInt(env.QCR_TURN_TIMEOUT_MS, 1800000, 'QCR_TURN_TIMEOUT_MS'),
    toolProgress,
    footer: env.QCR_FOOTER !== 'off',
    sessions: new SessionStore(),
  };
  const s = await startServer(cfg, { port, token });
  console.error(`qcr listening on http://127.0.0.1:${s.port}/v1 (cwd: ${cfg.cwd})`);
  console.error(env.QCR_TOKEN ? 'token: from QCR_TOKEN' : `token file: ${tokenPath(home)} (run \`qcr token\` to print it)`);
} else {
  console.log(HELP);
  process.exit(cmd === '--help' || cmd === '-h' ? 0 : 2);
}
