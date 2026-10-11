# qwen-code-claude-runtime

Use Claude Code as a switchable runtime inside [Qwen Code](https://github.com/QwenLM/qwen-code). Pick it like any other model, and the turn runs through your own installed `claude` CLI (your own subscription/login). Claude Code executes the tools, and your Qwen Code skills and MCP servers stay available to it.

Status: early development. See `docs/PLAN.md` once it lands.

This project only drives the official `claude` CLI binary as a subprocess. It never reads, copies or proxies Claude credentials.
