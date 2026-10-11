# Fixtures

Recorded from `claude` 2.1.296 (sanitized): `tool-turn.jsonl`, `side-query-json.jsonl`.

Synthetic (hand-written to match the recorded format): `text-turn.jsonl`, `not-logged-in.jsonl`,
`rate-limited.jsonl`, `permission-denied.jsonl`.

## Reasonix (`reasonix/`)

Recorded from the real `reasonix` 1.38.7 binary (`reasonix -p --output-format stream-json`, prompt on stdin), with
paths sanitized to `/work/project`. No DeepSeek key was available, so the binary was pointed at a local
OpenAI-compatible mock provider (model `mock-model`): the event stream, session ids, permission handling,
retries and error results are Reasonix's own output, but the model text and token counts come from the mock.

* `text-turn.jsonl`, `resume-copy.jsonl` (`--resume <id> --copy`), `tool-turn.jsonl` (`read_file`),
  `permission-denied.jsonl` (`write_file` under `--permission-mode manual`).
* `auth-401.jsonl`, `quota-402.jsonl`: the mock answered HTTP 401 / 402. The error text is Reasonix's.
* `retrying-429.jsonl`: the mock answered 429; Reasonix emitted `retrying` events and was stopped with SIGTERM.
* `missing-key.jsonl`: fresh HOME, default model, no `DEEPSEEK_API_KEY`.
* `no-session.stderr`: stderr of `--resume <unknown id> --copy` (stdout is empty, exit 1).

`test/fake-reasonix.js` replays these. It is put on `PATH` as `reasonix` by the tests, so CI needs no Reasonix install.
