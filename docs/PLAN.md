# PLAN — Claude Code as a switchable runtime for Qwen Code

Status: revised after spec review (see "Spec review outcome" at the end).
Upstream studied: QwenLM/qwen-code @ `7cbb993` (2026-10-11), Claude Code CLI 2.1.x,
OpenClaw `claude-cli` backend (MIT, © OpenClaw Foundation) — design ideas reused and credited below.

## 1. User story and success criteria

In a running Qwen Code session the user types `/model claude-code/sonnet`, keeps chatting, and that
turn is executed by **their locally installed official `claude` binary** (their own login). Claude
runs its own tools. Switching back to a Qwen model keeps working.

MVP is done when all of these are verifiable:

| # | Criterion | How verified |
|---|-----------|--------------|
| S1 | A streamed text turn from `claude -p --output-format stream-json` arrives as OpenAI SSE `delta.content` chunks | integration test with fake `claude` + recorded fixture |
| S2 | Claude's tool use (start, result, error) is rendered as progress lines; Qwen never receives `tool_calls` (so it never re-executes them) | unit + integration test |
| S3 | Usage (input/output/cached tokens) is returned in the final chunk; cost (`total_cost_usd`) is shown | integration test |
| S4 | Turn N+1 of the same conversation runs `claude --resume <session_id from turn N>` | integration test inspects fake-claude argv log |
| S5 | Qwen `mcpServers` (user + project settings) are passed to `claude --mcp-config <0600 temp file>` | unit test of the converter + argv test |
| S6 | Clear errors: `claude` not installed, not logged in, rate-limited, unknown model, process crash | unit tests of the classifier + integration tests |
| S7 | Default permission mode is `default`; `bypassPermissions` / `--dangerously-skip-permissions` are never sent | unit test of argv builder |
| S8 | No credential handling: we spawn `claude` only, never read `~/.claude*` credential files, never call `api.anthropic.com` | code review + grep test |
| S9 | Manual e2e on a real machine with real Qwen Code + real `claude` | `docs/E2E.md` checklist |

## 2. What qwen-code offers (findings)

* `ContentGenerator` (`packages/core/src/core/contentGenerator.ts`) is built by a **closed if/else on
  `AuthType`** (`openai`, `openai-responses`, `qwen-oauth`, `gemini`, `vertex-ai`, `anthropic`).
  There is no plugin slot.
* The extension system (`qwen-extension.json`) can contribute `mcpServers`, context files, commands,
  skills, agents, hooks — **not** content generators/providers.
* Models are configured via `settings.json → modelProviders.<provider>[] = {id, baseUrl, envKey, ...}`.
  The `id` is free text, so `claude-code/sonnet` is a legal model id for the `openai` provider and
  `/model claude-code/sonnet` selects it. Switching rebuilds the generator via `refreshAuth`.
* The OpenAI pipeline always streams chat completions with `stream_options.include_usage`, maps
  `delta.content` → text, `delta.reasoning_content` → thought parts, and `usage` → `usageMetadata`
  (shown in footer and `/stats`, priced via `modelPricing`). Any `tool_calls` it receives are
  **executed locally by Qwen**.
* Qwen already runs Claude Code as an *ACP subagent* (`claude-agent-acp`), not as the main model.
* Qwen does not send a session id to non-OpenAI endpoints (`prompt_cache_key` only for api.openai.com).
* MCP config: `~/.qwen/settings.json` and `<project>/.qwen/settings.json` → `mcpServers`
  (`command/args/env/cwd`, `url` (SSE), `httpUrl` (streamable HTTP), `headers`, `includeTools`,
  `excludeTools`, `trust`, `timeout`). Context files: `QWEN.md` / `AGENTS.md`. Skills: `.qwen/skills/`,
  `~/.qwen/skills/`.

## 3. Options

| | (a) Extension | (b) Patch: new `ContentGenerator` | (c) Local OpenAI-compatible shim |
|---|---|---|---|
| Feasible today | **No** — no generator slot | Yes, ~5 files + 1 new dir | Yes, zero upstream change |
| Works with released `qwen` | – | Only with a patched build | **Yes** |
| Fidelity | – | Best: native thought parts, no HTTP hop | Good: text, `reasoning_content`, usage |
| Maintenance | – | Rebase a patch series against a fast-moving repo (`config.ts` is 7.5k lines) | Depends only on the stable OpenAI wire format |
| Tool calls | – | Never emit `functionCall` parts | Never emit `tool_calls` |
| Risk | – | Upstream churn | A local HTTP port that can run an agent → must be authenticated |

### Recommendation: (c) shim for the MVP, built on a transport-agnostic core that (b) can reuse later

The core (`src/runtime/`) knows nothing about HTTP: it builds argv, spawns `claude`, parses stream-json
into normalized events, classifies errors and tracks sessions. The shim (`src/server/`) maps those
events to OpenAI SSE. A later qwen-code patch (milestone M5) would import the same core and map the
same events to `GenerateContentResponse` parts. That gives users something that works with stock
`qwen` now, and keeps the door open for a native integration.

## 4. Design (MVP)

```
qwen (stock) ──OpenAI chat.completions (SSE)──▶ qcr shim 127.0.0.1:PORT ──spawn (no shell)──▶ claude -p … 
   ▲  model id "claude-code/<alias>"             │ bearer token + Host check                 │ stream-json stdin/stdout
   └──────────── delta.content / reasoning / usage ◀── event mapper ◀── stream-json parser ◀──┘
```

### 4.1 Process invocation (core)
`claude` is resolved from `PATH` (or `QCR_CLAUDE_BIN`) and spawned with `child_process.spawn(bin, args,
{shell:false})`. The prompt is **never** put in argv — it goes over stdin as one stream-json user message,
which removes the whole argument-injection class for user text.

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
       --model <alias> --permission-mode <default|acceptEdits|plan>
       [--resume <uuid>] [--mcp-config <tmpfile>] [--append-system-prompt <QWEN.md text>]
       [--allowedTools <from config>] [--add-dir <dir>...]
```
* `<alias>` comes from the model id suffix after `claude-code/` and must match `^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}$`.
* `--resume` value must be a UUID.
* `--permission-mode` is from an allowlist; `bypassPermissions` is rejected, and argv is asserted to never
  contain `--dangerously-skip-permissions`. In `-p` mode no one can answer a permission prompt, so with
  `default` mode tools that need approval are denied; denials from `result.permission_denials` are shown to the
  user with a hint (`QCR_PERMISSION_MODE=acceptEdits` or `--allowedTools`).
* Environment: inherited, minus `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`
  (so a key exported for Qwen's own `anthropic` provider does not silently switch `claude` from the user's
  subscription to metered API billing — idea from OpenClaw's `CLAUDE_CLI_CLEAR_ENV`), and minus the shim's
  own `QCR_TOKEN`. Opt-out: `QCR_KEEP_ANTHROPIC_ENV=1`.
* Abort: client disconnect → `SIGTERM`, then `SIGKILL` after 3 s.

### 4.2 Stream-json → events (core)
| stream-json | normalized event |
|---|---|
| `system/init` | `init {sessionId, model, tools}` |
| `stream_event content_block_delta text_delta` | `text` |
| `stream_event content_block_delta thinking_delta` | `thinking` |
| `assistant` message `tool_use` block | `tool_start {id, name, summary}` (summary = short input digest, e.g. file path / command, truncated) |
| `user` message `tool_result` block | `tool_end {id, name, isError}` |
| `rate_limit_event` with `status != allowed` | `rate_limit {resetsAt}` |
| `result` | `result {isError, subtype, text, sessionId, costUsd, usage, numTurns, permissionDenials}` |
| events with `parent_tool_use_id != null` | ignored for text (subagent chatter), still counted |
| unknown types / non-JSON stdout lines | ignored (logged at debug, truncated) |

If no `text_delta` was seen (partial messages missing), the text of `assistant` messages is used instead,
so text is never lost or duplicated.

### 4.3 Events → OpenAI SSE (shim)
* `text` → `delta.content`. `thinking` → `delta.reasoning_content` (Qwen shows it as a thought).
* `tool_start` / `tool_end` → `delta.content` progress lines, e.g. `\n> ⚙ Read · src/a.ts\n`,
  `> ✗ Bash failed`. Content (not reasoning) is chosen because it is always visible; configurable via
  `QCR_TOOL_PROGRESS=content|reasoning|off`.
* `result` → optional footer `_claude-code · 2 turns · $0.0029_`, then a chunk with `finish_reason:"stop"`
  and `usage {prompt_tokens = input+cache_read+cache_creation, completion_tokens, total_tokens,
  prompt_tokens_details.cached_tokens}`.
* **No `tool_calls` are ever emitted on streaming (main) turns.** Qwen's `tools` array and system prompt are ignored for main turns
  (Claude Code has its own tool set and system prompt).
* Errors: the SSE response is **not committed** until the first visible output. An error before that
  returns a proper HTTP error with an OpenAI-shaped body (`claude` missing → 503, not logged in → 401,
  rate limit → 429 with reset time, bad request/model → 400, other → 502). After commit, the error is
  written as a visible `⚠` content line and the stream finishes normally.

### 4.4 Conversation continuity
Qwen sends the full message history every turn and no session id. The shim keeps an in-memory map
`fingerprint(history up to and including the last assistant message) → claude session_id`, where the
fingerprint is a SHA-256 of normalized `role + text` of user/assistant messages (system and tool messages
excluded). After a successful turn it stores `fp(history + this user msg + produced text) → session_id`.
* Hit → `--resume <id>` with only the new user message(s).
* Miss (first Claude turn, switch from a Qwen model, Qwen compressed history, shim restarted) → fresh
  claude session; the prior history is rendered as a bounded transcript (last ~40 KB) prepended to the
  prompt as context. This also gives continuity when the user switches *from* Qwen *to* Claude.
* Per-session mutex: concurrent requests for the same session are serialized.
* `stream !== true` requests (Qwen side queries: titles, summaries, JSON checks) run as one-shot calls:
  `--tools ""`, `--no-session-persistence`, Qwen's system prompt passed via `--system-prompt`, no resume.
  Qwen's `BaseLlmClient.generateJson` forces a single function `respond_in_schema`
  (`baseLlmClient.ts:500-560`). When a side query carries exactly one function tool, the shim passes its
  parameter schema to `claude --json-schema` (or, if unavailable, instructs "reply with JSON only") and returns
  the parsed JSON as a `tool_calls` entry for **that** function. This is the only case a `tool_calls` is
  emitted: it is pure data consumed by `generateJson`, never a tool for Qwen's scheduler to run.

### 4.5 Qwen MCP / context passthrough
* `mcpServers` from `~/.qwen/settings.json` and `<cwd>/.qwen/settings.json` (project wins) →
  Claude `--mcp-config` JSON: stdio (`command,args,env,cwd`), `httpUrl` → `{type:"http"}`, `url` →
  `{type:"sse"}`, `headers` copied. `includeTools`/`excludeTools` → TODO (logged as unsupported).
  Written to a `0600` file in a `0700` `mkdtemp` dir, deleted after the turn. Settings JSON is parsed
  as JSON-with-comments tolerantly; parse failures are warnings, not fatal. Opt-out: `QCR_MCP=off`.
* `QWEN.md` (project root + `~/.qwen/QWEN.md`) → `--append-system-prompt` (size-capped 32 KB).
* Skills/`--add-dir`: post-MVP (M4).

### 4.6 Shim hardening
* Binds `127.0.0.1` only. Requires `Authorization: Bearer <token>`; the token comes from `QCR_TOKEN` or is
  generated at first start into `~/.config/qwen-claude-runtime/token` (0600). Constant-time compare.
* Rejects requests whose `Host` is not `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding) and any
  non-`application/json` body (CSRF via simple forms). Body size cap 8 MB. No CORS headers.
* Logs never contain prompt text, tokens, env, or MCP headers/env; stderr of `claude` is truncated and
  scrubbed of `sk-ant-`-like strings before being surfaced.
* Working directory for `claude` = the shim's cwd (start the shim in your project), override `QCR_CWD`.

### 4.7 Credentials policy (hard constraint)
We only ever spawn the official `claude` binary and let it use its own login. We never read, copy,
proxy, or extract Claude OAuth tokens/credentials, never read `~/.claude/.credentials.json` or the
keychain, and never call `api.anthropic.com`. Stated in README and SECURITY.md; enforced by a test that
greps `src/` for `api.anthropic.com`, `.credentials`, `oauth` token file paths.

## 5. Assumptions (explicit)
1. `claude` ≥ 2.1 supports `-p --input-format stream-json --output-format stream-json --verbose
   --include-partial-messages --resume --mcp-config --permission-mode --append-system-prompt`.
   Verified against 2.1.296 in this sandbox (recorded fixture `test/fixtures/tool-turn.jsonl`).
2. Qwen Code treats `modelProviders.openai[].id = "claude-code/sonnet"` as an opaque model id sent verbatim.
3. Qwen re-sends the assistant text we produced verbatim (modulo whitespace) in later requests; if it does
   not, continuity degrades gracefully to the transcript fallback (never to wrong-session resume).
4. Side queries use `stream:false`. If Qwen streams a side query, it runs as a normal (resumable-less)
   turn because its history fingerprint will not match — costlier, but correct.

## 6. Failure modes considered
* Resume of a session that `claude` no longer has → `result error_during_execution` "No conversation
  found" → drop mapping, retry once fresh with transcript.
* Shim killed mid-turn → child killed by abort handler; no orphan. Orphans on `SIGKILL` of the shim are
  possible (documented).
* Huge histories → transcript capped; stdin write handles backpressure.
* Two Qwen windows on one shim → different fingerprints, independent sessions; same history in both →
  serialized by the mutex.
* `claude` prints non-JSON (e.g. `[claude-code:unrecognized_model]`) → ignored line, error comes from `result`.

## 7. Milestones
* **M0** PLAN + spec review (this doc).
* **M1 vertical slice**: core spawn/parse + shim streaming text turn + fake-claude integration test. (S1, S7, S8)
* **M2** tool progress, usage/cost, error classification + HTTP mapping. (S2, S3, S6)
* **M3** session resume + transcript fallback + mutex; MCP + QWEN.md passthrough. (S4, S5)
* **M4** docs: README quickstart, SECURITY.md, E2E checklist, review record. (S9)
* **Post-MVP**: skills via `--add-dir`/`--plugin-dir`; serving Qwen-side tools to Claude through a small
  MCP server (OpenClaw-style loopback MCP); `includeTools`; launcher `qcr qwen` that starts shim + qwen;
  **M5** optional qwen-code patch series adding `AuthType 'claude-code'` that reuses `src/runtime/`.

## 8. Non-goals (MVP)
Interactive permission prompts relayed into Qwen's UI; images/attachments; multiple concurrent turns
in one session; Windows-specific path handling beyond what Node provides.

## 9. Spec review outcome
See `docs/REVIEW.md` §1 for the reviewer's findings and how this plan changed.
