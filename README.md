# qwen-code-claude-runtime

Use Claude Code as a switchable runtime inside [Qwen Code](https://github.com/QwenLM/qwen-code). Pick it like
any other model (`/model claude-code/sonnet`). The turn then runs through **your own installed `claude` CLI**,
on your own login or subscription. Claude Code runs the tools itself (Read, Edit, Bash, …), and its streamed
text, tool progress, token usage and errors appear in Qwen Code. Switch back to a Qwen model at any time.

Status: **MVP / early development**. Design: [`docs/PLAN.md`](docs/PLAN.md). Review record:
[`docs/REVIEW.md`](docs/REVIEW.md). Manual test checklist: [`docs/E2E.md`](docs/E2E.md).

## Credentials policy

This project only spawns the official `claude` binary as a subprocess and lets it use its own login.
It **never** reads, copies, proxies or extracts Claude OAuth tokens or other credentials, never touches
`~/.claude` credential files or the OS keychain, and never calls `api.anthropic.com` itself.
See [SECURITY.md](SECURITY.md).

## How it works

```
qwen ──OpenAI chat.completions (SSE)──▶ qcr (127.0.0.1, bearer token) ──spawn, no shell──▶ claude -p --output-format stream-json …
```

`qcr` is a small, dependency-free local server that speaks the OpenAI chat-completions protocol, which stock
Qwen Code already supports. Qwen Code needs no patch. For each turn, `qcr` does the following:

* Spawns `claude -p --input-format stream-json --output-format stream-json …`. The prompt goes over stdin, never
  through argv.
* Streams Claude's text back as `delta.content`. Each Claude tool call shows up as a progress line such as
  `> ⚙ Read · src/app.ts`. `qcr` **never** returns `tool_calls` on a chat turn, so Qwen does not run the tools a
  second time.
* Returns token usage, and appends a footer with Claude's reported cost (`_claude-code · 2 turns · $0.0123_`).
* Keeps the conversation going across turns: later turns use `claude --resume <id> --fork-session`. When Claude
  joins a conversation that already has history (for example after you switch from a Qwen model), the earlier
  history is passed to it as quoted context.
* Exposes your Qwen skills (`.qwen/skills`, `.agents/skills`, project then user; `skills.directories` from your user settings; installed, enabled extensions as `ext:skill`; `skills.disabledLevels` / `skills.disabled` honoured) to Claude through a small built-in,
  read-only stdio MCP server, `qwen-skills` (tools `qwen_skill` and `qwen_skill_file`). Disable with `QCR_SKILLS=off`.
* Passes your Qwen `mcpServers` from `~/.qwen/settings.json` to `claude --mcp-config`. Servers you marked
  `"trust": true` there are pre-allowed for Claude. Project-level `<project>/.qwen/settings.json` servers are
  used only when you set `QCR_PROJECT_MCP=1`: a cloned repository could otherwise make `claude` start arbitrary
  commands. Project servers are never auto-trusted.
* Turns failures into clear errors: `claude` not installed, not logged in, quota exhausted (with the reset time),
  unknown model.

The design borrows from OpenClaw's `claude-cli` agent runtime ([openclaw/openclaw](https://github.com/openclaw/openclaw),
MIT): treating the CLI as a runtime behind a model id, using stream-json I/O, removing `ANTHROPIC_*` variables from
the child environment, and passing MCP servers via `--mcp-config`. No OpenClaw code is copied.

## Quick start

Requirements: Node ≥ 20, Qwen Code, and Claude Code (`claude`) installed and logged in. Run `claude` once
interactively and complete `/login`.

```bash
git clone https://github.com/zhuanyi/qwen-code-claude-runtime && cd qwen-code-claude-runtime
npm link            # installs the `qcr` command (no dependencies)

cd ~/my-project     # Claude works in the directory where qcr runs
qcr serve           # listens on http://127.0.0.1:8787/v1
export QCR_TOKEN="$(qcr token)"   # in the shell where you will start qwen
```

Add a provider entry to `~/.qwen/settings.json`:

```jsonc
{
  "modelProviders": {
    "openai": [
      {
        "id": "claude-code/sonnet",
        "name": "Claude Code (sonnet, local CLI)",
        "baseUrl": "http://127.0.0.1:8787/v1",
        "envKey": "QCR_TOKEN",
        "generationConfig": { "timeout": 1800000, "contextWindowSize": 200000 }
      },
      { "id": "claude-code/opus", "baseUrl": "http://127.0.0.1:8787/v1", "envKey": "QCR_TOKEN",
        "generationConfig": { "timeout": 1800000 } }
    ]
  },
  // Recommended while using Claude Code as the main model:
  "fastModel": "<one of your Qwen models>",          // keeps titles/summaries off Claude
  "memory": { "enableManagedAutoMemory": false },     // avoids an extra claude run per turn
  "ui": { "enableFollowupSuggestions": false }
}
```

Then, in Qwen Code, run `/model claude-code/sonnet` (or pick it from `/model`) and keep chatting. Very long
agent turns may also need `QWEN_STREAM_MAX_LIFETIME_MS=0` in the environment where `qwen` runs, because Qwen
caps a single stream at 15 minutes by default.

## Configuration (`qcr serve` environment)

| Variable | Default | Meaning |
|---|---|---|
| `QCR_PORT` | `8787` | Listen port (always `127.0.0.1`) |
| `QCR_TOKEN` | generated | Bearer token. Without it, a token is generated once into `~/.config/qwen-claude-runtime/token` (0600) |
| `QCR_CWD` | current dir | Working directory for `claude`. Requests from a Qwen session in a different directory are refused |
| `QCR_CLAUDE_BIN` | `claude` | Path to the official Claude Code binary |
| `QCR_PERMISSION_MODE` | `manual` | `manual`, `acceptEdits` or `plan`. `bypassPermissions` is **refused** |
| `QCR_ALLOWED_TOOLS` | – | Extra `--allowedTools` rules, comma-separated, e.g. `Edit,Bash(npm test)` |
| `QCR_MCP` | on | `off` stops passing Qwen MCP servers to Claude |
| `QCR_SKILLS` | on | `off` stops exposing Qwen skills to Claude (the `qwen-skills` MCP server) |
| `QCR_PROJECT_MCP` | off | `1` also passes `<project>/.qwen/settings.json` MCP servers (never auto-trusted) |
| `QCR_MAX_CONCURRENCY` | `4` | Maximum simultaneous `claude` turns. Further requests get `429 qcr_busy` |
| `QCR_TURN_TIMEOUT_MS` | `1800000` | Wall-clock limit per turn |
| `QCR_TOOL_PROGRESS` | `content` | `off` hides the tool progress lines |
| `QCR_FOOTER` | on | `off` hides the cost footer |
| `QCR_KEEP_ANTHROPIC_ENV` | – | `1` keeps all `ANTHROPIC_*` and `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}` variables for the child. By default they are removed so that `claude` uses your subscription login rather than a key or provider set for something else |

**Permissions:** with `-p`, nobody can answer Claude's permission prompts, so any action that would prompt is
denied (`--permission-prompts none`). Denials are reported in the reply with a hint. Allow what you need with
`QCR_ALLOWED_TOOLS`, your Claude settings, or `QCR_PERMISSION_MODE=acceptEdits`.

## Known gaps (MVP)

* Qwen skills are exposed to Claude through a local MCP server (see above). Qwen *tools* are not yet exposed, and
  Qwen's bundled skills are not served (they are Qwen-internal).
* Context files (`QWEN.md`) reach Claude only through Qwen's own startup context on the first Claude turn.
* `includeTools` / `excludeTools` in MCP configs are ignored (a warning is logged).
* Continuity depends on Qwen sending back the assistant text it received. If Qwen compresses the history, the
  next turn starts a new Claude session with the history as quoted context.
* Only one project directory per `qcr` process.
* No images or attachments. No interactive permission prompts.

## Development

```bash
npm test     # unit + integration tests; uses test/fake-claude.js, never the real CLI
```

## Licence

MIT. Qwen Code is Apache-2.0; this repository contains no Qwen Code source. Claude Code is a product of Anthropic and is
used here only as an external program that the user installs themselves.
