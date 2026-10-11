// @ts-check
/** @param {{id: string, model: string, delta: object, finishReason?: string|null, usage?: object}} p */
export function chunk({ id, model, delta, finishReason = null, usage }) {
  const c = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] };
  return usage ? { ...c, usage } : c;
}

export const errorBody = (/** @type {string} */ code, /** @type {string} */ message, type = 'invalid_request_error') =>
  ({ error: { message, type, code } });

export const toolStartLine = (/** @type {string} */ name, /** @type {string} */ summary) =>
  `\n> ⚙ ${name}${summary ? ' · ' + summary : ''}\n`;
export const toolFailedLine = (/** @type {string} */ name) => `> ✗ ${name} failed\n`;
export const deniedLine = (/** @type {string[]} */ names) =>
  `\n> ⛔ Claude was denied: ${names.join(', ')}. Allow them via QCR_PERMISSION_MODE=acceptEdits or QCR_ALLOWED_TOOLS.\n`;
export const footerLine = (/** @type {number} */ turns, /** @type {number} */ cost) =>
  `\n\n_claude-code · ${turns} turns · $${cost.toFixed(4)}_`;
export const errorLine = (/** @type {string} */ message) => `\n\n> ⚠ ${message}\n`;
