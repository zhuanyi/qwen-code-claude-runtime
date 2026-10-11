// @ts-check
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildClaudeArgs, modelAliasFromId } from '../runtime/argv.js';
import { buildChildEnv } from '../runtime/env.js';
import { ClaudeError, ConfigError, classifyError, redact } from '../runtime/errors.js';
import { loadQwenMcpServers, toClaudeMcpConfig } from '../runtime/mcp.js';
import { runClaude } from '../runtime/run.js';
import { withTempDir } from '../runtime/tempdir.js';
import { extractWorkingDir, fingerprint, messageText, renderTranscript, splitForResume, stripSystemReminders } from './messages.js';
import { chunk, deniedLine, errorBody, errorLine, footerLine, toolFailedLine, toolStartLine } from './openai.js';

/**
 * @typedef {{bin: string, cwd: string, home: string, permissionMode?: string, allowedTools?: string[],
 *   keepAnthropicEnv?: boolean, mcp?: boolean, toolProgress?: string, footer?: boolean,
 *   sessions: import('./sessions.js').SessionStore, keepaliveMs?: number, commitMs?: number,
 *   env?: NodeJS.ProcessEnv}} HandlerConfig
 */

const NO_RETRY = { 'x-should-retry': 'false' };

/** @param {import('node:http').ServerResponse} res @param {number} status @param {any} body */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...NO_RETRY });
  res.end(JSON.stringify(body));
}

/** @param {import('node:http').ServerResponse} res @param {any} err */
function sendError(res, err) {
  const known = err instanceof ClaudeError;
  const status = known ? err.httpStatus : err instanceof ConfigError ? 400 : 502;
  const code = known ? err.code : err instanceof ConfigError ? 'invalid_request' : 'claude_failed';
  sendJson(res, status, errorBody(code, redact(err?.message ?? 'internal error'), status >= 500 ? 'server_error' : 'invalid_request_error'));
  return code;
}

/** Drain events until the result; returns it plus bookkeeping. */
async function collect(events) {
  /** @type {any} */ let result = null;
  let resetsAt = null;
  for await (const ev of events) {
    if (ev.type === 'rate_limit') resetsAt = ev.resetsAt;
    if (ev.type === 'result') result = ev;
  }
  if (result?.isError) throw classifyError({ result, resetsAt });
  return result;
}

const sumInput = (/** @type {any} */ u) => u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;

/** @param {HandlerConfig} cfg */
export function createHandler(cfg) {
  const env = buildChildEnv(cfg.env ?? process.env, { keepAnthropicEnv: cfg.keepAnthropicEnv });
  const toolProgress = cfg.toolProgress ?? 'content';
  const base = () => ({ bin: cfg.bin, cwd: cfg.cwd, env });
  const permissionMode = cfg.permissionMode ?? 'manual';

  /** @returns {Promise<string|undefined>} error code, if any */
  async function handleChatCompletion(/** @type {any} */ body, /** @type {import('node:http').ServerResponse} */ res, /** @type {AbortSignal} */ signal) {
    const model = modelAliasFromId(body?.model);
    if (!model) return fail(res, 400, 'invalid_model', 'model must look like claude-code/<alias>');
    if (!Array.isArray(body.messages) || !body.messages.length) return fail(res, 400, 'invalid_request', 'messages must be a non-empty array');
    const dir = extractWorkingDir(body.messages);
    if (dir && path.resolve(dir) !== path.resolve(cfg.cwd)) {
      return fail(res, 400, 'cwd_mismatch', `Qwen Code is working in ${dir} but this shim runs Claude in ${cfg.cwd}. Start \`qcr serve\` in that directory or set QCR_CWD.`);
    }
    try {
      return body.stream === true ? await mainTurn(body, model, res, signal) : await sideQuery(body, model, res, signal);
    } catch (err) {
      if (signal.aborted) return 'aborted';
      return sendError(res, err);
    }
  }

  function fail(/** @type {any} */ res, /** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ msg) {
    sendJson(res, status, errorBody(code, msg));
    return code;
  }

  async function sideQuery(/** @type {any} */ body, /** @type {string} */ model, /** @type {any} */ res, /** @type {AbortSignal} */ signal) {
    const system = body.messages.filter((/** @type {any} */ m) => m.role === 'system').map(messageText).join('\n\n');
    const prompt = renderTranscript(body.messages, 200000, 100000)
      + '\n\nAnswer the last user message above. Reply with your answer only.';
    const fns = (body.tools ?? []).filter((/** @type {any} */ t) => t?.type === 'function' && t.function?.name);
    const tc = body.tool_choice;
    const forced = (tc === 'required' || tc?.type === 'function') && fns.length === 1 ? fns[0].function : null;

    const result = await withTempDir(async (_dir, write) => {
      const systemPromptFile = await write('system.txt', system || 'You are a helpful assistant.');
      const args = buildClaudeArgs({ model, permissionMode, side: { systemPromptFile, jsonSchema: forced?.parameters } });
      return collect(runClaude({ ...base(), args, prompt, signal }).events);
    });
    if (!result) throw classifyError({ stderr: 'claude produced no result' });

    const usage = { prompt_tokens: sumInput(result.usage), completion_tokens: result.usage.outputTokens,
      total_tokens: sumInput(result.usage) + result.usage.outputTokens };
    let message, finish = 'stop';
    if (forced) {
      let args;
      try { args = JSON.stringify(result.structuredOutput ?? JSON.parse(result.text)); }
      catch { throw new ClaudeError('claude_failed', 'Claude did not return valid JSON for the requested schema', 502); }
      message = { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_' + randomBytes(8).toString('hex'), type: 'function', function: { name: forced.name, arguments: args } }] };
      finish = 'tool_calls';
    } else {
      message = { role: 'assistant', content: result.text };
    }
    sendJson(res, 200, { id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage, x_claude_cost_usd: result.costUsd });
  }

  async function mainTurn(/** @type {any} */ body, /** @type {string} */ model, /** @type {import('node:http').ServerResponse} */ res, /** @type {AbortSignal} */ signal) {
    const { prefix, tail } = splitForResume(body.messages);
    if (!tail.length) return fail(res, 400, 'invalid_request', 'no user message to answer');
    const fp = fingerprint(prefix);
    const sid = prefix.length ? cfg.sessions.get(fp) : undefined;
    const rawTail = tail.map(messageText).join('\n\n');
    const resumedPrompt = tail.map((m) => stripSystemReminders(messageText(m))).join('\n\n').trim() || rawTail;
    const freshPrompt = (prefix.length ? renderTranscript(prefix) + '\n\n' : '') + rawTail;

    const id = 'chatcmpl-' + randomUUID();
    const keepaliveMs = cfg.keepaliveMs ?? 15000;
    let committed = false;
    let emitted = '';
    /** @type {NodeJS.Timeout|undefined} */ let keepalive;
    /** @type {NodeJS.Timeout|undefined} */ let commitTimer;
    const send = (/** @type {any} */ o) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`); };
    const commit = () => {
      if (committed) return;
      committed = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...NO_RETRY });
      send(chunk({ id, model: body.model, delta: { role: 'assistant', content: '' } }));
      keepalive = setInterval(() => send(chunk({ id, model: body.model, delta: { content: '' } })), keepaliveMs);
    };
    const content = (/** @type {string} */ text) => {
      if (!text) return;
      commit();
      emitted += text;
      send(chunk({ id, model: body.model, delta: { content: text } }));
    };
    const cleanup = () => { clearInterval(keepalive); clearTimeout(commitTimer); };
    commitTimer = setTimeout(commit, cfg.commitMs ?? 2000);

    let code;
    /** @type {object|null} */ let finalUsage = null;
    try {
      const result = await withTempDir(async (_dir, write) => {
        const allowedTools = [...(cfg.allowedTools ?? [])];
        let mcpConfigPath;
        if (cfg.mcp !== false) {
          const loaded = loadQwenMcpServers({ cwd: cfg.cwd, home: cfg.home });
          const conv = toClaudeMcpConfig(loaded.servers);
          for (const w of [...loaded.warnings, ...conv.warnings]) console.error(`[qcr] ${w}`);
          if (Object.keys(conv.config.mcpServers).length) {
            mcpConfigPath = await write('mcp.json', JSON.stringify(conv.config));
            for (const n of conv.trustedNames) allowedTools.push(`mcp__${n}__*`);
          }
        }
        let resumeId = sid;
        for (;;) {
          const args = buildClaudeArgs({ model, permissionMode, resume: resumeId, mcpConfigPath, allowedTools });
          try {
            return await runTurn(args, resumeId ? resumedPrompt : freshPrompt);
          } catch (err) {
            if (!(resumeId && err instanceof ClaudeError && err.code === 'claude_session_not_found' && !emitted)) throw err;
            cfg.sessions.delete(fp);
            resumeId = undefined;
          }
        }
      });
      // Temp files are gone before the client sees the end of the stream.
      cfg.sessions.set(fingerprint([...body.messages, { role: 'assistant', content: emitted }]), result.sessionId);
      finish(finalUsage, result.costUsd);
      return code;
    } catch (err) {
      if (signal.aborted) { res.end(); return 'aborted'; }
      if (!committed) { cleanup(); return sendError(res, err); }
      code = err instanceof ClaudeError ? err.code : 'claude_failed';
      content(errorLine(redact(/** @type {any} */ (err)?.message ?? 'error')));
      finish(null, 0);
      return code;
    } finally {
      cleanup();
    }

    /** @param {string[]} args @param {string} prompt */
    async function runTurn(args, prompt) {
      let ctx = null;
      let resetsAt = null;
      /** @type {any} */ let result = null;
      for await (const ev of runClaude({ ...base(), args, prompt, signal }).events) {
        switch (ev.type) {
          case 'init': commit(); break;
          case 'text': content(ev.text); break;
          case 'tool_start': if (toolProgress === 'content') content(toolStartLine(ev.name, ev.summary)); break;
          case 'tool_end': if (toolProgress === 'content' && ev.isError) content(toolFailedLine(ev.name)); break;
          case 'context_usage': ctx = ev; break;
          case 'rate_limit': resetsAt = ev.resetsAt; break;
          case 'result': result = ev; break;
        }
      }
      if (!result) throw classifyError({ stderr: 'claude produced no result' });
      if (result.isError) throw classifyError({ result, resetsAt });
      const names = [...new Set(result.permissionDenials.map((/** @type {any} */ d) => d.tool_name).filter(Boolean))];
      if (names.length) content(deniedLine(/** @type {string[]} */ (names)));
      if (cfg.footer !== false) content(footerLine(result.numTurns, result.costUsd));
      const u = result.usage;
      const prompt_tokens = ctx ? ctx.inputTokens : sumInput(u);
      finalUsage = { prompt_tokens, completion_tokens: u.outputTokens, total_tokens: prompt_tokens + u.outputTokens,
        prompt_tokens_details: { cached_tokens: ctx ? ctx.cachedTokens : u.cacheReadTokens } };
      return result;
    }

    /** @param {object|null} usage @param {number} cost */
    function finish(usage, cost) {
      commit();
      cleanup();
      const last = chunk({ id, model: body.model, delta: {}, finishReason: 'stop', usage: usage ?? undefined });
      send(cost || usage ? { ...last, x_claude_cost_usd: cost } : last);
      if (!res.writableEnded) res.end('data: [DONE]\n\n');
    }
  }

  return { handleChatCompletion };
}
