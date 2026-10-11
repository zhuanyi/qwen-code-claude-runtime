# Review record

## 1. Spec review of `docs/PLAN.md` (adversarial, independent reviewer subagent)

Verdict: **approve-with-changes**. All claims were checked against qwen-code @ `7cbb993` and a recorded
`claude` 2.1.296 stream. Disposition column: ✅ fixed in plan, ⚠ partially, ❌ rejected.

| # | Finding | Sev. | Disposition |
|---|---------|------|-------------|
| 1 | Qwen's OpenAI client: 120 s TTFB, 240 s idle, 15 min lifetime timeouts; holding headers until first output + silent tool runs ⇒ Qwen retries and kills/re-runs the turn | blocker | ✅ commit SSE on `init`/2 s, 15 s empty-delta keepalive, `x-should-retry:false`, documented env/`timeout` knobs |
| 2 | `stream:true` ≠ main turn (compression, forked auto-memory agents stream); they share the history prefix and would `--resume` and pollute the real session | blocker | ✅ always `--resume <id> --fork-session`; mutex removed; README recommends Qwen `fastModel` + disabling auto-memory/follow-ups |
| 3 | `result.usage` is cumulative over internal calls; Qwen treats `prompt_tokens` as context size ⇒ auto-compression every turn | major | ✅ `prompt_tokens` from last top-level request; cumulative only for cost |
| 4 | 429 ⇒ Qwen retry storm (7 + 10 attempts) on multi-hour Claude limits | major | ✅ quota wording that Qwen's detector fails fast on + `x-should-retry:false` |
| 5 | Shim cwd may differ from Qwen's project ⇒ Claude edits wrong tree | major | ✅ parse Qwen's working-directory line, refuse on mismatch |
| 6 | Qwen prepends `<system-reminder>` blocks naming Qwen-only tools/modes | major | ✅ stripped on resumed turns; kept fenced on fresh sessions (they carry env context) |
| 7 | Fingerprint fragile; Qwen can send `${session_id}` dynamic header | major | ⚠ fingerprint hashes exactly emitted text; fork-session makes collisions safe; header keying post-MVP |
| 8 | JSON side-query path unverified; detect via `tool_choice` | minor | ✅ fixture recorded (`structured_output`), detection on `tool_choice` + single function |
| 9 | Permission mode `default` is a hidden alias; use `manual` + `--permission-prompts none` | minor | ✅ |
| 10 | `result` is not the last stdout line | minor | ✅ end on `result`, 3 s grace then SIGTERM |
| 11 | Thinking deltas are empty in 2.1.x | minor | ✅ dropped from MVP |
| 12 | Large prompts in argv visible in `ps`, 128 KiB arg cap | minor | ✅ `--system-prompt-file` in 0600 temp dir |
| 13 | Transcript fallback injects untrusted prior output as user text; ambiguous 401 | minor | ✅ fenced/labelled transcript; distinct error codes |
| 14 | Over-built: QWEN.md passthrough duplicates Qwen's own context; MCP denied in `-p`; mutex | minor | ⚠ QWEN.md dropped, mutex dropped; **MCP kept** (explicit project requirement) with `trust:true` → `--allowedTools mcp__<name>__*` |
| 15 | Model id handling OK (200k default window, no images) | info | – |

## 2. Code review A — correctness, edge cases, concurrency (independent reviewer subagent)

Verdict: **approve-with-changes** (no high-severity findings; 42/42 tests passed at review time).

| # | Finding | Sev. | Disposition |
|---|---------|------|-------------|
| A1 | Transcript fallback stripped `<system-reminder>` blocks, losing Qwen's env context (cwd, QWEN.md) on a session miss | medium | ✅ fixed: reminders kept in the transcript (fenced); stripped only for fingerprinting and resumed prompts; first user message capped at 20 KB, not 2 KB |
| A2 | Error classification too loose: stderr `MCP server "gh": … rate limit exceeded` became a Claude quota error; `failed to authenticate` from an MCP server became `claude_not_logged_in`; "Context limit reached" became a rate limit | medium | ✅ fixed: structured signals first (`api_error_status`, `rate_limit_event` rejected), anchored Claude wording, MCP stderr lines ignored; tests added |
| A3 | Side queries put the actual question inside the "untrusted" fence | medium | ✅ fixed: only earlier messages are fenced; the last user message is the real prompt |
| A4 | Duplicate text when `message_start` lacks an id | low | ✅ fixed (`streamedCurrent` flag) |
| A5 | A `message_delta` with output-only usage reset the context size to 0 | low | ✅ fixed |
| A6 | Synthetic error message streamed and then repeated as a ⚠ line | low | ✅ fixed: `<synthetic>` assistant text skipped |
| A7 | Working-dir check gave false positives with a symlinked `QCR_CWD` | low | ✅ fixed: `realpath` comparison |
| A8 | 413 probably never delivered (socket destroyed first) | low | ✅ fixed: `connection: close`; test added |
| A9 | `QCR_PORT=''` → random port; invalid config only failed per request; `QCR_TOOL_PROGRESS=reasoning` silently mapped to `content` | low | ✅ fixed: validated at startup (`exit 2`); only `content`/`off` accepted |
| A10 | Possible hang when a grandchild keeps `claude`'s stdout open after exit | speculative | ✅ fixed: stdout treated as ended 2 s after `exit` |
| – | Test gaps: client abort kills the child; side-query system prompt content | – | ✅ tests added |

## 3. Code review B — security (independent reviewer subagent)

Hard requirements: only the official `claude` is spawned — **pass**; no credential access or Anthropic API calls —
**pass**; the default is never bypassPermissions and the dangerous flags are unreachable — **pass**; no secrets in
logs — **pass** for logs (client error bodies could leak secrets, see B2).

| # | Finding | Sev. | Disposition |
|---|---------|------|-------------|
| B1 | A cloned repo's `.qwen/settings.json` MCP servers were passed to `claude --mcp-config` (trusted, started without asking) ⇒ arbitrary command execution; project `trust:true` auto-allowed their tools | high | ✅ fixed: project MCP only with `QCR_PROJECT_MCP=1`; `trust` honoured only from user scope; user wins on name clash |
| B2 | Raw `claude` stderr (could contain MCP tokens) echoed in client error bodies; narrow `redact()` | medium | ✅ fixed: no stderr in client errors; fixed messages; broad redaction of the result excerpt |
| B3 | Transcript fence and role labels could be spoofed by quoted content | medium | ✅ fixed: fence tags and role-label lines neutralised |
| B4 | No limit on concurrent `claude` processes, no per-turn time limit | medium | ✅ fixed: `QCR_MAX_CONCURRENCY` (4) → `429 qcr_busy`; `QCR_TURN_TIMEOUT_MS` (30 min) |
| B5 | `--json-schema` value unchecked (non-object, `E2BIG`) | low | ✅ fixed: plain object, ≤ 64 KB, else 400 |
| B6 | Env scrub missed other `ANTHROPIC_*` and `CLAUDE_CODE_USE_*` provider switches | low | ✅ fixed: all removed by default (opt-out flag) |
| B7 | Token file creation race; permissions not checked on read | low | ✅ fixed: `wx` create; refuse group/world-readable or foreign-owned files |
| B8 | `claude` resolved via `PATH` on every spawn (relative PATH entries) | low | ✅ fixed: resolved once to an absolute path, relative entries ignored |
| B9 | Temp dirs survive SIGKILL; `claude -p` skips the workspace-trust dialog | info | ✅ stale-dir cleanup at startup; trust caveat documented in SECURITY.md |

Review rounds: one review round plus one fix round. No extra review round was needed: every finding had a
targeted fix and test, and the full suite was re-run (see the PR description for the final count).

## 4. Verification after fixes

* `npm test`: **58/58 pass** (run twice). The tests use only `test/fake-claude.js`.
* One real smoke test in the build sandbox, run against the real `claude` 2.1.296 (haiku): `qcr serve` plus two
  streamed chat-completion requests sent with curl, **not** through Qwen Code. It showed streamed text, a
  `⚙ Read` progress line, the cost footer, and per-request (not cumulative) `prompt_tokens`. Turn 2 answered
  from turn 1's context. The full Qwen Code UI flow is still the manual checklist in `docs/E2E.md`.
