#!/usr/bin/env node
// @ts-check
import os from 'node:os';
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
QCR_TOOL_PROGRESS (content|off), QCR_FOOTER=off, QCR_TOKEN`;

const [cmd, ...rest] = process.argv.slice(2);
const home = os.homedir();
const env = process.env;

if (cmd === 'token') {
  console.log(loadOrCreateToken({ env, home }));
} else if (cmd === 'serve') {
  const i = rest.indexOf('--port');
  const port = Number(i >= 0 ? rest[i + 1] : env.QCR_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('invalid port'); process.exit(2); }
  const token = loadOrCreateToken({ env, home });
  const cfg = {
    bin: env.QCR_CLAUDE_BIN || 'claude',
    cwd: env.QCR_CWD || process.cwd(),
    home,
    permissionMode: env.QCR_PERMISSION_MODE || 'manual',
    allowedTools: (env.QCR_ALLOWED_TOOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    keepAnthropicEnv: env.QCR_KEEP_ANTHROPIC_ENV === '1',
    mcp: env.QCR_MCP !== 'off',
    toolProgress: env.QCR_TOOL_PROGRESS === 'off' ? 'off' : 'content',
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
