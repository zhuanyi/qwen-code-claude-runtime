// @ts-check
import { ConfigError } from './errors.js';
export { ConfigError };

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_RE = /^[A-Za-z0-9_*().:\- ]{1,200}$/;
const MODES = new Set(['manual', 'acceptEdits', 'plan']);
const FORBIDDEN = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions'];

/** "claude-code/sonnet" -> "sonnet"; null when the prefix is different. @param {unknown} id */
export function modelAliasFromId(id) {
  if (typeof id !== 'string' || !id.startsWith('claude-code/')) return null;
  return id.slice('claude-code/'.length);
}

/**
 * @param {{model: string, permissionMode?: string, resume?: string, mcpConfigPath?: string,
 *   allowedTools?: string[], side?: {systemPromptFile: string, jsonSchema?: object}}} opts
 * @returns {string[]}
 */
export function buildClaudeArgs(opts) {
  const { model, resume, mcpConfigPath, allowedTools = [], side } = opts;
  let mode = opts.permissionMode ?? 'manual';
  if (mode === 'default') mode = 'manual';
  if (typeof model !== 'string' || !ALIAS_RE.test(model)) throw new ConfigError('invalid model alias');
  if (!MODES.has(mode)) throw new ConfigError(`unsupported permission mode: ${mode}`);
  if (resume !== undefined && !UUID_RE.test(resume)) throw new ConfigError('resume must be a UUID');
  for (const t of allowedTools) {
    if (!TOOL_RE.test(t) || t.startsWith('-')) throw new ConfigError('invalid allowed tool entry');
  }
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  if (side) {
    args.push('--model', model, '--tools', '', '--no-session-persistence',
      '--permission-mode', mode, '--permission-prompts', 'none', '--system-prompt-file', side.systemPromptFile);
    if (side.jsonSchema) args.push('--json-schema', JSON.stringify(side.jsonSchema));
  } else {
    args.push('--include-partial-messages', '--model', model, '--permission-mode', mode, '--permission-prompts', 'none');
    if (resume) args.push('--resume', resume, '--fork-session');
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
    if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  }
  for (const a of args) {
    if (FORBIDDEN.some((f) => a.includes(f))) throw new ConfigError('forbidden permission flag');
  }
  return args;
}
