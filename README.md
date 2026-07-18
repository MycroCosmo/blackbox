# Dev Blackbox

A local flight recorder for AI coding agents. Dev Blackbox runs a project's
development command with terminal recording and a loopback-only network
collector, then turns failures into redacted, structured incidents and
regenerated Markdown reports.

## Install and attach

```bash
npm install --save-dev dev-blackbox
npx dev-blackbox init --auto
npm run dev
```

`init --auto` is explicit because dependencies should not silently rewrite a
consumer's `package.json`. It:

- creates `.dev-blackbox/config.yml` and adds `.dev-blackbox/` to `.gitignore`;
- writes agent rules to `CLAUDE.md` and `AGENTS.md`;
- preserves the existing `dev` command as `dev:original`;
- changes `dev` to `dev-blackbox dev -- npm run dev:original`.

For another npm script, use `npx dev-blackbox init --auto --script start`.
Existing backup scripts are never overwritten, and repeated initialization is
idempotent.

After attachment, the normal command starts everything together:

```text
npm run dev
  -> Dev Blackbox recorder
     -> local collector on 127.0.0.1:4319
     -> original project dev command
     -> Node.js fetch instrumentation
```

## Failure reports

Process, build, and test failures create a deduplicated incident:

```text
.dev-blackbox/reports/incidents/INC-20260718-001.md
```

Failed recorded network requests create and link all three views immediately:

```text
.dev-blackbox/reports/incidents/INC-20260718-002.md
.dev-blackbox/reports/network/REQ-20260718-001.md
.dev-blackbox/reports/NETWORK.md
```

Markdown files are regenerated views. JSONL records and compressed redacted
logs are the source of truth used by query commands and agents.

## AI agent workflow

The generated agent rules tell an agent to inspect existing evidence before a
bug fix:

```bash
npx dev-blackbox incident list --format json
npx dev-blackbox incident show <INC-ID> --format json
npx dev-blackbox network list --failed --format json
npx dev-blackbox network show <REQ-ID> --format json
```

The agent should then fix the code, run the same command through Dev Blackbox,
and resolve the incident after verification. Reports are evidence, not a
substitute for source inspection or reproduction when the evidence is
insufficient.

## Network capture

Attached `dev` sessions automatically instrument Node.js global `fetch`
without consuming request or response streams. HTTP failures, network errors,
timeouts reported by adapters, empty responses, and registered contract
mismatches can become network incidents.

Browser traffic cannot be intercepted by a Node.js preload. Add the fetch or
Axios adapter from [`examples/`](examples/README.md) for frontend traffic.
Spring and FastAPI examples are also included. All adapters POST to the local
collector at `http://127.0.0.1:4319/events/network` and should propagate
`X-Dev-Blackbox-Trace-Id` to link frontend and backend events.

The collector binds to `127.0.0.1` only. Secrets, authorization headers,
cookies, and configured body keys are redacted before persistence. Bodies are
size-capped and binary payloads are excluded.

## Automatic retention

Retention runs after recorded commands, when a collector starts and stops, and
every 24 hours while a collector remains active. Defaults are:

- successful command sessions: 3 days;
- successful network metadata: 3 days;
- successful network bodies: stripped when the collector session ends;
- failed network bodies: stripped after 30 days;
- resolved, unpinned incidents and linked reports: 90 days;
- open or pinned incidents: never automatically deleted.

The 500 MB default size cap is enforced by removing disposable command
sessions, successful network events, and resolved unpinned incidents in that
order. Protected open or pinned data may intentionally exceed the cap.

Manual inspection and cleanup remain available:

```bash
npx dev-blackbox storage status
npx dev-blackbox storage prune
npx dev-blackbox storage prune --older-than 30d
```

Configuration lives at `.dev-blackbox/config.yml`:

```yaml
storage:
  maxTotalSizeMB: 500
retention:
  successfulCommandDays: 3
  resolvedIncidentDays: 90
  successfulRequestDays: 3
  failedRequestBodyDays: 30
  autoPruneIntervalHours: 24
```

## CLI

```bash
dev-blackbox init [--auto] [--script dev] [--agent-files] [--hooks claude-code]
dev-blackbox dev [--port 4319] -- <command>
dev-blackbox run [--timeout <seconds>] -- <command>

dev-blackbox incident list [--format json] [--all]
dev-blackbox incident show <ID> [--format json] [--log-lines <n>]
dev-blackbox incident report <ID>
dev-blackbox incident resolve <ID>
dev-blackbox incident pin <ID>

dev-blackbox collect [--port 4319]
dev-blackbox network list [--format json] [--trace <id>] [--failed]
dev-blackbox network show <REQ-ID> [--format json]
dev-blackbox network replay <REQ-ID> [--allow-unsafe] [--base-url <url>]
dev-blackbox report network [--last 30m]

dev-blackbox start --name <name> -- <command>
dev-blackbox process list [--format json]
dev-blackbox process logs <name> [--lines <n>]
dev-blackbox process stop <name>

dev-blackbox storage status [--format json]
dev-blackbox storage prune [--older-than 30d]
dev-blackbox mcp
```

`run` propagates the direct child exit code. `dev` keeps the original project
command in the foreground and shuts down the collector when it exits.

## Storage layout

```text
.dev-blackbox/
├── sessions/commands-<sessionId>.jsonl
├── incidents.jsonl
├── network.jsonl
├── blobs/logs/
├── reports/
│   ├── incidents/INC-....md
│   ├── network/REQ-....md
│   └── NETWORK.md
├── processes/
└── config.yml
```

## MCP and Claude Code hook

```bash
claude mcp add dev-blackbox -- npx dev-blackbox mcp
npx dev-blackbox init --hooks claude-code
```

The MCP server exposes command, incident, network, replay, and report tools.
The optional Claude Code `PreToolUse` hook redirects unwrapped build and test
commands through Dev Blackbox.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Node.js 20 or newer is required. Capture uses pipes rather than a PTY, and
Windows `.cmd`/`.bat` shims use a shell fallback.
