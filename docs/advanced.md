# Dev Blackbox: advanced usage

[← Back to README](../README.md)

This page covers everything beyond the basic `run` loop: automatic dev-script
wrapping, network capture and replay, detached processes, the MCP server,
retention, and the full CLI.

## Contents

- [Automatic dev-script wrapping](#automatic-dev-script-wrapping)
- [Reports and storage](#reports-and-storage)
- [Agent workflow](#agent-workflow)
- [Network capture](#network-capture)
- [Replaying a request](#replaying-a-request)
- [Detached processes](#detached-processes)
- [MCP server and Claude Code hook](#mcp-server-and-claude-code-hook)
- [Automatic retention](#automatic-retention)
- [CLI reference](#cli-reference)
- [Development](#development)

## Automatic dev-script wrapping

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

Automatic wrapping requires a local installation. If
`node_modules/.bin/dev-blackbox` is missing, initialization leaves
`package.json` unchanged and prints the exact install command instead of
creating a broken script.

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

## Reports and storage

Process, build, and test failures create a deduplicated incident:

```text
.dev-blackbox/reports/incidents/INC-20260718-001.md
```

Failed recorded network requests create and link these views:

```text
.dev-blackbox/reports/incidents/INC-20260718-002.md
.dev-blackbox/reports/network/REQ-20260718-001.md
.dev-blackbox/reports/NETWORK.md
```

Failure-specific `INC-...md` and `REQ-...md` files are written immediately.
The aggregate `NETWORK.md` view is refreshed at most once every five seconds
and flushed when the collector stops, avoiding a full JSONL scan per request.

Markdown files are regenerated views. JSONL records and compressed redacted
logs are the source of truth used by query commands and agents.

Each incident keeps the last 1,000 captured log lines (`ringBuffer.maxLines`
in `config.yml`). If the only line that names the cause scrolled out before
the command finished, the incident will not contain it.

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

## Agent workflow

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
Axios adapter from [`examples/`](../examples/README.md) for frontend traffic.
Spring and FastAPI examples are also included. All adapters POST to the local
collector at `http://127.0.0.1:4319/events/network` and should propagate
`X-Dev-Blackbox-Trace-Id` to link frontend and backend events.

The collector binds to `127.0.0.1` only. Secrets, authorization headers,
cookies, and configured body keys are redacted before persistence. Bodies are
size-capped and binary payloads are excluded.

## Replaying a request

```bash
npx dev-blackbox network replay <REQ-ID>
npx dev-blackbox network replay <REQ-ID> --base-url http://127.0.0.1:8080
```

Replay only targets loopback HTTP(S) URLs; external hosts are always blocked,
including through redirects. Non-idempotent methods (`POST`, `PATCH`, …) are
refused unless `--allow-unsafe` is passed, because replaying them repeats their
side effects. The result shows a diff against the recorded response.

## Detached processes

For long-running services that should outlive one command:

```bash
npx dev-blackbox start --name api -- npm run start
npx dev-blackbox process list --format json
npx dev-blackbox process logs api --lines 100
npx dev-blackbox process stop api
```

## MCP server and Claude Code hook

```bash
claude mcp add dev-blackbox -- npx dev-blackbox mcp
npx dev-blackbox init --hooks claude-code
```

The MCP server exposes command, incident, network, replay, and report tools
to any MCP client.

The optional Claude Code `PreToolUse` hook rewrites unwrapped build and test
commands (`npm test`, `npm run build`, `./gradlew …`, `./mvnw …`, `pytest`,
`cargo test`, `go test`, `make test`, …) to `dev-blackbox run -- <command>`
through the hook's `updatedInput`:

- Only the build/test stage of a compound command is wrapped:
  `cd api && npm test 2>&1 | tail -50` becomes
  `cd api && npx dev-blackbox run -- npm test 2>&1 | tail -50`.
  Leading `VAR=value` assignments stay in front.
- Long-running commands are left alone: `npm run dev`/`start`/`serve`/`watch`,
  `gradlew bootRun`, `mvn spring-boot:run`, anything with `--watch`.
  Heredocs and `$(…)` are never rewritten.
- The hook never returns a permission decision, so the rewritten command
  goes through your normal permission rules. If you allowlist exact commands
  such as `Bash(npm test)`, also allow the wrapped form,
  e.g. `Bash(npx dev-blackbox run -- npm test)`.
- With a local install the hook calls
  `node "${CLAUDE_PROJECT_DIR}/node_modules/dev-blackbox/dist/cli.js"`
  directly, because it runs before every Bash call and `npx` adds about a
  second each time on Windows. With a global install it calls `dev-blackbox`.
  Re-running `init --hooks claude-code` updates an older hook entry in place.

## Automatic retention

Automatic retention is checked after recorded commands, when a collector
starts, and every 24 hours while a collector remains active. Checks are
throttled to once every five minutes and serialized by a cross-process
maintenance lock. Collector shutdown performs one final forced pass so
successful response bodies are stripped promptly. Defaults are:

- command session files: at most 100 (oldest metadata is removed immediately);
- repeated incidents: one latest compressed log blob per fingerprint;
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
  maxSessionFiles: 100
retention:
  successfulCommandDays: 3
  resolvedIncidentDays: 90
  successfulRequestDays: 3
  failedRequestBodyDays: 30
  autoPruneIntervalHours: 24
  autoPruneMinIntervalMinutes: 5
```

## CLI reference

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

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Node.js 20 or newer is required. Capture uses pipes rather than a PTY. On
Windows, commands that resolve to a `.cmd` shim (such as `npm`) are retried
through a shell.

Known Windows issue in 0.3.0: `run -- ./gradlew test` and
`run -- gradlew.bat test` both fail (the first hands a POSIX script to
`cmd.exe`, the second hits Node.js's `spawn EINVAL` for `.bat` files). Use
`run -- cmd /c .\gradlew.bat test` until this is fixed.
