# Dev Blackbox

A local flight recorder for AI coding agents. It wraps your build/test/run
commands, keeps a ring buffer of recent output, and — only when something
fails — freezes that context into a structured, deduplicated **Incident**
that an agent can query as JSON instead of re-reading raw logs.

The primary user is an AI coding agent (Claude Code, Codex, Cursor, …), so
every output is optimized for machine parsing first: stable JSON schemas,
verbatim exit-code propagation, and a machine-readable failure summary on
stderr.

## Quick start

```bash
npx dev-blackbox init            # set up .dev-blackbox/ + agent usage rules in CLAUDE.md
npx dev-blackbox run -- npm test # run any command through the recorder
```

On failure you get:

```text
✗ Command failed

Incident: INC-20260713-001
Type: PROCESS_FAILURE
Exit code: 1
Occurrences: 1
Report: .dev-blackbox/reports/incidents/INC-20260713-001.md
Details: npx dev-blackbox incident show INC-20260713-001 --format json
```

The child's exit code is propagated verbatim, so existing error handling
(agents included) keeps working.

## How it works

- **Normal runs** store metadata only (`command`, `exitCode`, `durationMs`).
- **Hard signals** (non-zero exit code, kill signal, timeout) create incidents.
- **Soft signals** (exception patterns, stack traces, `Tests: 2 failed`,
  `BUILD FAILED`) never create incidents on their own — they enrich a
  hard-signal incident with the error type, message, and code location.
- **Fingerprinting** merges repeats: error type + normalized message + top
  application frame (file + function). Line numbers are excluded on purpose,
  so refactors that shift lines don't split an incident; the latest line
  number is kept as detail.
- **Resolve flow**: when the previously failing command later succeeds, the
  incident becomes a `resolve_candidate`; close it with `incident resolve`.
- **Security**: secrets (passwords, tokens, JWTs, AWS keys, auth headers) are
  masked *before* anything is buffered or written to disk.

## CLI

```bash
dev-blackbox init [--agent-files] [--hooks claude-code]
dev-blackbox run [--timeout <s>] -- <cmd>    # exit code propagated verbatim

dev-blackbox incident list  [--format json] [--all]
dev-blackbox incident show <ID> [--format json] [--log-lines <n>]
dev-blackbox incident report <ID>            # regenerate the Markdown report
dev-blackbox incident resolve <ID>
dev-blackbox incident pin <ID>               # never auto-pruned

dev-blackbox start --name <n> -- <cmd>       # supervised long-running process
dev-blackbox process list [--format json]
dev-blackbox process logs <name> [--lines <n>]
dev-blackbox process stop <name>

dev-blackbox collect [--port 4319]           # network collector (127.0.0.1 only)
dev-blackbox network list [--format json] [--trace <id>] [--failed]
dev-blackbox network show <REQ-ID> [--format json]
dev-blackbox network replay <REQ-ID> [--allow-unsafe] [--base-url <url>]

dev-blackbox report network [--last 30m]     # regenerate reports/NETWORK.md
dev-blackbox report incident <ID>

dev-blackbox storage status [--format json]
dev-blackbox storage prune [--older-than 30d]

dev-blackbox mcp                             # MCP server over stdio
```

All query commands support `--format json`; field removals or semantic
changes only happen in a major version.

## Storage layout (Phase 1: JSONL prototype)

```text
.dev-blackbox/
├── sessions/commands-<sessionId>.jsonl   # one file per run process (single writer)
├── incidents.jsonl                       # append-only; latest record per id wins
├── blobs/logs/                           # gzipped ring-buffer dumps
├── reports/incidents/                    # regenerated Markdown views
└── config.yml
```

Reports are *views* regenerated from data — nothing appends to a Markdown
file forever. Pruning never removes pinned or unresolved incidents.

## Configuration (`.dev-blackbox/config.yml`)

```yaml
reportLanguage: en        # or ko
ringBuffer:
  maxLines: 1000
  maxAgeSeconds: 300
  maxMemoryMB: 10
detection:
  softSignalIncident: false   # opt-in: incidents from soft signals alone
storage:
  maxTotalSizeMB: 500
retention:
  successfulCommandDays: 3
  resolvedIncidentDays: 90
security:
  redactBodyKeys: [password, accessToken, refreshToken, apiKey, secret, ...]
```

## Development

```bash
npm install
npm test          # vitest
npm run build     # tsc → dist/
npm run dev -- run -- node -e "process.exit(1)"   # run the CLI from source
```

## Network recording (Phase 2)

`dev-blackbox collect` starts a collector bound to `127.0.0.1:4319`. Any
language reports events with a plain HTTP POST to `/events/network`; copyable
interceptor snippets (fetch, Axios, Spring Filter, FastAPI) live in
[`examples/`](examples/README.md). Frontend and backend events sharing an
`X-Dev-Blackbox-Trace-Id` are linked into one trace. HTTP 200 alone is never
"success": responses are classified (`http_error`, `timeout`,
`contract_mismatch`, `empty_response`, `slow_response`, …), failing traffic is
linked to deduplicated incidents, and payloads are masked, size-capped and
binary-excluded before touching disk.

Response contracts are checked only when you register them in
`.dev-blackbox/contracts.json` (JSON-Schema subset: `type`, `required`,
`properties`, `items`, `enum`).

## Replay & verification (Phase 3)

`network replay REQ-…` re-sends a recorded request and diffs the responses.
Safety rules: idempotent methods (GET/HEAD/OPTIONS) only unless
`--allow-unsafe`; external hosts always blocked; every replay carries
`X-Dev-Blackbox-Replay: true`. If a failing request now succeeds, its linked
incident becomes a resolve candidate.

## MCP server (Phase 3)

```bash
claude mcp add dev-blackbox -- npx dev-blackbox mcp
```

Tools: `run_command`, `list_incidents`, `get_incident`,
`find_similar_incidents`, `list_network_requests`, `get_network_request`,
`replay_request`, `generate_report`.

## Claude Code hooks (opt-in)

`init --hooks claude-code` registers a `PreToolUse` hook in
`.claude/settings.json` that denies unwrapped build/test Bash commands with
guidance to re-run them through `dev-blackbox run` — a stronger adoption path
than instructions alone, kept opt-in because it is invasive.

## Roadmap

- **Phase 1 — done**: terminal blackbox + agent adoption path (`init`, hooks).
- **Phase 2 — done**: network collector, trace ids, `NETWORK.md`, sampling,
  retention; supervised long-running processes (`start`/`process`).
- **Phase 3 — done**: replay, contract checks, incident↔network linking, MCP.
- **Phase 4 (future)**: SQLite storage (multi-writer safety), per-tool log
  parsers (Gradle/Jest/pytest), W3C Trace Context compatibility.

Interactive (PTY) commands are out of scope for the MVP; capture uses pipes.
Primary targets are Linux/macOS/WSL; Windows works via a `cmd` shell fallback
for `.cmd`/`.bat` shims.
