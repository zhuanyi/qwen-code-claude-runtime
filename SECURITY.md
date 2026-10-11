# Security

## Credentials: hard rules

* `qcr` only ever spawns the **official `claude` binary**, which authenticates with the user's own login.
* It never reads, copies, proxies, logs or extracts Claude OAuth tokens, API keys or other credentials. It
  never opens `~/.claude*` credential files or the OS keychain.
* It never calls `api.anthropic.com` or any other model API itself. All model traffic is made by `claude`.
* By default it **removes** every `ANTHROPIC_*` variable and `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}` from the
  child's environment. A key exported for another tool therefore cannot silently move `claude` off the
  user's subscription. The variables are removed and never read or forwarded. `QCR_KEEP_ANTHROPIC_ENV=1` turns
  this off.
* `test/no-credentials.test.js` fails the build if the source refers to Anthropic API hosts or credential stores.

## Local server threat model

`qcr` exposes an endpoint that makes Claude Code run tools in your project, so it is protected as follows:

* It binds to `127.0.0.1` only.
* Every request needs `Authorization: Bearer <token>`, compared in constant time. The token comes from
  `QCR_TOKEN` or a random 256-bit token in `~/.config/qwen-claude-runtime/token` (file `0600`, directory
  `0700`).
* `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding. Request bodies must
  be `application/json`, so a plain web form cannot submit a request. No CORS headers are sent.
* Request bodies are capped at 8 MB.
* Requests whose Qwen working directory differs from `qcr`'s (compared after resolving symlinks) are
  refused, so Claude never acts on the wrong tree.
* At most `QCR_MAX_CONCURRENCY` (default 4) concurrent `claude` turns are allowed, each with a wall-clock limit.
* The token file is created exclusively (`O_EXCL`, `0600`). An existing token file that is group- or
  world-readable, or owned by another user, is refused.

## Subprocess safety

* `claude` is spawned with `shell: false` and an argument array. User text is **never** put in argv: the
  prompt goes over stdin as stream-json. System prompts go through a `0600` file in a private `0700` temp
  directory, which is deleted after the turn.
* Model aliases, session ids (UUID), permission modes, allowed-tool rules and MCP server names are validated
  against strict patterns. Values starting with `-` are rejected.
* The permission mode defaults to `manual` with `--permission-prompts none`, so anything that would prompt is
  denied. `bypassPermissions`, `auto` and `dontAsk` are refused, and the argument builder asserts that
  `--dangerously-skip-permissions` is never passed.
* The generated MCP config, which can contain your MCP servers' env and headers, is written `0600` and
  deleted after each turn. Stale `qcr-*` temp dirs left by a killed shim are removed at startup.
* `QCR_CLAUDE_BIN` / `claude` is resolved to an absolute path once at startup, ignoring relative `PATH`
  entries, so a `claude` planted in the project directory is never picked up.

## Untrusted repositories

* MCP servers from `<project>/.qwen/settings.json` are ignored unless `QCR_PROJECT_MCP=1` is set, and are never
  auto-trusted. Otherwise, starting `qcr` in a cloned repository could make `claude` launch commands chosen by
  that repository.
* `claude -p` does not show Claude Code's interactive workspace-trust dialog, so project-level Claude
  configuration in the repository (for example `.claude/settings.json` hooks) is honoured by `claude` itself.
  Run `qcr` only in projects you trust, the same as you would `claude`.

## Logging

Logs contain the method, path, status, duration, model alias and error code only. They never contain prompts,
tokens, headers, environment variables or MCP configuration.
Raw `claude` stderr is never returned to the client. Errors use fixed messages per error code, plus at most a
short excerpt of Claude's own result text. That excerpt has common secret patterns redacted
(`sk-…`, GitHub and Slack tokens, `Bearer …`, `Authorization:`/`x-api-key:` headers, `*_TOKEN=`/`*_KEY=`/`*_SECRET=`).

## Prompt injection

When Claude joins a conversation that has history, that earlier history (including any tool output) is passed
to it fenced and labelled as untrusted quoted data. Fence-closing tags and role labels inside the quoted
text are neutralised, so quoted content cannot break out of the fence. Claude Code's own permission system
remains the final gate on tool use.

## Reporting

Please open a private security advisory on this repository.

## Qwen skills server

The built-in `qwen-skills` MCP server (`qcr mcp-skills`) is read-only and does no network I/O. File reads are limited to
regular text files of at most 256 KB whose real path stays inside the skill directory (no `..`, absolute paths or symlink
escapes). A project skill folder, or its `SKILL.md`, that symlinks outside the project or skill directory is
skipped, so a repository cannot make the server read files elsewhere on disk. Project skills are repository-provided instructions, at the same trust level as `CLAUDE.md`. Scripts they
mention run through Claude's own tools and permission rules. The server name is reserved; a user MCP server with the same
name is dropped. Extra skill directories (`skills.directories`) are honoured only from the user's `~/.qwen/settings.json`; the same key in a
project settings file is ignored with a warning. Extension skills must stay inside their extension directory (the
extension directory itself may be a symlink made by `qwen extensions link`). Disable it with `QCR_SKILLS=off`.
