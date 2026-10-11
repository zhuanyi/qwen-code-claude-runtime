// @ts-check
import { buildClaudeArgs, modelAliasFromId } from '../runtime/argv.js';
import { ClaudeError, classifyError } from '../runtime/errors.js';
import { createStreamParser } from '../runtime/parser.js';
import { deniedLine, footerLine } from '../server/openai.js';

/** The official Claude Code CLI (`claude -p --output-format stream-json`). @returns {import('./index.js').Backend} */
export function createClaudeBackend({ permissionMode = 'manual' } = {}) {
  const stdin = (/** @type {string} */ prompt) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
  return {
    name: 'claude',
    displayName: 'Claude',
    models: ['sonnet', 'opus', 'haiku'].map((a) => `claude-code/${a}`),
    modelHint: 'model must look like claude-code/<alias>',
    modelFromId: modelAliasFromId,
    mcp: true,
    killGroup: false,
    scrubAnthropicEnv: true,
    mainArgs: ({ model, resume, mcpConfigPath, allowedTools }) =>
      buildClaudeArgs({ model, permissionMode, resume, mcpConfigPath, allowedTools }),
    stdin,
    async side({ model, system, prompt, schema, write }) {
      const systemPromptFile = await write('system.txt', system || 'You are a helpful assistant.');
      return { args: buildClaudeArgs({ model, permissionMode, side: { systemPromptFile, jsonSchema: schema } }), stdin: stdin(prompt) };
    },
    sideJson: (result) => result.structuredOutput ?? JSON.parse(result.text),
    createParser: createStreamParser,
    classify: classifyError,
    isSessionNotFound: (err) => err?.code === 'claude_session_not_found',
    timeoutError: () => new ClaudeError('claude_timeout', 'Claude turn exceeded the time limit (QCR_TURN_TIMEOUT_MS)', 504),
    failCode: 'claude_failed',
    failStatus: 502,
    invalidJsonError: () => new ClaudeError('claude_failed', 'Claude did not return valid JSON for the requested schema', 502),
    footer: (result) => footerLine(result.numTurns, result.costUsd),
    deniedLine,
    finalExtra: (result) => ({ x_claude_cost_usd: result.costUsd }),
  };
}
