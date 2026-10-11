// @ts-check
const CLOUD_FLAGS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/** Child environment: strip metered-API/cloud-provider settings (unless opted in) and the shim token. */
export function buildChildEnv(env, { keepAnthropicEnv = false } = {}) {
  const out = { ...env };
  if (!keepAnthropicEnv) {
    for (const k of Object.keys(out)) if (k.startsWith('ANTHROPIC_')) delete out[k];
    for (const k of CLOUD_FLAGS) delete out[k];
  }
  delete out.QCR_TOKEN;
  return out;
}
