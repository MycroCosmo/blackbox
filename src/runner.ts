import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import stripAnsi from "strip-ansi";
import type { BlackboxConfig } from "./config.js";
import { detectSoftSignals } from "./detection.js";
import { markResolveCandidates, recordFailure } from "./incident.js";
import { writeIncidentReport } from "./report.js";
import { RingBuffer } from "./ring-buffer.js";
import { Redactor } from "./security.js";
import type { Storage } from "./storage.js";
import { SCHEMA_VERSION, type RunOutcome } from "./types.js";

/** Command runner (spec 4.1, 3.7).
 *
 *  Contract with the agent:
 *  - the child's stdout/stderr stream through to the terminal unchanged;
 *  - the child's exit code is propagated verbatim;
 *  - on failure, a machine-parsable incident summary is appended to stderr;
 *  - recorder errors NEVER affect the child command (spec 14).
 *
 *  Capture uses pipe (not pty): cleaner logs, no interactive support (4.1). */

export interface RunOptions {
  cwd: string;
  config: BlackboxConfig;
  storage: Storage;
  timeoutMs?: number;
  /** Suppress all terminal output (used by the MCP server, whose stdout is
   *  the JSON-RPC channel). Recording behavior is unchanged. */
  quiet?: boolean;
  /** MCP owns stdin as its JSON-RPC channel, so quiet/MCP runs must not pass
   *  that stream to the child. Defaults to ignore when quiet, inherit otherwise. */
  stdin?: "inherit" | "ignore";
}

/** Incrementally splits a byte stream into lines. */
class LineSplitter {
  private tail = "";
  push(chunk: Buffer): string[] {
    const parts = (this.tail + chunk.toString("utf8")).split(/\r?\n/);
    this.tail = parts.pop() ?? "";
    return parts;
  }
  flush(): string[] {
    if (this.tail === "") return [];
    const rest = this.tail;
    this.tail = "";
    return [rest];
  }
}

function spawnChild(
  argv: string[],
  cwd: string,
  stdin: "inherit" | "ignore",
): ChildProcess {
  const [cmd, ...args] = argv;
  return spawn(cmd!, args, {
    cwd,
    stdio: [stdin, "pipe", "pipe"],
    env: process.env,
  });
}

/** Windows fallback: .cmd/.bat shims (npm, gradlew.bat …) need a shell. */
function spawnViaShell(
  argv: string[],
  cwd: string,
  stdin: "inherit" | "ignore",
): ChildProcess {
  const quoted = argv
    .map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
    .join(" ");
  return spawn(quoted, {
    cwd,
    stdio: [stdin, "pipe", "pipe"],
    env: process.env,
    shell: true,
  });
}

export async function runCommand(argv: string[], opts: RunOptions): Promise<RunOutcome> {
  const { config, storage, cwd } = opts;
  const sessionId = storage.newSessionId();
  const redactor = new Redactor(config.security.redactBodyKeys);
  const commandString = redactor.redactCommand(argv);
  const stdin = opts.stdin ?? (opts.quiet ? "ignore" : "inherit");
  const buffer = new RingBuffer(config.ringBuffer);
  const startedAt = new Date();

  const capture = (stream: "stdout" | "stderr") => {
    const splitter = new LineSplitter();
    return {
      data: (chunk: Buffer) => {
        for (const line of splitter.push(chunk)) {
          buffer.push(redactor.redactStreamLine(stripAnsi(line)), stream);
        }
      },
      flush: () => {
        for (const line of splitter.flush()) {
          buffer.push(redactor.redactStreamLine(stripAnsi(line)), stream);
        }
      },
    };
  };

  const result = await new Promise<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    spawnError?: Error;
  }>((resolve) => {
    let child: ChildProcess;
    let usedShellFallback = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const out = capture("stdout");
    const err = capture("stderr");

    const attach = (c: ChildProcess) => {
      c.stdout?.on("data", (d: Buffer) => {
        if (c !== child) return;
        if (!opts.quiet) process.stdout.write(d);
        try {
          out.data(d);
        } catch {
          /* recorder must not break the run */
        }
      });
      c.stderr?.on("data", (d: Buffer) => {
        if (c !== child) return;
        if (!opts.quiet) process.stderr.write(d);
        try {
          err.data(d);
        } catch {
          /* recorder must not break the run */
        }
      });
      c.on("error", (e: NodeJS.ErrnoException) => {
        if (c !== child) return;
        // ENOENT on Windows often just means a .cmd shim — retry via shell.
        if (!usedShellFallback && process.platform === "win32" && e.code === "ENOENT") {
          usedShellFallback = true;
          child = spawnViaShell(argv, cwd, stdin);
          attach(child);
          return;
        }
        if (timer) clearTimeout(timer);
        resolve({ exitCode: 127, signal: null, timedOut: false, spawnError: e });
      });
      c.on("close", (code, signal) => {
        // Ignore events from a child that was superseded by the shell fallback.
        if (c !== child) return;
        if (timer) clearTimeout(timer);
        try {
          out.flush();
          err.flush();
        } catch {
          /* ignore */
        }
        resolve({ exitCode: code, signal: signal ?? null, timedOut });
      });
    };

    child = spawnChild(argv, cwd, stdin);
    attach(child);

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 3000).unref();
        } catch {
          /* already dead */
        }
      }, opts.timeoutMs);
      timer.unref();
    }
  });

  const endedAt = new Date();
  const exitCode = result.exitCode ?? (result.signal ? 1 : 0);
  const failed = result.timedOut || result.signal !== null || exitCode !== 0;

  let incidentId: string | undefined;
  let reportPath: string | undefined;
  let occurrenceCount = 1;
  let kind = "PROCESS_FAILURE";

  // Everything below is recording; a recorder bug must not change the
  // child's outcome, so it is wrapped as a whole.
  try {
    if (failed) {
      if (result.spawnError) {
        buffer.push(`spawn error: ${result.spawnError.message}`, "stderr");
      }
      const textLines = buffer.snapshot().map((l) => l.text);
      const soft = detectSoftSignals(textLines)[0];
      const incident = recordFailure(storage, {
        command: commandString,
        cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        softSignal: soft,
        logText: buffer
          .snapshot()
          .map((l) => `${new Date(l.at).toISOString()} [${l.stream}] ${l.text}`)
          .join("\n"),
      });
      incidentId = incident.incidentId;
      occurrenceCount = incident.occurrenceCount;
      kind = incident.kind;
      reportPath = writeIncidentReport(storage, incident.incidentId, config.reportLanguage);
    } else if (config.detection.softSignalIncident) {
      // Opt-in (spec 4.3): exit 0 + error pattern still records an incident.
      // The exit code stays 0 — the agent contract is never altered.
      const soft = detectSoftSignals(buffer.snapshot().map((l) => l.text))[0];
      if (soft) {
        const incident = recordFailure(storage, {
          command: commandString,
          cwd,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          softSignal: soft,
          logText: buffer
            .snapshot()
            .map((l) => `${new Date(l.at).toISOString()} [${l.stream}] ${l.text}`)
            .join("\n"),
        });
        incidentId = incident.incidentId;
        writeIncidentReport(storage, incident.incidentId, config.reportLanguage);
        if (!opts.quiet)
          process.stderr.write(
            `\n⚠ Soft-signal incident recorded (exit code 0): ${incident.incidentId}\n`,
          );
      } else {
        markResolveCandidates(storage, commandString, cwd);
      }
    } else {
      const marked = markResolveCandidates(storage, commandString, cwd);
      if (marked.length > 0 && !opts.quiet) {
        process.stderr.write(
          `\n✓ Command succeeded — resolve candidate: ${marked.map((m) => m.incidentId).join(", ")}\n` +
            `  Verify and run: npx dev-blackbox incident resolve <ID>\n`,
        );
      }
    }

    storage.appendCommand({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      command: commandString,
      cwd,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      incidentId,
    });
  } catch (e) {
    if (!opts.quiet)
      process.stderr.write(`dev-blackbox: recording failed (command result unaffected): ${String(e)}\n`);
  }

  if (failed && incidentId && !opts.quiet) {
    // Machine-parsable incident summary at the end of stderr (spec 3.7).
    const summary = [
      "",
      "✗ Command failed",
      "",
      `Incident: ${incidentId}`,
      `Type: ${kind}`,
      result.signal ? `Signal: ${result.signal}` : `Exit code: ${result.exitCode}`,
      ...(result.timedOut ? ["Timed out: true"] : []),
      `Occurrences: ${occurrenceCount}`,
      ...(reportPath && fs.existsSync(reportPath) ? [`Report: ${relForDisplay(reportPath, cwd)}`] : []),
      `Details: npx dev-blackbox incident show ${incidentId} --format json`,
      "",
    ].join("\n");
    process.stderr.write(summary);
  }

  return { exitCode, incidentId };
}

function relForDisplay(p: string, cwd: string): string {
  return p.startsWith(cwd) ? p.slice(cwd.length).replace(/^[\\/]/, "") : p;
}
