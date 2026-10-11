// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createBackend } from '../backends/index.js';
import { buildChildEnv } from '../runtime/env.js';
import { BackendError, ConfigError, redact } from '../runtime/errors.js';
import { loadQwenMcpServers, toClaudeMcpConfig } from '../runtime/mcp.js';
import { runAgent } from '../runtime/run.js';
import { withTempDir } from '../runtime/tempdir.js';
import { extractWorkingDir, fingerprint, messageText, renderTranscript, splitForResume, stripSystemReminders } from './messages.js';
import { chunk, errorBody, errorLine, noticeLine, toolFailedLine, toolStartLine } from './openai.js';

/**
 * @typedef {{bin: string, cwd: string, home: string, permissionMode?: string, allowedTools?: string[],
 *   keepAnthropicEnv?: boolean, mcp?: boolean, toolProgress?: string, footer?: boolean,
 *   sessions: import('./sessions.js').SessionStore, keepaliveMs?: number, commitMs?: number,
 *   env?: NodeJS.ProcessEnv, projectMcp?: boolean, skills?: boolean, maxConcurrent?: number, turnTimeoutMs?: number,
 *   backend?: import('../backends/index.js').Backend}} HandlerConfig
 */

const QCR_BIN = fileURLToPath(new URL('../../bin/qcr.js', import.meta.url));
const NO_RETRY = { 'x-should-retry': 'false' };

/** @param {import('node:http').ServerResponse} res @param {number} status @param {any} body */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', ...NO_RETRY });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').ServerResponse} res @param {any} err
 * @param {import('../backends/index.js').Backend} backend
 */
function sendError(res, err, backend) {
  const known = err instanceof BackendError;
  const status = known ? err.httpStatus : err instanceof ConfigError ? 400 : backend.failStatus;
  const code = known ? err.code : err instanceof ConfigError ? 'invalid_request' : backend.failCode;
  sendJson(res, status, errorBody(code, redact(err?.message ?? 'internal error'), status >= 500 || status === 424 ? 'server_error' : 'invalid_request_error'));
  return code;
}

const realOrResolved = (/** @type {string} */ p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/**
 * Drain events until the result; returns it plus bookkeeping.
 * @param {AsyncIterable<any>} events @param {(p: any) => Error} classify
 */
async function collect(events, classify) {
  /** @type {any} */ let result = null;
  let resetsAt = null;
  let rejected = false;
  for await (const ev of events) {
    if (ev.type === 'rate_limit') { resetsAt = ev.resetsAt; rejected = ev.status === 'rejected'; }
    if (ev.type === 'result') result = ev;
  }
  if (result?.isError) throw classify({ result, resetsAt, rejected });
  return result;
}

const sumInput = (/** @type {any} */ u) => u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;

/** @param {HandlerConfig} cfg */
export function createHandler(cfg) {
  const backend = cfg.backend ?? createBackend('claude', { permissionMode: cfg.permissionMode, cwd: cfg.cwd });
  const env = buildChildEnv(cfg.env ?? process.env, { keepAnthropicEnv: cfg.keepAnthropicEnv || !backend.scrubAnthropicEnv });
  const toolProgress = cfg.toolProgress ?? 'content';
  /** @param {string[]} args @param {string} stdin @param {AbortSignal} signal */
  const run = (args, stdin, signal) => runAgent({ bin: cfg.bin, cwd: cfg.cwd, env, args, stdin, signal,
    parser: backend.createParser(), classify: backend.classify, killGroup: backend.killGroup });
  const timeoutError = () => backend.timeoutError();

  /** @returns {Promise<string|undefined>} error code, if any */
  let active = 0;

  async function handleChatCompletion(/** @type {any} */ body, /** @type {import('node:http').ServerResponse} */ res, /** @type {AbortSignal} */ clientSignal) {
    const model = backend.modelFromId(body?.model);
    if (!model) return fail(res, 400, 'invalid_model', backend.modelHint);
    if (!Array.isArray(body.messages) || !body.messages.length) return fail(res, 400, 'invalid_request', 'messages must be a non-empty array');
    const dir = extractWorkingDir(body.messages);
    if (dir && realOrResolved(dir) !== realOrResolved(cfg.cwd)) {
      return fail(res, 400, 'cwd_mismatch', `Qwen Code is working in ${dir} but this shim runs ${backend.displayName} in ${cfg.cwd}. Start \`qcr serve\` in that directory or set QCR_CWD.`);
    }
    const max = cfg.maxConcurrent ?? 4;
    if (active >= max) {
      res.writeHead(429, { 'content-type': 'application/json', ...NO_RETRY });
      res.end(JSON.stringify(errorBody('qcr_busy', `qcr is already running ${active} ${backend.displayName} turns; try again when one finishes`, 'server_error')));
      return 'qcr_busy';
    }
    active++;
    // The turn signal fires on client abort or on the per-turn wall-clock limit.
    const turn = new AbortController();
    let timedOut = false;
    const onAbort = () => turn.abort();
    clientSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; turn.abort(); }, cfg.turnTimeoutMs ?? 1800000);
    const state = { signal: turn.signal, timedOut: () => timedOut };
    try {
      return body.stream === true ? await mainTurn(body, model, res, state) : await sideQuery(body, model, res, state);
    } catch (err) {
      if (timedOut) return sendError(res, timeoutError(), backend);
      if (turn.signal.aborted) return 'aborted';
      return sendError(res, err, backend);
    } finally {
      active--;
      clearTimeout(timer);
      clientSignal.removeEventListener('abort', onAbort);
    }
  }

  function fail(/** @type {any} */ res, /** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ msg) {
    sendJson(res, status, errorBody(code, msg));
    return code;
  }

  async function sideQuery(/** @type {any} */ body, /** @type {string} */ model, /** @type {any} */ res, /** @type {{signal: AbortSignal}} */ { signal }) {
    const system = body.messages.filter((/** @type {any} */ m) => m.role === 'system').map(messageText).join('\n\n');
    const lastUser = body.messages.findLastIndex((/** @type {any} */ m) => m.role === 'user');
    if (lastUser < 0) return fail(res, 400, 'invalid_request', 'no user message to answer');
    const earlier = renderTranscript(body.messages.slice(0, lastUser), 200000, 100000);
    const prompt = (earlier ? earlier + '\n\n' : '') + messageText(body.messages[lastUser]);
    const fns = (body.tools ?? []).filter((/** @type {any} */ t) => t?.type === 'function' && t.function?.name);
    const tc = body.tool_choice;
    const forced = (tc === 'required' || tc?.type === 'function') && fns.length === 1 ? fns[0].function : null;
    const schema = forced?.parameters;
    if (schema !== undefined && (typeof schema !== 'object' || schema === null || Array.isArray(schema) || JSON.stringify(schema).length > 65536)) {
      throw new ConfigError('function.parameters must be a JSON schema object of at most 64KB');
    }

    const result = await withTempDir(async (_dir, write) => {
      const side = await backend.side({ model, system, prompt, schema, write });
      return collect(run(side.args, side.stdin, signal).events, backend.classify);
    });
    if (!result) throw backend.classify({});

    const usage = { prompt_tokens: sumInput(result.usage), completion_tokens: result.usage.outputTokens,
      total_tokens: sumInput(result.usage) + result.usage.outputTokens };
    let message, finish = 'stop';
    if (forced) {
      let args;
      try { args = JSON.stringify(backend.sideJson(result)); }
      catch { throw backend.invalidJsonError(); }
      message = { role: 'assistant', content: null,
        tool_calls: [{ id: 'call_' + randomBytes(8).toString('hex'), type: 'function', function: { name: forced.name, arguments: args } }] };
      finish = 'tool_calls';
    } else {
      message = { role: 'assistant', content: result.text };
    }
    sendJson(res, 200, { id: 'chatcmpl-' + randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage, ...backend.finalExtra(result) });
  }

  async function mainTurn(/** @type {any} */ body, /** @type {string} */ model, /** @type {import('node:http').ServerResponse} */ res, /** @type {{signal: AbortSignal, timedOut: () => boolean}} */ { signal, timedOut }) {
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
        /** @type {Record<string, any>} */ let mcpServers = {};
        if (backend.mcp && cfg.mcp !== false) {
          const loaded = loadQwenMcpServers({ cwd: cfg.cwd, home: cfg.home, projectMcp: cfg.projectMcp === true });
          const conv = toClaudeMcpConfig(loaded.servers);
          for (const w of [...loaded.warnings, ...conv.warnings]) console.error(`[qcr] ${w}`);
          mcpServers = conv.config.mcpServers;
          for (const n of conv.trustedNames) allowedTools.push(`mcp__${n}__*`);
        }
        if (backend.mcp && cfg.skills !== false) {
          if ('qwen-skills' in mcpServers) {
            console.error('[qcr] MCP server name "qwen-skills" is reserved; ignoring yours');
            allowedTools.splice(0, allowedTools.length, ...allowedTools.filter((t) => t !== 'mcp__qwen-skills__*'));
          }
          mcpServers['qwen-skills'] = { type: 'stdio', command: process.execPath, args: [QCR_BIN, 'mcp-skills', '--cwd', cfg.cwd] };
          allowedTools.push('mcp__qwen-skills__*');
        }
        if (Object.keys(mcpServers).length) mcpConfigPath = await write('mcp.json', JSON.stringify({ mcpServers }));
        let resumeId = sid;
        for (;;) {
          const args = backend.mainArgs({ model, resume: resumeId, mcpConfigPath, allowedTools });
          try {
            return await runTurn(args, resumeId ? resumedPrompt : freshPrompt);
          } catch (err) {
            if (!(resumeId && backend.isSessionNotFound(err) && !emitted)) throw err;
            cfg.sessions.delete(fp);
            resumeId = undefined;
          }
        }
      });
      // Temp files are gone before the client sees the end of the stream.
      if (result.sessionId) cfg.sessions.set(fingerprint([...body.messages, { role: 'assistant', content: emitted }]), result.sessionId);
      finish(finalUsage, backend.finalExtra(result));
      return code;
    } catch (e) {
      if (signal.aborted && !timedOut()) { res.end(); return 'aborted'; }
      const err = timedOut() ? timeoutError() : e;
      if (!committed) { cleanup(); return sendError(res, err, backend); }
      code = err instanceof BackendError ? err.code : backend.failCode;
      content(errorLine(redact(/** @type {any} */ (err)?.message ?? 'error')));
      finish(null, {});
      return code;
    } finally {
      cleanup();
    }

    /** @param {string[]} args @param {string} prompt */
    async function runTurn(args, prompt) {
      let ctx = null;
      let resetsAt = null;
      let rejected = false;
      /** @type {any} */ let result = null;
      for await (const ev of run(args, backend.stdin(prompt), signal).events) {
        switch (ev.type) {
          case 'init': commit(); break;
          case 'text': content(ev.text); break;
          case 'tool_start': if (toolProgress === 'content') content(toolStartLine(ev.name, ev.summary)); break;
          case 'tool_end': if (toolProgress === 'content' && ev.isError) content(toolFailedLine(ev.name)); break;
          case 'notice': if (toolProgress === 'content') content(noticeLine(ev.text)); break;
          case 'context_usage': ctx = ev; break;
          case 'rate_limit': resetsAt = ev.resetsAt; rejected = ev.status === 'rejected'; break;
          case 'result': result = ev; break;
        }
      }
      if (!result) throw backend.classify({});
      if (result.isError) throw backend.classify({ result, resetsAt, rejected });
      const names = [...new Set(result.permissionDenials.map((/** @type {any} */ d) => d.tool_name).filter(Boolean))];
      if (names.length) content(backend.deniedLine(/** @type {string[]} */ (names)));
      if (cfg.footer !== false) content(backend.footer(result));
      const u = result.usage;
      const prompt_tokens = ctx ? ctx.inputTokens : sumInput(u);
      finalUsage = { prompt_tokens, completion_tokens: u.outputTokens, total_tokens: prompt_tokens + u.outputTokens,
        prompt_tokens_details: { cached_tokens: ctx ? ctx.cachedTokens : u.cacheReadTokens } };
      return result;
    }

    /** @param {object|null} usage @param {object} extra non-standard fields from the backend (e.g. cost) */
    function finish(usage, extra) {
      commit();
      cleanup();
      const last = chunk({ id, model: body.model, delta: {}, finishReason: 'stop', usage: usage ?? undefined });
      send(usage ? { ...last, ...extra } : last);
      if (!res.writableEnded) res.end('data: [DONE]\n\n');
    }
  }

  return { handleChatCompletion, models: backend.models };
}
