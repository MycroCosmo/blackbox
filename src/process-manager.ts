import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import stripAnsi from "strip-ansi";
import { loadConfig, type BlackboxConfig } from "./config.js";
import { detectSoftSignals } from "./detection.js";
import { recordFailure } from "./incident.js";
import { writeIncidentReport } from "./report.js";
import { RingBuffer } from "./ring-buffer.js";
import { Redactor } from "./security.js";
import type { Storage } from "./storage.js";

/** Long-running process manager (spec 9: start / process list|logs|stop).
 *
 *  `start` launches a detached SUPERVISOR (this same CLI in `process
 *  supervise` mode). The supervisor runs the target command, tees its output
 *  to `.dev-blackbox/processes/<name>.log` (redacted, size-capped) and, when
 *  the process dies unexpectedly with a failure, records an incident exactly
 *  like `run` does. */

const MAX_LOG_BYTES = 10 * 1024 * 1024;

export interface ProcessMeta {
  schemaVersion: number;
  name: string;
  command: string;
  cwd: string;
  supervisorPid: number;
  childPid?: number;
  startedAt: string;
  status: "running" | "exited" | "stopped";
  exitCode?: number | null;
  signal?: string | null;
  endedAt?: string;
  incidentId?: string;
}

function metaFile(storage: Storage, name: string): string {
  return path.join(storage.processesDir, `${name}.json`);
}
function logFile(storage: Storage, name: string): string {
  return path.join(storage.processesDir, `${name}.log`);
}
function readMeta(storage: Storage, name: string): ProcessMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(metaFile(storage, name), "utf8"));
  } catch {
    return undefined;
  }
}
function writeMeta(storage: Storage, meta: ProcessMeta): void {
  storage.ensureDirs();
  fs.writeFileSync(metaFile(storage, meta.name), JSON.stringify(meta, null, 2), "utf8");
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function quoteForShell(argv: string[]): string {
  return argv
    .map((a) => (/[\s"^&|<>()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a))
    .join(" ");
}

/** Launches the detached supervisor and returns immediately. */
export function startProcess(
  storage: Storage,
  name: string,
  argv: string[],
  cliPath: string,
  config: BlackboxConfig = loadConfig(storage.root),
): ProcessMeta {
  if (!VALID_NAME.test(name)) throw new Error(`invalid process name: ${name}`);
  const existing = readMeta(storage, name);
  if (existing?.status === "running" && isAlive(existing.supervisorPid)) {
    throw new Error(`process '${name}' is already running (pid ${existing.childPid ?? existing.supervisorPid})`);
  }
  storage.ensureDirs();
  fs.writeFileSync(logFile(storage, name), "", "utf8"); // fresh log per start
  // No "--" separator here: with passThroughOptions, commander passes every
  // token after the name through verbatim — a "--" would reach the command.
  const child = spawn(
    process.execPath,
    [cliPath, "process", "supervise", name, ...argv],
    { cwd: process.cwd(), detached: true, stdio: "ignore" },
  );
  child.unref();
  const command = new Redactor(config.security.redactBodyKeys).redactCommand(argv);
  const meta: ProcessMeta = {
    schemaVersion: 1,
    name,
    command,
    cwd: process.cwd(),
    supervisorPid: child.pid!,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  writeMeta(storage, meta);
  return meta;
}

/** The supervisor body — runs inside the detached CLI process. */
export async function superviseProcess(
  storage: Storage,
  config: BlackboxConfig,
  name: string,
  argv: string[],
): Promise<number> {
  const redactor = new Redactor(config.security.redactBodyKeys);
  const command = redactor.redactCommand(argv);
  const buffer = new RingBuffer(config.ringBuffer);
  const log = logFile(storage, name);
  let loggedBytes = 0;
  let stopping = false;

  const appendLog = (line: string) => {
    try {
      const entry = `${new Date().toISOString()} ${line}\n`;
      fs.appendFileSync(log, entry, "utf8");
      loggedBytes += entry.length;
      if (loggedBytes > MAX_LOG_BYTES) {
        // Keep the newest half so the log never grows unbounded.
        const content = fs.readFileSync(log, "utf8");
        fs.writeFileSync(log, content.slice(content.length / 2), "utf8");
        loggedBytes = MAX_LOG_BYTES / 2;
      }
    } catch {
      /* log write failure must not kill the supervised process */
    }
  };

  // On Windows a shell is needed for .cmd shims (npm, gradlew.bat). Pass a
  // pre-quoted command string — spawn(cmd, args, {shell}) joins args without
  // quoting, which breaks paths containing spaces.
  const child =
    process.platform === "win32"
      ? spawn(quoteForShell(argv), {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
          shell: true,
        })
      : spawn(argv[0]!, argv.slice(1), {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });

  const meta = readMeta(storage, name);
  if (meta) writeMeta(storage, { ...meta, childPid: child.pid, supervisorPid: process.pid });

  const capture = (stream: "stdout" | "stderr") => {
    let tail = "";
    const record = (raw: string) => {
        const line = redactor.redactStreamLine(stripAnsi(raw));
        buffer.push(line, stream);
        appendLog(`[${stream}] ${line}`);
    };
    return {
      data: (chunk: Buffer) => {
        const parts = (tail + chunk.toString("utf8")).split(/\r?\n/);
        tail = parts.pop() ?? "";
        for (const raw of parts) record(raw);
      },
      flush: () => {
        if (tail === "") return;
        const raw = tail;
        tail = "";
        record(raw);
      },
    };
  };
  const stdout = capture("stdout");
  const stderr = capture("stderr");
  child.stdout?.on("data", stdout.data);
  child.stderr?.on("data", stderr.data);

  const stop = () => {
    stopping = true;
    try {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    } catch {
      /* already dead */
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  return new Promise<number>((resolve) => {
    child.on("close", (code, signal) => {
      stdout.flush();
      stderr.flush();
      const failed = !stopping && (code !== 0 || signal !== null);
      let incidentId: string | undefined;
      try {
        if (failed) {
          const textLines = buffer.snapshot().map((l) => l.text);
          const soft = detectSoftSignals(textLines)[0];
          const incident = recordFailure(storage, {
            command,
            cwd: process.cwd(),
            exitCode: code,
            signal: signal ?? null,
            timedOut: false,
            softSignal: soft,
            logText: buffer
              .snapshot()
              .map((l) => `${new Date(l.at).toISOString()} [${l.stream}] ${l.text}`)
              .join("\n"),
          });
          incidentId = incident.incidentId;
          writeIncidentReport(storage, incident.incidentId, config.reportLanguage);
          appendLog(`[dev-blackbox] process failed — incident ${incidentId}`);
        }
        const current = readMeta(storage, name);
        if (current) {
          writeMeta(storage, {
            ...current,
            status: stopping ? "stopped" : "exited",
            exitCode: code,
            signal: signal ?? null,
            endedAt: new Date().toISOString(),
            incidentId,
          });
        }
      } catch {
        /* recording failure must not affect supervisor exit */
      }
      resolve(code ?? 0);
    });
    child.on("error", (e) => {
      appendLog(`[dev-blackbox] spawn error: ${e.message}`);
      const current = readMeta(storage, name);
      if (current) {
        writeMeta(storage, { ...current, status: "exited", exitCode: 127, endedAt: new Date().toISOString() });
      }
      resolve(127);
    });
  });
}

export interface ProcessInfo extends ProcessMeta {
  alive: boolean;
}

export function listProcesses(storage: Storage): ProcessInfo[] {
  if (!fs.existsSync(storage.processesDir)) return [];
  const out: ProcessInfo[] = [];
  for (const f of fs.readdirSync(storage.processesDir)) {
    if (!f.endsWith(".json")) continue;
    const meta = readMeta(storage, path.basename(f, ".json"));
    if (!meta) continue;
    const alive = meta.status === "running" && isAlive(meta.supervisorPid);
    // Repair stale state: supervisor died without writing an exit record.
    if (meta.status === "running" && !alive) meta.status = "exited";
    out.push({ ...meta, alive });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readProcessLogs(storage: Storage, name: string, lines = 100): string[] {
  try {
    const content = fs.readFileSync(logFile(storage, name), "utf8");
    const all = content.split("\n").filter((l) => l !== "");
    return all.slice(-lines);
  } catch {
    return [];
  }
}

export function stopProcess(storage: Storage, name: string): ProcessMeta {
  const meta = readMeta(storage, name);
  if (!meta) throw new Error(`unknown process: ${name}`);
  if (meta.status !== "running" || !isAlive(meta.supervisorPid)) {
    throw new Error(`process '${name}' is not running`);
  }
  if (process.platform === "win32") {
    // Kill the whole tree (supervisor + child + grandchildren).
    spawnSync("taskkill", ["/PID", String(meta.supervisorPid), "/T", "/F"], { stdio: "ignore" });
  } else {
    // The supervisor traps SIGTERM, stops its child gracefully and records state.
    process.kill(meta.supervisorPid, "SIGTERM");
  }
  const updated: ProcessMeta = { ...meta, status: "stopped", endedAt: new Date().toISOString() };
  writeMeta(storage, updated);
  return updated;
}
