import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import stripAnsi from "strip-ansi";
import type { BlackboxConfig } from "./config.js";
import { bestSoftSignal, RootCauseTracker, type RootCause } from "./detection.js";
import { markResolveCandidates, recordFailure } from "./incident.js";
import { cliCommand, detectInstall } from "./invocation.js";
import { writeIncidentReport } from "./report.js";
import { autoPrune } from "./retention.js";
import { RingBuffer, type BufferedLine } from "./ring-buffer.js";
import { Redactor } from "./security.js";
import type { Storage } from "./storage.js";
import { condenseOutput, type OutputMode } from "./condense.js";
import { formatFailureSummary } from "./summary.js";
import { SCHEMA_VERSION, type IncidentRecord, type RunOutcome } from "./types.js";
import { takeWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace.js";

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
  /** Environment for the child process. Defaults to the current environment. */
  env?: NodeJS.ProcessEnv;
  /** "compact" holds the output back and prints a condensed version when the
   *  command ends (see condense.ts). Defaults to "full" streaming. */
  output?: OutputMode;
}

/** Compact mode keeps at most this many lines for last-run.log. */
const COMPACT_MAX_LINES = 20_000;

/** Incrementally splits a byte stream into lines. */
class LineSplitter {
  private tail = "";
  private readonly decoder = new StringDecoder("utf8");

  push(chunk: Buffer): string[] {
    const parts = (this.tail + this.decoder.write(chunk)).split(/\r?\n/);
    this.tail = parts.pop() ?? "";
    return parts;
  }

  flush(): string[] {
    const rest = this.tail + this.decoder.end();
    this.tail = "";
    return rest === "" ? [] : [rest];
  }
}

function spawnChild(
  argv: string[],
  cwd: string,
  stdin: "inherit" | "ignore",
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const [cmd, ...args] = argv;
  return spawn(cmd!, args, {
    cwd,
    stdio: [stdin, "pipe", "pipe"],
    env,
  });
}

/** Windows fallback: .cmd/.bat shims (npm, gradlew.bat …) need a shell. */
function spawnViaShell(
  argv: string[],
  cwd: string,
  stdin: "inherit" | "ignore",
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const quoted = argv
    .map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
    .join(" ");
  return spawn(quoted, {
    cwd,
    stdio: [stdin, "pipe", "pipe"],
    env,
    shell: true,
  });
}

const STDERR_TAIL_HEADER =
  "--- earlier stderr (the rest of this window was evicted by later output) ---";
const ROOT_CAUSE_HEADER = (line: number) =>
  `--- root cause from earlier output (line ${line}; evicted from the window below) ---`;

/** Windows shells and command shims commonly create a child process of their
 * own. Killing only the shell leaves that descendant alive and keeps our pipe
 * handles open, so terminate the complete process tree on timeout. */
function terminateTimedOutChild(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    // spawnSync sets .error only when the spawn itself fails; a non-zero exit
    // (access denied, partially killed tree) still leaves the child alive, and
    // the run resolves on 'close' only — so fall through to the signal path.
    if (!result.error && result.status === 0) return;
  }
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 3000).unref();
}

export async function runCommand(argv: string[], opts: RunOptions): Promise<RunOutcome> {
  const { config, storage, cwd } = opts;
  const sessionId = storage.newSessionId();
  const commandString = new Redactor(config.security.redactBodyKeys).redactCommand(argv);
  const streamRedactors = {
    stdout: new Redactor(config.security.redactBodyKeys),
    stderr: new Redactor(config.security.redactBodyKeys),
  };
  const stdin = opts.stdin ?? (opts.quiet ? "ignore" : "inherit");
  const env = opts.env ?? process.env;
  const buffer = new RingBuffer(config.ringBuffer);
  // Keep a small stderr-only tail so heavy stdout cannot evict the actual
  // exception before the two OS pipes finish draining in nondeterministic order.
  const stderrTail: string[] = [];
  // Sees every line, including the ones the ring buffer later evicts.
  const rootCauseTracker = new RootCauseTracker();
  const startedAt = new Date();
  const compact = opts.output === "compact" && !opts.quiet;
  // Compact mode only: every line, in arrival order, for condensing and for
  // last-run.log. `compactDropped` counts lines trimmed from the front.
  const allLines: string[] = [];
  let compactDropped = 0;

  const capture = (stream: "stdout" | "stderr") => {
    const splitter = new LineSplitter();
    const redactor = streamRedactors[stream];
    const take = (line: string) => {
      const redacted = redactor.redactStreamLine(stripAnsi(line));
      buffer.push(redacted, stream);
      rootCauseTracker.push(redacted);
      if (stream === "stderr") {
        stderrTail.push(redacted);
        if (stderrTail.length > 200) stderrTail.shift();
      }
      if (compact) {
        allLines.push(redacted);
        if (allLines.length > COMPACT_MAX_LINES) {
          const drop = COMPACT_MAX_LINES / 4;
          allLines.splice(0, drop);
          compactDropped += drop;
        }
      }
    };
    return {
      data: (chunk: Buffer) => {
        for (const line of splitter.push(chunk)) take(line);
      },
      flush: () => {
        for (const line of splitter.flush()) take(line);
      },
    };
  };

  /** Stderr lines that heavy stdout already evicted from the ring buffer.
   *  They are reported as a separate, labelled section rather than pushed back
   *  into the buffer: a re-push would carry a fresh timestamp, land after
   *  unrelated later output, and evict yet another line. */
  const evictedStderrTail = (): string[] => {
    const present = new Set(
      buffer
        .snapshot()
        .filter((line) => line.stream === "stderr")
        .map((line) => line.text),
    );
    return stderrTail.filter((line) => !present.has(line));
  };

  const bufferLines = () => buffer.snapshot().map((l) => l.text);

  /** The root cause, when it scrolled out of the ring buffer window. */
  const evictedRootCause = (rc: RootCause | undefined): RootCause | undefined => {
    if (!rc) return undefined;
    const firstBuffered = rootCauseTracker.lines - buffer.size + 1;
    return rc.outputLine < firstBuffered ? rc : undefined;
  };

  const buildLogText = (rootCause?: RootCause): string => {
    const format = (l: BufferedLine) => `${new Date(l.at).toISOString()} [${l.stream}] ${l.text}`;
    const captured = buffer.snapshot();
    const evicted = evictedStderrTail();
    const early = evictedRootCause(rootCause);
    if (evicted.length === 0 && !early) return captured.map(format).join("\n");
    // Evicted lines are older than everything still buffered, so they lead.
    // The captured window gives up an equal number of its oldest lines: the
    // blob must stay within the configured ring-buffer budget (spec 4.2).
    let budget = Math.max(0, config.ringBuffer.maxLines);
    const sections: string[] = [];
    if (early && budget > early.excerpt.length + 1) {
      sections.push(ROOT_CAUSE_HEADER(early.outputLine), ...early.excerpt);
      budget -= early.excerpt.length + 1;
    }
    if (evicted.length > 0 && budget > 1) {
      const preserved = evicted.slice(-(budget - 1));
      sections.push(STDERR_TAIL_HEADER, ...preserved);
      budget -= preserved.length + 1;
    }
    return [...sections, ...(budget > 0 ? captured.slice(-budget).map(format) : [])].join("\n");
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
        if (!opts.quiet && !compact) process.stdout.write(d);
        try {
          out.data(d);
        } catch {
          /* recorder must not break the run */
        }
      });
      c.stderr?.on("data", (d: Buffer) => {
        if (c !== child) return;
        if (!opts.quiet && !compact) process.stderr.write(d);
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
          child = spawnViaShell(argv, cwd, stdin, env);
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

    child = spawnChild(argv, cwd, stdin, env);
    attach(child);

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          terminateTimedOutChild(child);
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
  let failedIncident: IncidentRecord | undefined;

  if (compact) {
    if (result.spawnError) allLines.push(`spawn error: ${result.spawnError.message}`);
    let fullLogPath: string | undefined;
    try {
      const file = `${storage.root}/last-run.log`;
      fs.mkdirSync(storage.root, { recursive: true });
      fs.writeFileSync(file, allLines.length ? `${allLines.join("\n")}\n` : "", "utf8");
      fullLogPath = relForDisplay(file, cwd);
    } catch {
      /* the excerpt still prints; only the pointer is lost */
    }
    try {
      const rc = failed ? rootCauseTracker.result() : undefined;
      process.stdout.write(
        condenseOutput({
          lines: allLines,
          failed,
          rootCauseIdx: rc ? rc.outputLine - 1 - compactDropped : undefined,
          fullLogPath,
        }),
      );
    } catch {
      /* never let condensing hide the result: fall back to the raw tail */
      process.stdout.write(`${allLines.slice(-50).join("\n")}\n`);
    }
  }

  // Everything below is recording; a recorder bug must not change the
  // child's outcome, so it is wrapped as a whole.
  try {
    if (failed) {
      if (result.spawnError) {
        buffer.push(`spawn error: ${result.spawnError.message}`, "stderr");
      }
      const soft = bestSoftSignal(bufferLines(), stderrTail);
      const rootCause = rootCauseTracker.result();
      const incident = recordFailure(storage, {
        command: commandString,
        cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        softSignal: soft,
        rootCause,
        workspace: safeSnapshot(cwd),
        logText: buildLogText(rootCause),
      });
      incidentId = incident.incidentId;
      failedIncident = incident;
      reportPath = writeIncidentReport(storage, incident.incidentId, config.reportLanguage);
    } else if (config.detection.softSignalIncident) {
      // Opt-in (spec 4.3): exit 0 + error pattern still records an incident.
      // The exit code stays 0 — the agent contract is never altered.
      const soft = bestSoftSignal(bufferLines(), stderrTail);
      if (soft) {
        const rootCause = rootCauseTracker.result();
        const incident = recordFailure(storage, {
          command: commandString,
          cwd,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          softSignal: soft,
          rootCause,
          workspace: safeSnapshot(cwd),
          logText: buildLogText(rootCause),
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
          `\n✓ Command succeeded — resolve candidate: ${marked.map((m) => m.incidentId).join(", ")}` +
            ` (reopens automatically if the failure returns)\n`,
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
    }, config.storage.maxSessionFiles);
  } catch (e) {
    if (!opts.quiet)
      process.stderr.write(`dev-blackbox: recording failed (command result unaffected): ${String(e)}\n`);
  }

  try {
    autoPrune(storage, config);
  } catch {
    /* automatic retention must never affect the child result */
  }

  if (failed && failedIncident && !opts.quiet) {
    // Machine-parsable incident summary at the end of stderr (spec 3.7).
    try {
      process.stderr.write(
        formatFailureSummary({
          incident: failedIncident,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          reportPath:
            reportPath && fs.existsSync(reportPath) ? relForDisplay(reportPath, cwd) : undefined,
          cli: cliCommand(detectInstall(cwd)),
        }),
      );
    } catch {
      /* the summary is advisory; never let it affect the child result */
    }
  }

  return { exitCode, incidentId };
}

/** Git state for "what changed since the last occurrence"; best effort. */
function safeSnapshot(cwd: string): WorkspaceSnapshot | undefined {
  try {
    return takeWorkspaceSnapshot(cwd);
  } catch {
    return undefined;
  }
}

function relForDisplay(p: string, cwd: string): string {
  return p.startsWith(cwd) ? p.slice(cwd.length).replace(/^[\\/]/, "") : p;
}
