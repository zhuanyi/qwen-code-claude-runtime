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
