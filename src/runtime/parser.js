// @ts-check
/** @typedef {{type: string, [k: string]: any}} Event */

/** Single-line digest of a tool input, max 80 chars. @param {any} input */
function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['file_path', 'path', 'pattern', 'command', 'url', 'description']) {
    if (typeof input[k] === 'string' && input[k]) {
      const s = input[k].replace(/\s+/g, ' ').trim();
      return s.length > 80 ? s.slice(0, 79) + '…' : s;
    }
  }
  return '';
}

/** Incremental parser for `claude --output-format stream-json` lines. */
export function createStreamParser() {
  /** @type {Map<string,string>} */ const toolNames = new Map();
  /** @type {Set<string>} */ const deltaMsgs = new Set();
  /** @type {Set<string>} */ const fallbackSeen = new Set();
  let currentMsg = '';

  return {
    /** @param {string} line @returns {Event[]} */
    push(line) {
      let o;
      try { o = JSON.parse(line); } catch { return []; }
      if (!o || typeof o !== 'object' || o.parent_tool_use_id != null) return [];
      /** @type {Event[]} */ const out = [];
      switch (o.type) {
        case 'system':
          if (o.subtype === 'init') out.push({ type: 'init', sessionId: o.session_id, model: o.model, tools: o.tools ?? [] });
          break;
        case 'stream_event': {
          const e = o.event ?? {};
          if (e.type === 'message_start') {
            currentMsg = e.message?.id ?? '';
            usage(e.message?.usage);
          } else if (e.type === 'message_delta') {
            usage(e.usage);
          } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
            if (currentMsg) deltaMsgs.add(currentMsg);
            out.push({ type: 'text', text: e.delta.text });
          }
          break;
        }
        case 'assistant': {
          const id = o.message?.id ?? '';
          for (const b of o.message?.content ?? []) {
            if (b.type === 'text' && b.text && !deltaMsgs.has(id)) {
              const key = id + '\0' + b.text;
              if (!fallbackSeen.has(key)) { fallbackSeen.add(key); out.push({ type: 'text', text: b.text }); }
            } else if (b.type === 'tool_use' && b.name !== 'StructuredOutput' && !toolNames.has(b.id)) {
              toolNames.set(b.id, b.name);
              out.push({ type: 'tool_start', id: b.id, name: b.name, summary: summarize(b.input) });
            }
          }
          break;
        }
        case 'user':
          if (Array.isArray(o.message?.content)) {
            for (const b of o.message.content) {
              if (b.type === 'tool_result' && toolNames.has(b.tool_use_id)) {
                out.push({ type: 'tool_end', id: b.tool_use_id, name: toolNames.get(b.tool_use_id), isError: b.is_error === true });
              }
            }
          }
          break;
        case 'rate_limit_event':
          if (o.rate_limit_info && o.rate_limit_info.status !== 'allowed') {
            out.push({ type: 'rate_limit', status: o.rate_limit_info.status, resetsAt: o.rate_limit_info.resetsAt ?? null });
          }
          break;
        case 'result': {
          const u = o.usage ?? {};
          const text = o.result ?? (Array.isArray(o.errors) ? o.errors.join('\n') : '');
          out.push({
            type: 'result',
            isError: o.is_error === true || String(o.subtype ?? '').startsWith('error'),
            subtype: o.subtype,
            text: typeof text === 'string' ? text : '',
            sessionId: o.session_id,
            costUsd: o.total_cost_usd ?? 0,
            usage: {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
            },
            numTurns: o.num_turns ?? 0,
            permissionDenials: Array.isArray(o.permission_denials) ? o.permission_denials : [],
            structuredOutput: o.structured_output,
            apiErrorStatus: o.api_error_status ?? null,
            terminalReason: o.terminal_reason,
          });
          break;
        }
      }
      return out;

      /** @param {any} u */
      function usage(u) {
        if (!u) return;
        const cached = u.cache_read_input_tokens ?? 0;
        out.push({
          type: 'context_usage',
          inputTokens: (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0),
          cachedTokens: cached,
        });
      }
    },
  };
}
