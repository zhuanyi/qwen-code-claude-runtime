// @ts-check
import { createClaudeBackend } from './claude.js';
import { createReasonixBackend } from './reasonix.js';

/**
 * An agent CLI that qcr runs for each chat turn. The HTTP/SSE layer (src/server) only talks to this interface;
 * everything CLI-specific (argv, stdin encoding, stream parsing, error classification, footer text) lives here.
 *
 * Parsers emit the normalized events defined by src/runtime/parser.js: `init`, `text`, `tool_start`, `tool_end`,
 * `context_usage`, `rate_limit`, `notice` and a final `result`.
 *
 * @typedef {object} Backend
 * @property {'claude'|'reasonix'} name
 * @property {string} displayName              'Claude' | 'Reasonix', used in messages
 * @property {string[]} models                 model ids listed by GET /v1/models
 * @property {string} modelHint                error message for a model id this backend does not serve
 * @property {(id: unknown) => string|null} modelFromId   "<prefix>/<model>" -> "<model>", else null
 * @property {boolean} mcp                     supports Qwen MCP passthrough and the qwen-skills server
 * @property {boolean} killGroup               signal the whole process group on abort
 * @property {boolean} scrubAnthropicEnv       remove ANTHROPIC_* (and provider switches) from the child env
 * @property {(o: {model: string, resume?: string, mcpConfigPath?: string, allowedTools: string[]}) => string[]} mainArgs
 * @property {(prompt: string) => string} stdin                encodes a prompt for the child's stdin
 * @property {(o: {model: string, system: string, prompt: string, schema?: object,
 *   write: (name: string, content: string) => Promise<string>}) => Promise<{args: string[], stdin: string}>} side
 * @property {(result: any) => unknown} sideJson               JSON value of a schema-constrained side query
 * @property {() => {push(line: string): any[]}} createParser
 * @property {(p: any) => Error} classify                     maps a failed run to a BackendError
 * @property {(err: any) => boolean} isSessionNotFound
 * @property {() => Error} timeoutError
 * @property {string} failCode                 code for unexpected failures
 * @property {number} failStatus
 * @property {() => Error} invalidJsonError
 * @property {(result: any) => string} footer
 * @property {(names: string[]) => string} deniedLine
 * @property {(result: any) => object} finalExtra   non-standard fields added to the final chunk / completion
 */

export const BACKENDS = ['claude', 'reasonix'];

/**
 * @param {string} name
 * @param {{permissionMode?: string, cwd: string}} opts
 * @returns {Backend}
 */
export function createBackend(name, opts) {
  if (name === 'claude') return createClaudeBackend(opts);
  if (name === 'reasonix') return createReasonixBackend(opts);
  throw new Error(`unknown backend "${name}" (expected ${BACKENDS.join(' or ')})`);
}
