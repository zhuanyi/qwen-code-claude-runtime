// @ts-check
export class ClaudeError extends Error {
  /** @param {string} code @param {string} message @param {number} httpStatus */
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'ClaudeError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Remove secret-looking strings and cap the length. @param {string} s */
export function redact(s) {
  return String(s ?? '')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(?:ghp|gho|ghs)_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/xox[abpr]-[A-Za-z0-9-]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, '[REDACTED]')
    .replace(/(authorization|x-api-key)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .replace(/[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*\S+/g, '[REDACTED]')
    .slice(0, 2000);
}

const AUTH_RE = /^(Not logged in|Invalid API key|OAuth (session|token)[^\n]*expired|Failed to authenticate)/im;
const NO_SESSION_RE = /No conversation found with session ID/;
const LIMIT_RE = /usage limit|You've hit your (usage )?limit/i;
const MODEL_RE = /unrecognized.model|unknown model|issue with the selected model|model .*not found/i;

/**
 * Client-facing messages are fixed per code; raw stderr is only used for classification, never echoed.
 * @param {{result?: any, stderr?: string, spawnError?: any, exitCode?: number|null, resetsAt?: number|null, rejected?: boolean}} p
 */
export function classifyError({ result, stderr, spawnError, exitCode, resetsAt, rejected } = {}) {
  if (spawnError) {
    if (spawnError.code === 'ENOENT') {
      return new ClaudeError('claude_not_found', 'Claude Code CLI (`claude`) not found on PATH. Install it and run `claude` once to log in, or set QCR_CLAUDE_BIN.', 503);
    }
    return new ClaudeError('claude_failed', 'Could not start claude', 502);
  }
  const status = result?.apiErrorStatus ?? null;
  const text = String(result?.text ?? '');
  // Only lines that are not MCP server chatter may classify as a login problem.
  const errLines = String(stderr ?? '').split('\n').filter((l) => !/^MCP|MCP server/.test(l)).join('\n');
  if (status === 401 || status === 403 || AUTH_RE.test(text) || /^(Not logged in|Invalid API key)/im.test(errLines)) {
    return new ClaudeError('claude_not_logged_in', 'Claude Code is not logged in. Run `claude` in a terminal and complete /login.', 401);
  }
  if (NO_SESSION_RE.test(text) || NO_SESSION_RE.test(String(stderr ?? ''))) {
    return new ClaudeError('claude_session_not_found', 'Claude session to resume was not found', 409);
  }
  if (status === 429 || rejected === true || LIMIT_RE.test(text)) {
    let when = 'unknown';
    if (typeof resetsAt === 'number') {
      const d = new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt);
      if (!isNaN(d.getTime())) when = d.toISOString();
    }
    return new ClaudeError('claude_rate_limited', `Claude quota exhausted; will reset at ${when}`, 429);
  }
  if (status === 400 || status === 404 || MODEL_RE.test(text)) {
    return new ClaudeError('claude_bad_request', 'Claude rejected the request (bad request or unknown model)', 400);
  }
  const excerpt = redact(text.trim()).slice(0, 300);
  return new ClaudeError('claude_failed', excerpt || `claude exited with code ${exitCode ?? 'unknown'}`, 502);
}

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}
