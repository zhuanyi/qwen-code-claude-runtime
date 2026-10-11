# PLAN — Claude Code as a switchable runtime for Qwen Code

Status: **revised after adversarial spec review** (findings in `docs/REVIEW.md` §1; changes marked ⟲).
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
| S5 | Qwen `mcpServers` (user + project settings) are passed to `claude --mcp-config <0600 temp file>`; servers Qwen marks `trust:true` are pre-allowed via `--allowedTools mcp__<name>__*` | unit test of the converter + argv test |
| S6 | Clear errors: `claude` not installed, not logged in, rate-limited, unknown model, process crash | unit tests of the classifier + integration tests |
| S7 | Default permission mode is `manual` (⟲ `default` is only a hidden alias in 2.1.x) with `--permission-prompts none`; `bypassPermissions` / `--dangerously-skip-permissions` are never sent | unit test of argv builder |
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
       --model <alias> --permission-mode <manual|acceptEdits|plan> --permission-prompts none
       [--resume <uuid> --fork-session] [--mcp-config <tmpfile>] [--allowedTools mcp__<trusted>__* ...]
side query: --tools "" --no-session-persistence --system-prompt-file <tmpfile> [--json-schema <schema>]
```
* `<alias>` comes from the model id suffix after `claude-code/` and must match `^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}$`.
* `--resume` value must be a UUID.
* `--permission-mode` is from an allowlist (`manual` default, `acceptEdits`, `plan`); `bypassPermissions`, `auto` and `dontAsk` are rejected, and argv is asserted to never
  contain `--dangerously-skip-permissions`. In `-p` mode no one can answer a permission prompt, so with
  `default` mode tools that need approval are auto-denied (`--permission-prompts none`); denials from `result.permission_denials` are shown to the
  user with a hint (`QCR_PERMISSION_MODE=acceptEdits` or `--allowedTools`).
* Environment: inherited, minus `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`
  (so a key exported for Qwen's own `anthropic` provider does not silently switch `claude` from the user's
  subscription to metered API billing — idea from OpenClaw's `CLAUDE_CLI_CLEAR_ENV`), and minus the shim's
  own `QCR_TOKEN`. Opt-out: `QCR_KEEP_ANTHROPIC_ENV=1`.
* Abort: client disconnect → `SIGTERM`, then `SIGKILL` after 3 s.
* ⟲ `result` is not the last stdout line (a `system/task_summary` follows). The turn ends on `result`; the
  process gets a 3 s grace period, then `SIGTERM`.
* ⟲ Large text (system prompt for side queries) goes through `--system-prompt-file` in the 0600 temp dir,
  never argv (visible in `ps`, 128 KiB per-arg limit).

### 4.2 Stream-json → events (core)
| stream-json | normalized event |
|---|---|
| `system/init` | `init {sessionId, model, tools}` |
| `stream_event content_block_delta text_delta` | `text` |
| `stream_event content_block_delta thinking_delta` | ⟲ dropped in MVP (2.1.x streams empty thinking text) |
| `stream_event message_start` / `message_delta` (top level) | ⟲ `context_usage` — the *last* request's input size |
| `assistant` message `tool_use` block | `tool_start {id, name, summary}` (summary = short input digest, e.g. file path / command, truncated) |
| `user` message `tool_result` block | `tool_end {id, name, isError}` |
| `rate_limit_event` with `status != allowed` | `rate_limit {resetsAt}` |
| `result` | `result {isError, subtype, text, sessionId, costUsd, usage, numTurns, permissionDenials}` |
| events with `parent_tool_use_id != null` | ignored for text (subagent chatter), still counted |
| unknown types / non-JSON stdout lines | ignored (logged at debug, truncated) |

If no `text_delta` was seen (partial messages missing), the text of `assistant` messages is used instead,
so text is never lost or duplicated.

### 4.3 Events → OpenAI SSE (shim)
* ⟲ The 200 SSE response is committed as soon as `system/init` arrives (or after 2 s), and an empty
  `delta:{content:""}` chunk is sent every 15 s as keepalive. Qwen's OpenAI client has a 120 s
  time-to-first-byte timeout and a 240 s stream-idle timeout (`openaiContentGenerator/constants.ts`); a
  long Bash call must not trip them and cause Qwen to retry (which would kill and re-run the turn).
* `text` → `delta.content`.
* `tool_start` / `tool_end` → `delta.content` progress lines, e.g. `\n> ⚙ Read · src/a.ts\n`,
  `> ✗ Bash failed`. Content (not reasoning) is chosen because it is always visible; configurable via
  `QCR_TOOL_PROGRESS=content|reasoning|off`.
* `result` → optional footer `_claude-code · 2 turns · $0.0029_`, then a chunk with `finish_reason:"stop"`
  and `usage`. ⟲ `prompt_tokens` = input+cache_read+cache_creation of the **last** top-level API request
  (Qwen treats it as the current context size; the cumulative `result.usage` over N internal calls would
  trigger Qwen auto-compression after nearly every turn). `completion_tokens` = cumulative output.
  Cost uses the cumulative `total_cost_usd`.
* **No `tool_calls` are ever emitted on streaming (main) turns.** Qwen's `tools` array and system prompt are ignored for main turns
  (Claude Code has its own tool set and system prompt).
* Errors: the SSE response is **not committed** until the first visible output. An error before that
  returns a proper HTTP error with an OpenAI-shaped body and ⟲ `x-should-retry: false` (Qwen retries
  429/5xx up to 7×, then up to 10× more with minute-scale back-off): `claude` missing → 503, Claude not
  logged in → 401 with code `claude_not_logged_in` (distinct from the shim's own `invalid_shim_token`),
  rate limit → 429 worded `Claude quota exhausted; will reset at <time>` (matches Qwen's fail-fast quota
  detector), bad request/model → 400, other → 502. Because headers are now committed on `init`, most
  `claude`-side errors arrive after commit: they are written as a visible `⚠` content line and the
  stream finishes normally.

### 4.4 Conversation continuity
Qwen sends the full message history every turn and no session id. The shim keeps an in-memory map
`fingerprint(history up to and including the last assistant message) → claude session_id`, where the
fingerprint is a SHA-256 of normalized `role + text` of user/assistant messages (system and tool messages
excluded). After a successful turn it stores `fp(history + this user msg + produced text) → session_id`.
* Hit → ⟲ `--resume <id> --fork-session` with only the new user message(s); the *new* session id is
  stored under the new fingerprint. Sessions are never mutated in place, so a Qwen side request that
  replays the same history prefix (compression, forked auto-memory agents — both stream) only creates a dead
  branch and cannot pollute the user's conversation. No mutex is needed.
* ⟲ The fingerprint hashes exactly what the shim emitted (progress lines, footer and ⚠ lines included).
  `<system-reminder>…</system-reminder>` blocks that Qwen prepends to user messages are stripped before
  hashing and before forwarding on resumed turns (they describe Qwen-only tools/modes); they are kept,
  fenced, in the first turn of a fresh session because they carry the environment context.
* Miss (first Claude turn, switch from a Qwen model, Qwen compressed history, shim restarted) → fresh
  claude session; the prior history is rendered as a bounded transcript (last ~40 KB) prepended to the
  prompt as context, ⟲ fenced and labelled as quoted, untrusted prior conversation (it can contain tool
  output / web content from Qwen turns). This also gives continuity when the user switches *from* Qwen *to* Claude.
* `stream !== true` requests (Qwen side queries: titles, summaries, JSON checks) run as one-shot calls:
  `--tools ""`, `--no-session-persistence`, Qwen's system prompt passed via `--system-prompt`, no resume.
  Qwen's `BaseLlmClient.generateJson` forces a single function `respond_in_schema`
  (`baseLlmClient.ts:500-560`, `tool_choice:"required"`). ⟲ When a side query has `tool_choice` required
  and exactly one function tool, the shim passes its
  parameter schema to `claude --json-schema` (verified: `result.structured_output`, fixture `side-query-json.jsonl`) and returns
  that JSON as a `tool_calls` entry for **that** function. This is the only case a `tool_calls` is
  emitted: it is pure data consumed by `generateJson`, never a tool for Qwen's scheduler to run.

### 4.5 Qwen MCP / context passthrough
* `mcpServers` from `~/.qwen/settings.json` and `<cwd>/.qwen/settings.json` (project wins) →
  Claude `--mcp-config` JSON: stdio (`command,args,env,cwd`), `httpUrl` → `{type:"http"}`, `url` →
  `{type:"sse"}`, `headers` copied. `includeTools`/`excludeTools` → TODO (logged as unsupported).
  ⟲ In `-p` mode with `manual` permissions MCP tools would be auto-denied, so servers that Qwen marks
  `trust: true` are pre-allowed with `--allowedTools mcp__<name>__*` (names validated `^[A-Za-z0-9_-]+$`);
  untrusted ones are passed, but their tools stay denied unless allowed in the user's Claude settings or
  via `QCR_ALLOWED_TOOLS` (comma list, each entry validated).
  Written to a `0600` file in a `0700` `mkdtemp` dir, deleted after the turn. Settings JSON is parsed
  as JSON-with-comments tolerantly; parse failures are warnings, not fatal. Opt-out: `QCR_MCP=off`.
* ⟲ `QWEN.md`: **not** separately passed — Qwen already embeds context files in its startup
  `<system-reminder>`, which reaches Claude in the first turn of a fresh session.
* Skills/`--add-dir`: post-MVP.

### 4.6 Shim hardening
* Binds `127.0.0.1` only. Requires `Authorization: Bearer <token>`; the token comes from `QCR_TOKEN` or is
  generated at first start into `~/.config/qwen-claude-runtime/token` (0600). Constant-time compare.
* Rejects requests whose `Host` is not `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding) and any
  non-`application/json` body (CSRF via simple forms). Body size cap 8 MB. No CORS headers.
* Logs never contain prompt text, tokens, env, or MCP headers/env; stderr of `claude` is truncated and
  scrubbed of `sk-ant-`-like strings before being surfaced.
* Working directory for `claude` = the shim's cwd (start the shim in your project), override `QCR_CWD`.
  ⟲ Qwen states its directory in the startup context (`I'm currently working in the directory: <dir>`,
  `core/environmentContext.ts:74`). If present and it differs from the shim's cwd, the request is refused
  with a clear error, so Claude never edits the wrong project.

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
4. ⟲ Some Qwen side work streams (chat compression, forked auto-memory agents, follow-up suggestions).
   These run as normal Claude turns (fork-session keeps them harmless). The README tells users to set
   `fastModel` to a Qwen model and to disable auto-memory / follow-up suggestions while using Claude, and to
   set `QWEN_STREAM_MAX_LIFETIME_MS` / provider `timeout` for very long turns.
5. ⟲ Separate Qwen sessions with identical history (e.g. same first prompt) map to the same fingerprint;
   with fork-session this is safe (each forks). A per-session header via Qwen's `${session_id}` dynamic
   header is post-MVP.

## 6. Failure modes considered
* Resume of a session that `claude` no longer has → `result error_during_execution` "No conversation
  found" → drop mapping, retry once fresh with transcript.
* Shim killed mid-turn → child killed by abort handler; no orphan. Orphans on `SIGKILL` of the shim are
  possible (documented).
* Huge histories → transcript capped; stdin write handles backpressure.
* Two Qwen windows on one shim → each request forks its own branch; no shared mutable state but the
  fingerprint map (single-threaded JS, bounded LRU 1000 entries).
* `claude` prints non-JSON (e.g. `[claude-code:unrecognized_model]`) → ignored line, error comes from `result`.

## 7. Milestones
* **M0** PLAN + spec review (this doc).
* **M1 vertical slice**: core spawn/parse + shim streaming text turn + fake-claude integration test. (S1, S7, S8)
* **M2** tool progress, usage/cost, error classification + HTTP mapping. (S2, S3, S6)
* **M3** session resume (fork) + transcript fallback; MCP passthrough. (S4, S5)
* **M4** docs: README quickstart, SECURITY.md, E2E checklist, review record. (S9)
* **Post-MVP**: skills via `--add-dir`/`--plugin-dir`; serving Qwen-side tools to Claude through a small
  MCP server (OpenClaw-style loopback MCP); `includeTools`; launcher `qcr qwen` that starts shim + qwen;
  **M5** optional qwen-code patch series adding `AuthType 'claude-code'` that reuses `src/runtime/`.

## 8. Non-goals (MVP)
Interactive permission prompts relayed into Qwen's UI; images/attachments; multiple concurrent turns
in one session; Windows-specific path handling beyond what Node provides.

## 9. Spec review outcome
Approve-with-changes; 2 blockers (timeouts, streamed side requests polluting sessions) and 4 majors
(cumulative usage, 429 retry storms, wrong cwd, forwarded Qwen reminders) were folded in above (⟲).
Full list and dispositions: `docs/REVIEW.md` §1.

## 10. M6 — Qwen skills for Claude via a local MCP server

Goal: skills the user installed for Qwen Code become usable by Claude when a turn runs on `claude-code/*`.

Findings (qwen-code @ `7cbb993`, `core/src/skills/`): a skill is a directory containing `SKILL.md`, which has YAML
frontmatter (`name`, `description`, optional `disable-model-invocation`, `allowed-tools`, …) and a Markdown
body. This is the same shape as a Claude skill. Discovery order (first wins): project `.qwen/skills`, project
`.agents/skills`, user `~/.qwen/skills`, user `~/.agents/skills`, then extension skills, then bundled skills.

Design (smallest thing that works, following OpenClaw's approach of exposing host capabilities to Claude via MCP):
* `qcr mcp-skills --cwd <dir>` is a zero-dependency **stdio MCP server** that speaks newline-delimited
  JSON-RPC 2.0 (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`).
  It is **read-only** and does no network I/O.
* It exposes two tools:
  * `qwen_skill {name}` returns the skill body (frontmatter stripped), its absolute base directory, and a list
    of its supporting files. The tool *description* carries the index of available skills
    (`name: description`, capped at ~8 KB), so Claude knows when to call it. This mirrors Qwen's
    `<available_skills>` listing.
  * `qwen_skill_file {name, path}` reads a supporting file inside the skill directory. The resolved real path
    must stay inside the skill's real directory (no `..` and no symlink escape), files are capped at
    256 KB, and only text is returned.
* Skills with `disable-model-invocation: true` are not listed. Extension, bundled and custom skill dirs are
  out of scope for M6. Skill names are validated `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
* Wiring: unless `QCR_SKILLS=off`, the handler adds a reserved MCP server `qwen-skills` (stdio:
  `process.execPath <abs bin/qcr.js> mcp-skills --cwd <cwd>`) to the generated `--mcp-config` and pre-allows
  `mcp__qwen-skills__*`. These tools are read-only and come from this project. A user MCP server named
  `qwen-skills` is skipped with a warning.
* Scripts referenced by a skill are run by Claude's own Bash tool, using the returned base directory, so they
  are still subject to Claude's permission rules.

Trust: project skills are repository-provided instructions, at the same trust level as the `CLAUDE.md` and
`.claude/skills` that `claude` already loads from the project. They are included by default and documented in SECURITY.md.

Success criteria: (1) a unit test for discovery, precedence, frontmatter parsing and containment; (2) an MCP
protocol test that spawns `qcr mcp-skills` and exchanges `initialize` / `tools/list` / `tools/call`; (3) an
integration test showing the handler passes the `qwen-skills` server and `--allowedTools mcp__qwen-skills__*`;
(4) a one-off real `claude -p --mcp-config …` smoke test in which Claude loads a test skill.
