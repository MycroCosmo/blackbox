import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import type { NetworkRecord } from "./network.js";
import { SCHEMA_VERSION, type CommandRecord, type IncidentRecord } from "./types.js";

/** JSONL prototype storage (spec 6.1/6.2).
 *
 *  Each `run` process appends only to its own session file
 *  (`sessions/commands-<sessionId>.jsonl`). Incident read/modify/write
 *  transactions share a cross-process lock; updates append a full new record
 *  and the latest record per incidentId wins on read. */

export const BLACKBOX_DIR = ".dev-blackbox";
const INCIDENT_LOCK_TIMEOUT_MS = 10_000;
const INCIDENT_LOCK_STALE_MS = 30_000;
const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

export class Storage {
  readonly root: string;
  private incidentLockDepth = 0;
  private maintenanceLockDepth = 0;

  constructor(root: string) {
    this.root = root;
  }

  /** Finds an existing .dev-blackbox directory from cwd upward, or defaults
   *  to <cwd>/.dev-blackbox (created lazily on first write). */
  static discover(cwd: string): Storage {
    let dir = path.resolve(cwd);
    for (;;) {
      const candidate = path.join(dir, BLACKBOX_DIR);
      if (fs.existsSync(candidate)) return new Storage(candidate);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return new Storage(path.join(path.resolve(cwd), BLACKBOX_DIR));
  }

  get sessionsDir(): string {
    return path.join(this.root, "sessions");
  }
  get incidentsFile(): string {
    return path.join(this.root, "incidents.jsonl");
  }
  get blobsDir(): string {
    return path.join(this.root, "blobs", "logs");
  }
  get reportsDir(): string {
    return path.join(this.root, "reports", "incidents");
  }
  get networkReportsDir(): string {
    return path.join(this.root, "reports", "network");
  }
  get networkSummaryFile(): string {
    return path.join(this.root, "reports", "NETWORK.md");
  }
  get networkFile(): string {
    return path.join(this.root, "network.jsonl");
  }
  get processesDir(): string {
    return path.join(this.root, "processes");
  }
  get collectorLockFile(): string {
    return path.join(this.root, "collector.json");
  }
  get incidentsLockFile(): string {
    return path.join(this.root, ".incidents.lock");
  }
  get maintenanceLockFile(): string {
    return path.join(this.root, ".maintenance.lock");
  }
  get lastPruneFile(): string {
    return path.join(this.root, ".last-prune.json");
  }

  ensureDirs(): void {
    for (const d of [
      this.root,
      this.sessionsDir,
      this.blobsDir,
      this.reportsDir,
      this.networkReportsDir,
      this.processesDir,
    ]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  newSessionId(): string {
    return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  }

  appendCommand(record: CommandRecord): void {
    this.ensureDirs();
    const file = path.join(this.sessionsDir, `commands-${record.sessionId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  }

  readCommands(): CommandRecord[] {
    if (!fs.existsSync(this.sessionsDir)) return [];
    const out: CommandRecord[] = [];
    for (const f of fs.readdirSync(this.sessionsDir)) {
      if (!f.startsWith("commands-") || !f.endsWith(".jsonl")) continue;
      out.push(...readJsonl<CommandRecord>(path.join(this.sessionsDir, f)));
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Runs an incident read/modify/write transaction under a cross-process
   *  lock. The lock file is created with wx, which is atomic on supported
   *  filesystems. Nested calls on the same Storage instance are re-entrant. */
  withIncidentLock<T>(operation: () => T): T {
    if (this.incidentLockDepth > 0) return operation();
    this.ensureDirs();
    const deadline = Date.now() + INCIDENT_LOCK_TIMEOUT_MS;
    let fd: number | undefined;

    while (fd === undefined) {
      try {
        fd = fs.openSync(this.incidentsLockFile, "wx");
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          "utf8",
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (this.removeStaleIncidentLock()) continue;
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for incident storage lock: ${this.incidentsLockFile}`);
        }
        Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
      }
    }

    this.incidentLockDepth++;
    try {
      return operation();
    } finally {
      this.incidentLockDepth--;
      try {
        fs.closeSync(fd);
      } finally {
        try {
          fs.rmSync(this.incidentsLockFile);
        } catch {
          /* stale-lock cleanup or external deletion already removed it */
        }
      }
    }
  }

  /** Serializes retention and compaction across processes. Automatic
   * maintenance can use wait=false and cheaply skip when another prune owns
   * the lock; explicit maintenance waits for a deterministic result. */
  withMaintenanceLock<T>(operation: () => T, wait = true): T | undefined {
    if (this.maintenanceLockDepth > 0) return operation();
    this.ensureDirs();
    const deadline = Date.now() + INCIDENT_LOCK_TIMEOUT_MS;
    let fd: number | undefined;

    while (fd === undefined) {
      try {
        fd = fs.openSync(this.maintenanceLockFile, "wx");
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
          "utf8",
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (this.removeStaleLock(this.maintenanceLockFile)) continue;
        if (!wait) return undefined;
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for maintenance lock: ${this.maintenanceLockFile}`);
        }
        Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
      }
    }

    this.maintenanceLockDepth++;
    try {
      return operation();
    } finally {
      this.maintenanceLockDepth--;
      try {
        fs.closeSync(fd);
      } finally {
        try {
          fs.rmSync(this.maintenanceLockFile);
        } catch {
          /* stale-lock cleanup or external deletion already removed it */
        }
      }
    }
  }

  /** Appends a full incident record (create or update — latest wins). */
  appendIncident(record: IncidentRecord): void {
    this.withIncidentLock(() => {
      fs.appendFileSync(this.incidentsFile, JSON.stringify(record) + "\n", "utf8");
    });
  }

  /** Reads incidents merged by id: the last record written for an id wins. */
  readIncidents(): IncidentRecord[] {
    const byId = new Map<string, IncidentRecord>();
    for (const rec of readJsonl<IncidentRecord>(this.incidentsFile)) {
      if (rec && typeof rec.incidentId === "string") byId.set(rec.incidentId, rec);
    }
    return [...byId.values()].sort((a, b) => a.incidentId.localeCompare(b.incidentId));
  }

  findIncident(id: string): IncidentRecord | undefined {
    const wanted = id.toUpperCase();
    return this.readIncidents().find((i) => i.incidentId.toUpperCase() === wanted);
  }

  findIncidentByFingerprint(fingerprint: string): IncidentRecord | undefined {
    return this.readIncidents().find((i) => i.fingerprint === fingerprint);
  }

  /** INC-YYYYMMDD-NNN, numbered per day across existing incidents. */
  nextIncidentId(now = new Date()): string {
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `INC-${ymd}-`;
    let max = 0;
    for (const inc of this.readIncidents()) {
      if (inc.incidentId.startsWith(prefix)) {
        const n = Number(inc.incidentId.slice(prefix.length));
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return `${prefix}${String(max + 1).padStart(3, "0")}`;
  }

  /** Network events. The collector is the ONLY writer of this file while it
   *  runs — the 127.0.0.1 port bind acts as the writer lock (spec 6.1). */
  appendNetwork(record: NetworkRecord): void {
    this.ensureDirs();
    fs.appendFileSync(this.networkFile, JSON.stringify(record) + "\n", "utf8");
  }

  readNetwork(): NetworkRecord[] {
    return readJsonl<NetworkRecord>(this.networkFile).filter(
      (r) => r && typeof r.requestId === "string",
    );
  }

  findNetwork(requestId: string): NetworkRecord | undefined {
    const wanted = requestId.toUpperCase();
    return this.readNetwork().find((r) => r.requestId.toUpperCase() === wanted);
  }

  /** REQ-YYYYMMDD-NNN. Called once at collector startup; the collector then
   *  increments in memory (single writer). */
  nextRequestSeq(now = new Date()): { prefix: string; next: number } {
    const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `REQ-${ymd}-`;
    let max = 0;
    for (const r of this.readNetwork()) {
      if (r.requestId.startsWith(prefix)) {
        const n = Number(r.requestId.slice(prefix.length));
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    return { prefix, next: max + 1 };
  }

  compactNetwork(keep: NetworkRecord[]): void {
    this.ensureDirs();
    const tmp = this.networkFile + `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(
      tmp,
      keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""),
      "utf8",
    );
    fs.renameSync(tmp, this.networkFile);
  }

  readCollectorLock(): { pid: number; port: number; sessionId: string } | undefined {
    try {
      const lock = JSON.parse(fs.readFileSync(this.collectorLockFile, "utf8"));
      // Stale lock (collector crashed): ignore if the pid is gone.
      process.kill(lock.pid, 0);
      return lock;
    } catch {
      return undefined;
    }
  }

  writeCollectorLock(lock: { pid: number; port: number; sessionId: string; startedAt: string }): void {
    this.ensureDirs();
    fs.writeFileSync(this.collectorLockFile, JSON.stringify(lock), "utf8");
  }

  removeCollectorLock(): void {
    try {
      fs.rmSync(this.collectorLockFile);
    } catch {
      /* already gone */
    }
  }

  /** Stores gzipped log text; returns the blob path relative to root. */
  writeLogBlob(incidentId: string, text: string): string {
    this.ensureDirs();
    const name = `${incidentId}-${Date.now()}.log.gz`;
    fs.writeFileSync(path.join(this.blobsDir, name), zlib.gzipSync(text));
    return path.join("blobs", "logs", name);
  }

  readLogBlob(relPath: string): string | undefined {
    const file = path.join(this.root, relPath);
    try {
      return zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
    } catch {
      return undefined;
    }
  }

  writeReport(incidentId: string, markdown: string): string {
    this.ensureDirs();
    const file = path.join(this.reportsDir, `${incidentId}.md`);
    fs.writeFileSync(file, markdown, "utf8");
    return file;
  }

  writeNetworkSummary(markdown: string): string {
    this.ensureDirs();
    fs.writeFileSync(this.networkSummaryFile, markdown, "utf8");
    return this.networkSummaryFile;
  }

  writeNetworkEventReport(requestId: string, markdown: string): string {
    this.ensureDirs();
    const file = path.join(this.networkReportsDir, `${requestId}.md`);
    fs.writeFileSync(file, markdown, "utf8");
    return file;
  }

  /** Rewrites incidents.jsonl compacted to one record per id (used by prune). */
  compactIncidents(keep: IncidentRecord[]): void {
    this.withIncidentLock(() => {
      const tmp = this.incidentsFile + `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""), "utf8");
      fs.renameSync(tmp, this.incidentsFile);
    });
  }

  totalSizeBytes(): number {
    return dirSize(this.root);
  }

  private removeStaleIncidentLock(): boolean {
    return this.removeStaleLock(this.incidentsLockFile);
  }

  private removeStaleLock(lockFile: string): boolean {
    try {
      const stat = fs.statSync(lockFile);
      let ownerAlive: boolean | undefined;
      try {
        const data = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: unknown };
        if (typeof data.pid === "number") ownerAlive = processIsAlive(data.pid);
      } catch {
        /* a creator may still be writing; age check below handles true stale locks */
      }
      if (ownerAlive === false || (ownerAlive === undefined && Date.now() - stat.mtimeMs > INCIDENT_LOCK_STALE_MS)) {
        fs.rmSync(lockFile);
        return true;
      }
    } catch {
      return true; // disappeared between EEXIST and inspection
    }
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads a JSONL file, skipping corrupt lines (spec 15: 손상된 JSONL 복구). */
export function readJsonl<T>(file: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // corrupt line (e.g. torn write) — skip, never crash
    }
  }
  return out;
}

export function dirSize(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* file vanished mid-scan */
      }
    }
  }
  return total;
}

export { SCHEMA_VERSION };
