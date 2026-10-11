# Manual end-to-end checklist (real machine)

CI never runs the real `claude` CLI. Run these steps on a machine where Qwen Code and Claude Code are installed
and `claude` is logged in. Each turn costs a little Claude usage.

Setup: follow the README quick start, using a throwaway project directory that contains `hello.txt` with the
content `hello`.

| # | Step | Expected |
|---|------|----------|
| 1 | `qcr serve` in the project; `curl -s localhost:8787/v1/models` without a token | `401 invalid_shim_token` |
| 2 | `curl -s -H "Authorization: Bearer $(qcr token)" localhost:8787/v1/models` | lists `claude-code/*` ids |
| 3 | Start `qwen`, chat one turn with a Qwen model, then `/model claude-code/sonnet` | switch succeeds |
| 4 | Ask "what did I ask you before?" | Claude answers from the quoted prior history |
| 5 | Ask "read hello.txt and tell me its contents" | progress line `> ⚙ Read · …hello.txt`, answer "hello", cost footer; Qwen shows **no** tool-confirmation dialog of its own |
| 6 | Ask "what file did you just read?" | correct answer; the `qcr` log line ends with `turn=resumed` |
| 7 | Ask Claude to edit `hello.txt` with `QCR_PERMISSION_MODE` unset | denial line `⛔ Claude was denied: Edit …` |
| 8 | Restart `qcr` with `QCR_PERMISSION_MODE=acceptEdits`, ask again | file edited |
| 9 | Add a trusted stdio MCP server to `<project>/.qwen/settings.json`, ask Claude to use it | Claude calls `mcp__<name>__…` |
| 10 | `/stats` in Qwen | token usage for `claude-code/sonnet` is non-zero and plausible (not cumulative × turns) |
| 11 | `/model <qwen model>` and chat | normal Qwen turn works |
| 12 | `QCR_CLAUDE_BIN=/nonexistent qcr serve`, one turn | `424` "Claude Code CLI not found" error after one request (no retry loop) |
| 13 | Log out of Claude (`claude /logout`), one turn | "Claude Code is not logged in. Run `claude` …", no retry loop |
| 14 | Long turn (ask Claude to run `sleep 300` via Bash, allowed) | no Qwen timeout or retry; keepalives hold the stream open |
| 15 | Start `qwen` in a different directory against the same `qcr` | `cwd_mismatch` error |
| 16 | `ps aux | grep claude` while a turn is running | no prompt text or tokens in the argv |

Steps 5, 6, 12, 13 and 15 were run in the build sandbox with qwen-code 0.25.1 (npm) and claude 2.1.296; see `docs/PLAN.md` §11.
Step 13 used a fake `claude` that reports "Not logged in".
Steps 3–4 and 11 (switching from a real Qwen model) need a Qwen model API key and were not run.
