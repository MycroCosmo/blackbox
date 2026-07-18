#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runClaudeHook } from "./claude-hook.js";
import { parseCollectorPort, startCollector } from "./collector-server.js";
import { loadConfig } from "./config.js";
import { runDevSession } from "./dev-session.js";
import { runMcpServer } from "./mcp-server.js";
import { replayRequest } from "./replay.js";
import { setPinned, setStatus } from "./incident.js";
import { runInit } from "./init.js";
import { renderNetworkReport } from "./network-report.js";
import {
  listProcesses,
  readProcessLogs,
  startProcess,
  stopProcess,
  superviseProcess,
} from "./process-manager.js";
import { renderIncidentReport } from "./report.js";
import { formatBytes, prune, storageStatus } from "./retention.js";
import { runCommand } from "./runner.js";
import { Storage } from "./storage.js";
import { SCHEMA_VERSION, type IncidentRecord } from "./types.js";

/** CLI (spec 9). Query commands support `--format json` with a stable,
 *  backward-compatible schema (spec 3.7). `run` propagates the child's exit
 *  code verbatim. */

const program = new Command();
program
  .name("dev-blackbox")
  .description("Local flight recorder for AI coding agents")
  .version("0.2.1")
  .enablePositionalOptions();

function ctx() {
  const storage = Storage.discover(process.cwd());
  const config = loadConfig(storage.root);
  return { storage, config };
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function incidentSummary(i: IncidentRecord) {
  return {
    incidentId: i.incidentId,
    fingerprint: i.fingerprint,
    kind: i.kind,
    errorType: i.errorType,
    message: i.message,
    status: i.status,
    pinned: i.pinned,
    firstSeenAt: i.firstSeenAt,
    lastSeenAt: i.lastSeenAt,
    occurrenceCount: i.occurrenceCount,
    lastCommand: i.lastCommand,
    lastExitCode: i.lastExitCode,
  };
}

// ---------------------------------------------------------------- init
program
  .command("init")
  .description("Set up .dev-blackbox, agent rules, and optional automatic dev-script wrapping")
  .option("--agent-files", "also insert the rules block into detected .cursorrules / AGENTS.md")
  .option("--hooks <agent>", "register agent hooks (claude-code)")
  .option("--auto", "wrap an npm script so it starts the app, collector, and recorder together")
  .option("--script <name>", "npm script to wrap with --auto", "dev")
  .action((opts: { agentFiles?: boolean; hooks?: string; auto?: boolean; script: string }) => {
    const result = runInit(process.cwd(), {
      agentFiles: opts.agentFiles,
      hooks: opts.hooks,
      auto: opts.auto,
      script: opts.script,
    });
    const lines = [
      result.createdDir ? "✓ Created .dev-blackbox/" : "· .dev-blackbox/ already exists",
      result.createdConfig ? "✓ Created .dev-blackbox/config.yml" : "· config.yml already exists",
      result.gitignoreUpdated ? "✓ Added .dev-blackbox/ to .gitignore" : "· .gitignore already covers .dev-blackbox/",
      `✓ Instruction block upserted: ${result.updatedInstructionFiles.join(", ")}`,
    ];
    const skipped = result.detectedAgentFiles.filter(
      (f) => !result.updatedInstructionFiles.includes(f),
    );
    if (skipped.length > 0) {
      lines.push(`· Detected but not modified (re-run with --agent-files): ${skipped.join(", ")}`);
    }
    if (opts.hooks === "claude-code") {
      lines.push(
        result.hooksConfigured
          ? "✓ Claude Code PreToolUse hook registered in .claude/settings.json"
          : "· Claude Code hook already registered",
      );
    } else if (opts.hooks) {
      lines.push(`· --hooks ${opts.hooks}: unsupported (only claude-code is available)`);
    }
    if (result.scriptWrap) {
      const mark = result.scriptWrap.status === "wrapped" ? "✓" : "·";
      lines.push(`${mark} ${result.scriptWrap.message}`);
      if (result.scriptWrap.status === "wrapped") {
        lines.push(
          `  Preserved original command as '${result.scriptWrap.originalScript}'. Run: npm run ${result.scriptWrap.script}`,
        );
      }
    }
    console.log(lines.join("\n"));
  });

// ---------------------------------------------------------------- dev
program
  .command("dev")
  .description("Run a development command with the recorder and network collector attached")
  .passThroughOptions()
  .option("--port <port>", "collector port (default: config collector.port, 4319)")
  .argument("<command...>", "development command to execute")
  .action(async (commandArgs: string[], opts: { port?: string }) => {
    const { storage, config } = ctx();
    const argv = commandArgs[0] === "--" ? commandArgs.slice(1) : commandArgs;
    const outcome = await runDevSession(argv, {
      cwd: process.cwd(),
      storage,
      config,
      port: parseCollectorPort(opts.port),
    });
    process.exit(outcome.exitCode);
  });

// ---------------------------------------------------------------- run
program
  .command("run")
  .description("Run a command through the blackbox: dev-blackbox run -- <command> [args...]")
  .passThroughOptions()
  .option("--timeout <seconds>", "kill the command after N seconds (records a TIMEOUT incident)")
  .argument("<command...>", "command to execute")
  .action(async (commandArgs: string[], opts: { timeout?: string }) => {
    const { storage, config } = ctx();
    const timeoutMs = opts.timeout ? Number(opts.timeout) * 1000 : undefined;
    const outcome = await runCommand(commandArgs, {
      cwd: process.cwd(),
      config,
      storage,
      timeoutMs,
    });
    process.exit(outcome.exitCode);
  });

// ---------------------------------------------------------------- incident
const incident = program.command("incident").description("Inspect and manage incidents");

incident
  .command("list")
  .description("List incidents")
  .option("--format <format>", "output format: text | json", "text")
  .option("--all", "include resolved incidents")
  .action((opts: { format: string; all?: boolean }) => {
    const { storage } = ctx();
    let incidents = storage.readIncidents();
    if (!opts.all) incidents = incidents.filter((i) => i.status !== "resolved");
    if (opts.format === "json") {
      printJson({ schemaVersion: SCHEMA_VERSION, incidents: incidents.map(incidentSummary) });
      return;
    }
    if (incidents.length === 0) {
      console.log("No incidents.");
      return;
    }
    for (const i of incidents) {
      console.log(
        `${i.incidentId}  [${i.status}]${i.pinned ? " [pinned]" : ""}  ${i.errorType}  x${i.occurrenceCount}  last: ${i.lastSeenAt}  cmd: ${i.lastCommand}`,
      );
    }
  });

incident
  .command("show")
  .description("Show one incident in full detail")
  .argument("<id>")
  .option("--format <format>", "output format: text | json", "text")
  .option("--log-lines <n>", "how many trailing log lines to include", "50")
  .action((id: string, opts: { format: string; logLines: string }) => {
    const { storage, config } = ctx();
    const inc = storage.findIncident(id);
    if (!inc) {
      process.stderr.write(`Incident not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    const n = Math.max(0, Number(opts.logLines) || 50);
    const log = inc.logBlob ? storage.readLogBlob(inc.logBlob) : undefined;
    const logTail = log ? log.split("\n").slice(-n) : [];
    if (opts.format === "json") {
      printJson({ schemaVersion: SCHEMA_VERSION, incident: inc, logTail });
      return;
    }
    console.log(renderIncidentReport(inc, config.reportLanguage));
    if (logTail.length > 0) {
      console.log("## Log tail\n");
      console.log(logTail.join("\n"));
    }
  });

incident
  .command("report")
  .description("Regenerate the Markdown report for an incident")
  .argument("<id>")
  .action((id: string) => {
    const { storage, config } = ctx();
    const inc = storage.findIncident(id);
    if (!inc) {
      process.stderr.write(`Incident not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    const file = storage.writeReport(inc.incidentId, renderIncidentReport(inc, config.reportLanguage));
    console.log(file);
  });

incident
  .command("resolve")
  .description("Mark an incident as resolved")
  .argument("<id>")
  .action((id: string) => {
    const { storage } = ctx();
    const updated = setStatus(storage, id, "resolved");
    if (!updated) {
      process.stderr.write(`Incident not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`${updated.incidentId} resolved.`);
  });

incident
  .command("pin")
  .description("Pin an incident so it is never auto-pruned")
  .argument("<id>")
  .action((id: string) => {
    const { storage } = ctx();
    const updated = setPinned(storage, id, true);
    if (!updated) {
      process.stderr.write(`Incident not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`${updated.incidentId} pinned.`);
  });

// ---------------------------------------------------------------- collect
program
  .command("collect")
  .description("Start the local network-event collector (binds to 127.0.0.1 only)")
  .option("--port <port>", "port to listen on (default: config collector.port, 4319)")
  .action(async (opts: { port?: string }) => {
    const { storage, config } = ctx();
    const existing = storage.readCollectorLock();
    if (existing) {
      process.stderr.write(
        `Collector already running (pid ${existing.pid}, port ${existing.port}, ${existing.sessionId}).\n`,
      );
      process.exitCode = 1;
      return;
    }
    const collector = await startCollector({
      storage,
      config,
      port: parseCollectorPort(opts.port),
    });
    console.log(
      [
        `Dev Blackbox collector listening on http://127.0.0.1:${collector.port}`,
        `Session: ${collector.sessionId}`,
        `POST /events/network to record request/response events.`,
        `Press Ctrl+C to stop.`,
      ].join("\n"),
    );
    const shutdown = async () => {
      await collector.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// ---------------------------------------------------------------- network
const network = program.command("network").description("Inspect recorded network events");

network
  .command("list")
  .description("List recorded network events")
  .option("--format <format>", "output format: text | json", "text")
  .option("--limit <n>", "max events to show (newest last)", "50")
  .option("--trace <traceId>", "only events with this trace id")
  .option("--failed", "only failures")
  .action((opts: { format: string; limit: string; trace?: string; failed?: boolean }) => {
    const { storage } = ctx();
    let events = storage.readNetwork();
    if (opts.trace) events = events.filter((e) => e.traceId === opts.trace);
    if (opts.failed) {
      events = events.filter((e) => e.classification !== "success" && e.classification !== "slow_response");
    }
    events = events.slice(-Math.max(1, Number(opts.limit) || 50));
    if (opts.format === "json") {
      printJson({
        schemaVersion: SCHEMA_VERSION,
        events: events.map((e) => ({
          requestId: e.requestId,
          sessionId: e.sessionId,
          timestamp: e.timestamp,
          traceId: e.traceId,
          method: e.method,
          url: e.url,
          status: e.status,
          durationMs: e.durationMs,
          classification: e.classification,
        })),
      });
      return;
    }
    if (events.length === 0) {
      console.log("No network events.");
      return;
    }
    for (const e of events) {
      console.log(
        `${e.requestId}  ${e.timestamp.slice(11, 19)}  ${e.method} ${e.url}  ${e.status ?? "-"}  ${e.durationMs != null ? e.durationMs + "ms" : "-"}  ${e.classification}${e.traceId ? "  trace:" + e.traceId : ""}`,
      );
    }
  });

network
  .command("show")
  .description("Show one network event, including other events on the same trace")
  .argument("<requestId>")
  .option("--format <format>", "output format: text | json", "text")
  .action((requestId: string, opts: { format: string }) => {
    const { storage } = ctx();
    const event = storage.findNetwork(requestId);
    if (!event) {
      process.stderr.write(`Network event not found: ${requestId}\n`);
      process.exitCode = 1;
      return;
    }
    const trace = event.traceId
      ? storage.readNetwork().filter((e) => e.traceId === event.traceId && e.requestId !== event.requestId)
      : [];
    if (opts.format === "json") {
      printJson({ schemaVersion: SCHEMA_VERSION, event, trace });
      return;
    }
    printJson({ event, trace }); // detailed view is JSON either way; text mode adds no wrapper
  });

network
  .command("replay")
  .description("Replay a recorded request (idempotent methods by default) and compare responses")
  .argument("<requestId>")
  .option("--allow-unsafe", "allow replaying non-idempotent methods (POST/PUT/PATCH/DELETE)")
  .option("--base-url <url>", "base URL when the recorded URL is relative, e.g. http://127.0.0.1:8080")
  .option("--format <format>", "output format: text | json", "text")
  .action(async (requestId: string, opts: { allowUnsafe?: boolean; baseUrl?: string; format: string }) => {
    const { storage } = ctx();
    try {
      const result = await replayRequest(storage, requestId, {
        allowUnsafe: opts.allowUnsafe,
        baseUrl: opts.baseUrl,
      });
      if (opts.format === "json") {
        printJson(result);
        return;
      }
      console.log(
        [
          `Replayed ${result.method} ${result.targetUrl}`,
          `Status: ${result.before.status ?? "-"} -> ${result.after.status}${result.statusChanged ? " (changed)" : ""}`,
          result.bodyDiff.length > 0 ? `Body diff:\n  ${result.bodyDiff.join("\n  ")}` : "Body: unchanged",
          ...(result.resolveCandidate
            ? [`Incident ${result.resolveCandidate} marked as resolve candidate.`]
            : []),
        ].join("\n"),
      );
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------- mcp
program
  .command("mcp")
  .description("Run the MCP server over stdio (register with: claude mcp add dev-blackbox -- npx dev-blackbox mcp)")
  .action(async () => {
    const { storage, config } = ctx();
    await runMcpServer(storage, config);
  });

// Internal: Claude Code PreToolUse hook entry point (init --hooks claude-code).
program
  .command("claude-hook", { hidden: true })
  .action(async () => {
    await runClaudeHook();
  });

// ---------------------------------------------------------------- report
const report = program.command("report").description("Generate Markdown reports (regenerated views)");

report
  .command("network")
  .description("Regenerate reports/NETWORK.md from recent events")
  .option("--last <window>", "time window like 30m, 2h, 1d (default: all)")
  .action((opts: { last?: string }) => {
    const { storage, config } = ctx();
    let events = storage.readNetwork();
    if (opts.last) {
      const ms = parseWindow(opts.last);
      if (ms == null) {
        process.stderr.write(`Invalid window: ${opts.last} (use e.g. 30m, 2h, 1d)\n`);
        process.exitCode = 1;
        return;
      }
      const since = Date.now() - ms;
      events = events.filter((e) => Date.parse(e.receivedAt) >= since);
    }
    const file = storage.writeNetworkSummary(
      renderNetworkReport(events, { lang: config.reportLanguage }),
    );
    console.log(file);
  });

report
  .command("incident")
  .description("Alias of `incident report <id>`")
  .argument("<id>")
  .action((id: string) => {
    const { storage, config } = ctx();
    const inc = storage.findIncident(id);
    if (!inc) {
      process.stderr.write(`Incident not found: ${id}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(storage.writeReport(inc.incidentId, renderIncidentReport(inc, config.reportLanguage)));
  });

// ---------------------------------------------------------------- start / process
program
  .command("start")
  .description("Start a long-running process under supervision: dev-blackbox start --name api -- npm run dev")
  .passThroughOptions()
  .requiredOption("--name <name>", "process name")
  .argument("<command...>", "command to execute")
  .action((commandArgs: string[], opts: { name: string }) => {
    const { storage, config } = ctx();
    try {
      const meta = startProcess(storage, opts.name, commandArgs, cliScriptPath(), config);
      console.log(
        `Started '${meta.name}' (supervisor pid ${meta.supervisorPid})\n` +
          `Logs: npx dev-blackbox process logs ${meta.name}`,
      );
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
  });

const proc = program.command("process").description("Manage supervised long-running processes");

proc
  .command("list")
  .description("List supervised processes")
  .option("--format <format>", "output format: text | json", "text")
  .action((opts: { format: string }) => {
    const { storage } = ctx();
    const processes = listProcesses(storage);
    if (opts.format === "json") {
      printJson({ schemaVersion: SCHEMA_VERSION, processes });
      return;
    }
    if (processes.length === 0) {
      console.log("No supervised processes.");
      return;
    }
    for (const p of processes) {
      console.log(
        `${p.name}  [${p.alive ? "running" : p.status}]  pid:${p.childPid ?? p.supervisorPid}  started:${p.startedAt}` +
          `${p.exitCode != null ? `  exit:${p.exitCode}` : ""}${p.incidentId ? `  incident:${p.incidentId}` : ""}  cmd: ${p.command}`,
      );
    }
  });

proc
  .command("logs")
  .description("Show the tail of a supervised process log")
  .argument("<name>")
  .option("--lines <n>", "number of lines", "100")
  .action((name: string, opts: { lines: string }) => {
    const { storage } = ctx();
    const lines = readProcessLogs(storage, name, Math.max(1, Number(opts.lines) || 100));
    if (lines.length === 0) {
      console.log(`No logs for '${name}'.`);
      return;
    }
    console.log(lines.join("\n"));
  });

proc
  .command("stop")
  .description("Stop a supervised process")
  .argument("<name>")
  .action((name: string) => {
    const { storage } = ctx();
    try {
      const meta = stopProcess(storage, name);
      console.log(`Stopped '${meta.name}'.`);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    }
  });

// Internal: the detached supervisor entry point used by `start`.
proc
  .command("supervise", { hidden: true })
  .passThroughOptions()
  .argument("<name>")
  .argument("<command...>")
  .action(async (name: string, commandArgs: string[]) => {
    const { storage, config } = ctx();
    // Defensive: a leading "--" separator is not part of the command.
    const argv = commandArgs[0] === "--" ? commandArgs.slice(1) : commandArgs;
    const code = await superviseProcess(storage, config, name, argv);
    process.exit(code);
  });

function cliScriptPath(): string {
  return fileURLToPath(import.meta.url);
}

function parseWindow(window: string): number | undefined {
  const m = /^(\d+)(m|h|d)$/.exec(window.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60_000 : m[2] === "h" ? n * 3_600_000 : n * 86_400_000;
}

// ---------------------------------------------------------------- storage
const storageCmd = program.command("storage").description("Storage usage and cleanup");

storageCmd
  .command("status")
  .description("Show storage usage")
  .option("--format <format>", "output format: text | json", "text")
  .action((opts: { format: string }) => {
    const { storage, config } = ctx();
    const status = storageStatus(storage, config);
    if (opts.format === "json") {
      printJson(status);
      return;
    }
    console.log(
      [
        `Root: ${status.root}`,
        `Total: ${formatBytes(status.totalBytes)} / ${formatBytes(status.maxTotalBytes)}`,
        `Incidents: ${status.incidents.total} (open ${status.incidents.open}, candidates ${status.incidents.resolveCandidates}, resolved ${status.incidents.resolved}, pinned ${status.incidents.pinned})`,
        `Command records: ${status.commandRecords}`,
        `Blobs: ${formatBytes(status.blobBytes)}  Reports: ${formatBytes(status.reportBytes)}`,
      ].join("\n"),
    );
  });

storageCmd
  .command("prune")
  .description("Delete old data (never removes pinned or unresolved incidents)")
  .option("--older-than <days>", "override retention: remove eligible data older than N days")
  .action((opts: { olderThan?: string }) => {
    const { storage, config } = ctx();
    const days = opts.olderThan ? Number(String(opts.olderThan).replace(/d$/i, "")) : undefined;
    const result = prune(storage, config, { olderThanDays: days });
    console.log(
      `Pruned: ${result.removedSessionFiles} session file(s), ${result.removedIncidents} incident(s), ` +
        `${result.removedBlobs} blob(s), ${result.removedNetworkEvents} network event(s), ` +
        `${result.strippedNetworkBodies} network body(ies) stripped, ` +
        `${result.removedReports} stale report(s) removed.`,
    );
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`dev-blackbox: ${String(e)}\n`);
  process.exit(1);
});
