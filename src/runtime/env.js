// @ts-check
/** Child environment: strip metered-API credentials (unless opted in) and the shim token. */
export function buildChildEnv(env, { keepAnthropicEnv = false } = {}) {
  const out = { ...env };
  if (!keepAnthropicEnv) {
    delete out.ANTHROPIC_API_KEY;
    delete out.ANTHROPIC_AUTH_TOKEN;
    delete out.ANTHROPIC_BASE_URL;
  }
  delete out.QCR_TOKEN;
  return out;
}
