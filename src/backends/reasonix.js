// @ts-check
// Reasonix (github.com/esengine/DeepSeek-Reasonix, npm "reasonix"), verified against v1.38.7.
// Headless: `reasonix -p --output-format stream-json` reads the prompt from stdin when no positional prompt is
// given and writes NDJSON events (`{"kind": ...}`), ending with one `{"type":"result", ...}` line
// (internal/cli/run_output.go). `--resume <session id> --copy` continues a saved session in a new copy and
// reports the copy's id in `result.session_id`. Headless runs never prompt: anything that needs approval is
// denied (tool_result runState "not_started", err "blocked by permission policy").
import { BackendError, ConfigError, redact } from '../runtime/errors.js';
import { summarize } from '../runtime/parser.js';

const PREFIX = 'reasonix/';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
// Session ids are the session file stem: "<UTC yyyymmdd-hhmmss.nanos>-<model>" (agent/session_paths.go).
const SESSION_RE = /^\d{8}-\d{6}\.\d{1,9}-[A-Za-z0-9._-]{1,128}$/;
const TOOL_RE = /^[A-Za-z0-9_*().:\- ]{1,200}$/;
// qcr permission mode -> Reasonix mode. "plan" needs an interactive Reasonix session (cli.go), so it is refused.
const MODES = /** @type {Record<string, string>} */ ({ manual: 'manual', default: 'manual', acceptEdits: 'acceptEdits' });
const FORBIDDEN_FLAGS = ['--dangerously-skip-permissions', '--yolo', '--auto', '-y', '--takeover'];
const FORBIDDEN_MODES = /^(auto|yolo|bypass-?permissions|dont-?ask)$/i;

/**
 * @param {{model: string, permissionMode?: string, cwd: string, resume?: string, allowedTools?: string[]}} o
 * @returns {string[]}
 */
export function buildReasonixArgs({ model, permissionMode = 'manual', cwd, resume, allowedTools = [] }) {
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new ConfigError('invalid model name');
  const mode = MODES[permissionMode];
  if (!mode) throw new ConfigError(`unsupported permission mode for reasonix: ${permissionMode} (use manual or acceptEdits)`);
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new ConfigError('cwd must be an absolute path');
  if (resume !== undefined && !SESSION_RE.test(resume)) throw new ConfigError('invalid reasonix session id');
  for (const t of allowedTools) {
    if (!TOOL_RE.test(t) || t.startsWith('-')) throw new ConfigError('invalid allowed tool entry');
  }
  const args = ['-p', '--output-format', 'stream-json', '--model', model, '--permission-mode', mode, '--dir', cwd];
  if (resume) args.push('--resume', resume, '--copy');
  if (allowedTools.length) args.push('--allowed-tools', allowedTools.join(','));
  args.forEach((a, i) => {
    if (FORBIDDEN_FLAGS.some((f) => a === f || a.startsWith(f + '='))) throw new ConfigError('forbidden permission flag');
    if (args[i - 1] === '--permission-mode' && FORBIDDEN_MODES.test(a)) throw new ConfigError('forbidden permission mode');
  });
  return args;
}

/** Incremental parser for `reasonix -p --output-format stream-json` lines. */
export function createReasonixParser() {
  /** @type {Set<string>} */ const streamed = new Set();   // messageIds that had `text` deltas
  /** @type {Set<string>} */ const started = new Set();    // tool ids already announced
  /** @type {Map<string,string>} */ const names = new Map();
  /** @type {{tool_name: string}[]} */ const denials = [];
  return {
    /** @param {string} line @returns {any[]} */
    push(line) {
      let o;
      try { o = JSON.parse(line); } catch { return []; }
      if (!o || typeof o !== 'object') return [];
      if (o.type === 'result') return [toResult(o, denials)];
      const tool = o.tool ?? {};
      switch (o.kind) {
        case 'turn_started': return [{ type: 'init', sessionId: null, model: null, tools: [] }];
        case 'text':
          if (o.messageId) streamed.add(o.messageId);
          return o.text ? [{ type: 'text', text: o.text }] : [];
        case 'message':
          // Full step text; only used when no deltas were streamed for this message.
          return o.text && !streamed.has(o.messageId) ? [{ type: 'text', text: o.text }] : [];
        case 'tool_dispatch': {
          if (tool.partial || !tool.id || started.has(tool.id)) return [];
          started.add(tool.id);
          const name = String(tool.resolvedName || tool.name || 'tool');
          names.set(tool.id, name);
          let input = null;
          try { input = JSON.parse(tool.args || 'null'); } catch { /* partial or non-JSON args */ }
          return [{ type: 'tool_start', id: tool.id, name, summary: summarize(input) }];
        }
        case 'tool_result': {
          const name = names.get(tool.id) ?? String(tool.resolvedName || tool.name || 'tool');
          if (tool.runState === 'not_started' && /permission/i.test(String(tool.err ?? ''))) denials.push({ tool_name: name });
          return [{ type: 'tool_end', id: tool.id, name, isError: Boolean(tool.err) }];
        }
        case 'usage': {
          const u = o.usage ?? {};
          return typeof u.promptTokens === 'number'
            ? [{ type: 'context_usage', inputTokens: u.promptTokens, cachedTokens: u.cacheHitTokens ?? 0 }] : [];
        }
        case 'retrying': {
          const r = o.recovery ?? {};
          const out = [{ type: 'notice', text: `Reasonix is retrying (${r.reason || r.phase || 'error'}, attempt ${o.retryAttempt ?? '?'}/${o.retryMax ?? '?'})` }];
          if (r.reason === 'rate_limit_error') out.push({ type: 'rate_limit', status: 'retrying', resetsAt: r.next_attempt_at ?? null });
          return out;
        }
        default: return [];
      }
    },
  };
}

/** @param {any} o @param {{tool_name: string}[]} denials */
function toResult(o, denials) {
  const u = o.usage ?? {};
  const read = u.cache_read_input_tokens ?? 0, created = u.cache_creation_input_tokens ?? 0;
  return {
    type: 'result',
    isError: o.is_error === true || o.subtype !== 'success',
    subtype: o.subtype,
    text: typeof o.result === 'string' ? o.result : '',
    sessionId: typeof o.session_id === 'string' ? o.session_id : null,
    costUsd: 0,
    cost: { amount: typeof o.total_cost === 'number' ? o.total_cost : null, currency: o.currency ?? '', complete: o.cost_complete === true },
    // Reasonix reports input_tokens as the full prompt, split into cache hits/misses; normalize to
    // "uncached input" so input + cacheRead + cacheCreation is the prompt size, as for claude.
    usage: { inputTokens: Math.max(0, (u.input_tokens ?? 0) - read - created), outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: read, cacheCreationTokens: created },
    numTurns: o.num_turns ?? 0,
    permissionDenials: [...denials],
    structuredOutput: undefined,
    apiErrorStatus: null,
  };
}

const err = (/** @type {string} */ code, /** @type {string} */ msg, /** @type {number} */ status) => new BackendError(code, msg, status);

/**
 * Persistent failures use 424, not 5xx: Qwen Code retries every 5xx from an OpenAI-compatible endpoint
 * (it ignores x-should-retry there), which would re-run whole agent turns.
 * @param {{result?: any, stderr?: string, spawnError?: any, exitCode?: number|null}} p
 */
export function classifyReasonixError({ result, stderr, spawnError, exitCode } = {}) {
  if (spawnError) {
    return spawnError.code === 'ENOENT'
      ? err('reasonix_not_found', 'Reasonix CLI (`reasonix`) not found on PATH. Install it (npm i -g reasonix) or set QCR_REASONIX_BIN.', 424)
      : err('reasonix_failed', 'Could not start reasonix', 424);
  }
  const text = String(result?.text ?? '');
  const errText = String(stderr ?? '');
  const missing = /missing env ([A-Z][A-Z0-9_]{0,63})/.exec(text);
  if (missing) return err('reasonix_not_configured', `Reasonix has no API key: set ${missing[1]} where qcr runs, or run \`reasonix setup\`.`, 401);
  if (/authentication failed/i.test(text)) return err('reasonix_auth_failed', 'Reasonix\'s model provider rejected the API key. Update it and retry.', 401);
  if (/quota exhausted|HTTP 402|insufficient balance/i.test(text)) {
    return err('reasonix_quota_exhausted', 'Reasonix quota exhausted; will reset at unknown. Check your provider balance.', 429);
  }
  if (/unknown model/i.test(text)) return err('reasonix_bad_request', 'Reasonix rejected the request (unknown model)', 400);
  if (/^error: no session matches/m.test(errText)) return err('reasonix_session_not_found', 'Reasonix session to resume was not found', 409);
  if (/^error: .*in use by another Reasonix process/m.test(errText)) return err('reasonix_session_busy', 'The Reasonix session is in use by another process', 409);
  if (/^error: (unknown flag|unknown output format|unknown permission mode)/m.test(errText)) {
    return err('reasonix_unsupported', 'This Reasonix version does not accept the flags qcr uses (tested with 1.38.7)', 424);
  }
  const excerpt = redact(text.trim()).slice(0, 300);
  return err('reasonix_failed', excerpt || `reasonix exited with code ${exitCode ?? 'unknown'}`, 424);
}

/** Pull a JSON value out of a reply that may wrap it in prose or a ```json fence. @param {string} text */
export function extractJson(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(body); } catch { /* fall through */ }
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
  throw new SyntaxError('no JSON object in reply');
}

/** @param {{permissionMode?: string, cwd: string}} opts @returns {import('./index.js').Backend} */
export function createReasonixBackend({ permissionMode = 'manual', cwd }) {
  const mainArgs = (/** @type {{model: string, resume?: string, allowedTools: string[]}} */ { model, resume, allowedTools }) =>
    buildReasonixArgs({ model, permissionMode, cwd, resume, allowedTools });
  return {
    name: 'reasonix',
    displayName: 'Reasonix',
    models: ['deepseek-flash', 'deepseek-pro'].map((m) => PREFIX + m),
    modelHint: 'model must look like reasonix/<model> (this qcr runs QCR_BACKEND=reasonix)',
    modelFromId: (id) => (typeof id === 'string' && id.startsWith(PREFIX) ? id.slice(PREFIX.length) : null),
    mcp: false,
    killGroup: true,
    // ANTHROPIC_* is stripped for claude to keep it on the subscription login; a Reasonix provider may need it.
    scrubAnthropicEnv: false,
    mainArgs,
    stdin: (prompt) => prompt,
    async side({ model, system, prompt, schema }) {
      // Reasonix has no system-prompt or structured-output flag, so both travel in the prompt.
      const parts = [];
      if (system) parts.push(`Instructions from the calling application:\n<instructions>\n${system}\n</instructions>`);
      parts.push(prompt);
      if (schema) parts.push(`Reply with only a JSON object that matches this JSON Schema, and no other text:\n${JSON.stringify(schema)}`);
      return { args: mainArgs({ model, allowedTools: [] }), stdin: parts.join('\n\n') };
    },
    sideJson: (result) => extractJson(result.text),
    createParser: createReasonixParser,
    classify: classifyReasonixError,
    isSessionNotFound: (e) => e?.code === 'reasonix_session_not_found',
    timeoutError: () => err('reasonix_timeout', 'Reasonix turn exceeded the time limit (QCR_TURN_TIMEOUT_MS)', 424),
    failCode: 'reasonix_failed',
    failStatus: 424,
    invalidJsonError: () => err('reasonix_failed', 'Reasonix did not return valid JSON for the requested schema', 424),
    footer: (r) => {
      const c = r.cost ?? {};
      const cost = c.complete && typeof c.amount === 'number' ? ` · ${c.amount.toFixed(4)}${c.currency ? ' ' + c.currency : ''}` : '';
      return `\n\n_reasonix · ${r.numTurns} turns${cost}_`;
    },
    deniedLine: (names) =>
      `\n> ⛔ Reasonix was denied: ${names.join(', ')}. Allow them via QCR_PERMISSION_MODE=acceptEdits or QCR_ALLOWED_TOOLS.\n`,
    finalExtra: (r) => (r.cost?.amount != null ? { x_cost: { amount: r.cost.amount, currency: r.cost.currency, complete: r.cost.complete } } : {}),
  };
}
