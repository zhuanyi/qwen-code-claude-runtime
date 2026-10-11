# Security

## Credentials: hard rules

* `qcr` only ever spawns the **official `claude` binary**, which authenticates with the user's own login.
* It never reads, copies, proxies, logs or extracts Claude OAuth tokens, API keys or other credentials. It
  never opens `~/.claude*` credential files or the OS keychain.
* It never calls `api.anthropic.com` or any other model API itself. All model traffic is made by `claude`.
* By default it **removes** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` from the
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
* Requests whose Qwen working directory differs from `qcr`'s are refused, so Claude never acts on the wrong tree.

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
  deleted after each turn.

## Logging

Logs contain the method, path, status, duration, model alias and error code only. They never contain prompts,
tokens, headers, environment variables or MCP configuration. `claude` stderr is truncated and has
`sk-ant-…`/`Bearer …` patterns redacted before it is shown in an error message.

## Prompt injection

When Claude joins a conversation that has history, that earlier history (including any tool output) is passed
to it fenced and labelled as untrusted quoted data. Claude Code's own permission system remains the final
gate on tool use.

## Reporting

Please open a private security advisory on this repository.
