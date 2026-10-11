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
    .replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, '[REDACTED]')
    .slice(0, 2000);
}

/**
 * @param {{result?: any, stderr?: string, spawnError?: any, exitCode?: number|null, resetsAt?: number|null}} p
 */
export function classifyError({ result, stderr, spawnError, exitCode, resetsAt } = {}) {
  if (spawnError) {
    if (spawnError.code === 'ENOENT') {
      return new ClaudeError('claude_not_found', 'Claude Code CLI (`claude`) not found on PATH. Install it and run `claude` once to log in, or set QCR_CLAUDE_BIN.', 503);
    }
    return new ClaudeError('claude_failed', redact(`Could not start claude: ${spawnError.message}`), 502);
  }
  const status = result?.apiErrorStatus ?? null;
  const text = redact([result?.text, stderr].filter(Boolean).join('\n').trim());
  if (status === 401 || /not logged in|please run \/login|invalid api key|oauth (session|token) expired|failed to authenticate/i.test(text)) {
    return new ClaudeError('claude_not_logged_in', 'Claude Code is not logged in. Run `claude` in a terminal and complete /login.', 401);
  }
  if (/No conversation found with session ID/.test(text)) {
    return new ClaudeError('claude_session_not_found', text, 409);
  }
  if (status === 429 || /rate limit|usage limit|limit reached|quota/i.test(text)) {
    let when = 'unknown';
    if (typeof resetsAt === 'number') {
      const d = new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt);
      if (!isNaN(d.getTime())) when = d.toISOString();
    }
    return new ClaudeError('claude_rate_limited', `Claude quota exhausted; will reset at ${when}${text ? ` (${text})` : ''}`, 429);
  }
  if (status === 400 || status === 404 || /unrecognized.model|unknown model|issue with the selected model|model .*not found/i.test(text)) {
    return new ClaudeError('claude_bad_request', text || 'Claude rejected the request', 400);
  }
  const detail = text || `claude exited with code ${exitCode ?? 'unknown'}`;
  return new ClaudeError('claude_failed', detail, 502);
}

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}
