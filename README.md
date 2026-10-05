# dev-blackbox

**Stop your AI coding agent from going in circles.**

[한국어](README.ko.md) · [Benchmark](bench/README.md) · [Advanced usage](docs/advanced.md)

- Your agent "fixes" the same error again and again, because every failing run looks new to it.
- It re-reads thousands of lines of build output to find the one line that matters.
- When the session ends, everything it learned about the failure is gone.

<!-- DEMO_GIF -->

<!-- BENCH_TABLE -->

How this was measured, every individual run, and how to reproduce it: [bench/](bench/README.md).

## Quick start

Node projects:

```bash
npm i -D dev-blackbox
npx dev-blackbox init --hooks claude-code
```

Any other project (Gradle, Maven, Go, Python, …), no `package.json` needed:

```bash
npm i -g dev-blackbox
dev-blackbox init --hooks claude-code
```

`init` creates `.dev-blackbox/` (git-ignored) and adds rules to `CLAUDE.md`
telling the agent to run builds and tests through `dev-blackbox run -- <command>`.
`--hooks claude-code` also registers a hook that rewrites unwrapped build and
test commands (`npm test`, `./gradlew test`, `cd api && pytest`, …) to go
through `dev-blackbox run`, so it works even when the agent ignores the rules.
Leave it out for the rules only. Requires Node.js 20+.

## What the agent sees

The command's output streams through unchanged. When it fails, dev-blackbox
records an incident and appends a short summary. This is
[bench task c](bench/tasks/c-vitest-shared-state) run three times: once as-is,
once after a "fix" to `src/format.ts` that changed nothing, and once more
without edits. The third summary, unedited:

```text
✗ Command failed

Incident: INC-20261005-001
Type: PROCESS_FAILURE
Exit code: 1
Error: AssertionError: expected '3 items · $4,997' to be '3 items · $49.97' // Object.is equality
At: test/pricing.test.ts:23
Occurrences: 3 (first seen 21:51:15) — this failure happened before
  #2 → #3: no file changes — re-run without edits
  #1 → #2: changed src/format.ts — same failure
Report: .dev-blackbox\reports\incidents\INC-20261005-001.md
Details: npx dev-blackbox incident show INC-20261005-001 --format json
```

- **`Occurrences`** counts the same failure across runs and sessions: same
  exception type, same normalized message, same top application frame. Line
  numbers are ignored, so edits that shift lines don't hide a repeat.
- **The indented lines** come from git: the files that changed between two
  failing runs. "changed `src/format.ts` — same failure" tells the agent that
  its last idea didn't work, before it tries a variation of it.
- **`Earliest cause`** appears when the first exception in the output differs
  from the one at the end, e.g. Spring's real `NumberFormatException` printed
  once, followed by thousands of lines of "ApplicationContext failure
  threshold exceeded". dev-blackbox follows every line of output, not just
  the captured tail, and keeps the deepest cause of the first exception chain.

`incident show <ID> --format json` returns the full record, including the
attempt history and the cause excerpt, without re-running anything. Incidents
persist in `.dev-blackbox/`, so the next session starts with them. Once the
same command passes, the incident is marked as a resolve candidate.

## FAQ

### Why not just `| tail -50`?

`tail` shows the last 50 lines of this run, and that's all. It can't tell the
agent that this exact failure already came back twice, that the file it just
edited made no difference, or what the first exception was 4,000 lines up.
And it's gone when the session ends. dev-blackbox stores each failure (the
last 1,000 lines, redacted and compressed) under a fingerprint, counts repeats
across runs and sessions, and exposes them as JSON through `incident list` and
`incident show`.

The early-cause tracking covers exception chains (Java/Kotlin `Caused by:`,
including Gradle's full exception format, JVM uncaught exceptions, JS/Python
errors); [bench task b](bench/tasks/b-gradle-noisy-log) is built around that
case. An early cause that is not an exception, such as a plain log line, still
falls outside the captured tail.

### Does it send data anywhere?

No. Everything is written to `.dev-blackbox/` inside your project, which
`init` adds to `.gitignore`. There is no telemetry and no account. The optional
network collector binds to `127.0.0.1` only. Before anything is written to
disk, secrets are masked: password, token, secret, and API-key fields,
`Authorization` headers, cookies, bearer tokens, private key blocks, and any
body keys you list in `.dev-blackbox/config.yml`.

### Which agents?

- **Claude Code**: rules in `CLAUDE.md`, plus an optional `PreToolUse` hook
  (`init --hooks claude-code`) that rewrites build and test commands to go
  through dev-blackbox. The rewritten command still goes through your normal
  permission settings; the hook never approves anything by itself.
- **Codex, Cursor, Windsurf, and others** that read `AGENTS.md`,
  `.cursorrules`, or `.windsurfrules`: `init --agent-files` adds the same rules
  to those files. There is no hook, so it relies on the agent following them.
- **Any MCP client**: `npx dev-blackbox mcp` (see advanced usage).
- **Anything that runs shell commands** can call the CLI directly.

## Advanced

Network capture, request replay, detached processes, the MCP server,
retention, and the full CLI are documented in [docs/advanced.md](docs/advanced.md).

## License

MIT
