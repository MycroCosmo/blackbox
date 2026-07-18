import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { recordFailure, setStatus } from "../src/incident.js";
import { autoPrune, prune, storageStatus } from "../src/retention.js";
import { Storage, readJsonl } from "../src/storage.js";
import { SCHEMA_VERSION } from "../src/types.js";

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbb-store-"));
  storage = new Storage(path.join(dir, ".dev-blackbox"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readJsonl corruption recovery", () => {
  it("skips corrupt lines instead of crashing (spec 15)", () => {
    storage.ensureDirs();
    fs.writeFileSync(
      storage.incidentsFile,
      '{"incidentId":"INC-20260713-001","occurrenceCount":1}\n' +
        "{corrupt json!!!\n" +
        '{"incidentId":"INC-20260713-002","occurrenceCount":1}\n',
      "utf8",
    );
    expect(storage.readIncidents().map((i) => i.incidentId)).toEqual([
      "INC-20260713-001",
      "INC-20260713-002",
    ]);
  });
});

describe("session files (single-writer per run)", () => {
  it("each session writes its own file; reads merge all", () => {
    const base = {
      schemaVersion: SCHEMA_VERSION,
      command: "npm test",
      cwd: dir,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 5,
      exitCode: 0,
      signal: null,
      timedOut: false,
    };
    storage.appendCommand({ ...base, sessionId: "s1" });
    storage.appendCommand({ ...base, sessionId: "s2" });
    expect(fs.readdirSync(storage.sessionsDir).sort()).toEqual([
      "commands-s1.jsonl",
      "commands-s2.jsonl",
    ]);
    expect(storage.readCommands()).toHaveLength(2);
  });
});

describe("Storage.discover", () => {
  it("finds an existing .dev-blackbox in a parent directory", () => {
    storage.ensureDirs();
    const nested = path.join(dir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    expect(Storage.discover(nested).root).toBe(storage.root);
  });
});

const failure = {
  command: "npm test",
  cwd: ".",
  exitCode: 1,
  signal: null,
  timedOut: false,
  softSignal: undefined,
  logText: "boom",
};

describe("prune", () => {
  it("removes old resolved incidents but keeps pinned and unresolved ones", () => {
    const resolvedOld = recordFailure(storage, { ...failure, now: new Date("2026-01-01") });
    setStatus(storage, resolvedOld.incidentId, "resolved");
    // Backdate the resolved incident's lastSeenAt by rewriting compacted.
    const all = storage.readIncidents().map((i) =>
      i.incidentId === resolvedOld.incidentId
        ? { ...i, lastSeenAt: "2026-01-01T00:00:00.000Z", status: "resolved" as const }
        : i,
    );
    storage.compactIncidents(all);

    const open = recordFailure(storage, {
      ...failure,
      command: "npm run build",
      softSignal: {
        errorType: "BUILD_FAILURE",
        message: "BUILD FAILED",
        relatedFiles: [],
        excerpt: [],
      },
    });

    const result = prune(storage, DEFAULT_CONFIG, { now: new Date("2026-07-13") });
    expect(result.removedIncidents).toBe(1);
    const remaining = storage.readIncidents().map((i) => i.incidentId);
    expect(remaining).toEqual([open.incidentId]);
  });

  it("removes stale Markdown views with their expired records", () => {
    const incident = recordFailure(storage, { ...failure, now: new Date("2026-01-01") });
    storage.writeReport(incident.incidentId, "stale incident report");
    setStatus(storage, incident.incidentId, "resolved");
    storage.compactIncidents(
      storage.readIncidents().map((item) => ({
        ...item,
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      })),
    );
    const result = prune(storage, DEFAULT_CONFIG, { now: new Date("2026-07-13") });
    expect(result.removedIncidents).toBe(1);
    expect(result.removedReports).toBe(1);
    expect(fs.existsSync(path.join(storage.reportsDir, `${incident.incidentId}.md`))).toBe(false);
  });

  it("enforces the size cap using disposable session records first", () => {
    storage.appendCommand({
      schemaVersion: SCHEMA_VERSION,
      sessionId: "oversized",
      command: "npm test",
      cwd: dir,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    const config = { ...DEFAULT_CONFIG, storage: { maxTotalSizeMB: 0 } };
    const result = prune(storage, config);
    expect(result.removedSessionFiles).toBe(1);
    expect(storage.readCommands()).toHaveLength(0);
  });

  it("throttles automatic prune calls but allows a later maintenance pass", () => {
    const config = {
      ...DEFAULT_CONFIG,
      storage: { maxTotalSizeMB: 0 },
      retention: { ...DEFAULT_CONFIG.retention, autoPruneMinIntervalMinutes: 5 },
    };
    const append = (sessionId: string) => storage.appendCommand({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      command: "npm test",
      cwd: dir,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });

    append("first");
    expect(autoPrune(storage, config, { now: new Date("2026-07-18T00:00:00Z") }).removedSessionFiles).toBe(1);
    append("second");
    expect(autoPrune(storage, config, { now: new Date("2026-07-18T00:01:00Z") }).removedSessionFiles).toBe(0);
    expect(storage.readCommands()).toHaveLength(1);
    expect(autoPrune(storage, config, { now: new Date("2026-07-18T00:06:00Z") }).removedSessionFiles).toBe(1);
  });

  it("skips automatic prune when another maintenance owner holds the lock", () => {
    storage.appendCommand({
      schemaVersion: SCHEMA_VERSION,
      sessionId: "locked",
      command: "npm test",
      cwd: dir,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    const other = new Storage(storage.root);
    storage.withMaintenanceLock(() => {
      const result = autoPrune(other, { ...DEFAULT_CONFIG, storage: { maxTotalSizeMB: 0 } });
      expect(result.removedSessionFiles).toBe(0);
      expect(other.readCommands()).toHaveLength(1);
    });
  });

  it("serializes concurrent cross-process prune operations", async () => {
    storage.ensureDirs();
    const records = Array.from({ length: 100 }, (_, index) => ({
      schemaVersion: 1,
      requestId: `REQ-20260718-${String(index + 1).padStart(3, "0")}`,
      sessionId: "SESSION-concurrent",
      receivedAt: "2026-07-18T00:00:00.000Z",
      timestamp: "2026-07-18T00:00:00.000Z",
      method: "GET",
      url: `/api/items/${index}`,
      status: 500,
      classification: "http_error",
    }));
    fs.writeFileSync(storage.networkFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    const barrier = path.join(dir, "prune-barrier");
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const fixture = path.resolve("tests", "fixtures", "concurrent-prune.ts");
    const workers = Array.from({ length: 4 }, (_, index) => {
      const child = spawn(process.execPath, [tsxCli, fixture, storage.root, barrier, String(index)], {
        cwd: dir,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      return new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`prune worker ${index} exited ${code}: ${stderr}`)),
        );
      });
    });

    try {
      const deadline = Date.now() + 10_000;
      while (
        workers.some((_, index) => !fs.existsSync(`${barrier}.${index}.ready`)) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(workers.every((_, index) => fs.existsSync(`${barrier}.${index}.ready`))).toBe(true);
    } finally {
      fs.writeFileSync(barrier, "go", "utf8");
    }
    await Promise.all(workers);

    expect(storage.readNetwork()).toHaveLength(100);
    expect(fs.existsSync(storage.maintenanceLockFile)).toBe(false);
    expect(fs.readdirSync(storage.root).some((name) => name.startsWith("network.jsonl.tmp-"))).toBe(false);
  }, 30_000);

  it("removes orphaned blobs", () => {
    storage.ensureDirs();
    fs.writeFileSync(path.join(storage.blobsDir, "orphan-1.log.gz"), "x");
    const result = prune(storage, DEFAULT_CONFIG);
    expect(result.removedBlobs).toBe(1);
  });
});

describe("storageStatus", () => {
  it("reports counts and sizes", () => {
    recordFailure(storage, failure);
    const status = storageStatus(storage, DEFAULT_CONFIG);
    expect(status.incidents.total).toBe(1);
    expect(status.incidents.open).toBe(1);
    expect(status.totalBytes).toBeGreaterThan(0);
    expect(status.schemaVersion).toBe(1);
  });
});

describe("jsonl sanity", () => {
  it("appended incidents are valid one-per-line json", () => {
    recordFailure(storage, failure);
    recordFailure(storage, failure);
    const rows = readJsonl<{ incidentId: string }>(storage.incidentsFile);
    expect(rows).toHaveLength(2); // append-only: create + update
    expect(storage.readIncidents()).toHaveLength(1); // merged view
  });

  it("serializes concurrent incident creation and occurrence updates", async () => {
    const barrier = path.join(dir, "incident-barrier");
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const fixture = path.resolve("tests", "fixtures", "concurrent-failure.ts");
    const commands = [
      "repeat",
      "repeat",
      "repeat",
      "repeat",
      "unique-alpha",
      "unique-bravo",
      "unique-charlie",
      "unique-delta",
    ];

    const exits = commands.map((command, index) => {
      const workerId = String(index);
      const child = spawn(
        process.execPath,
        [tsxCli, fixture, storage.root, barrier, workerId, command],
        { cwd: dir, stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      return new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`worker ${workerId} exited ${code}: ${stderr}`)),
        );
      });
    });

    try {
      const deadline = Date.now() + 10_000;
      while (
        commands.some((_, index) => !fs.existsSync(`${barrier}.${index}.ready`)) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(commands.every((_, index) => fs.existsSync(`${barrier}.${index}.ready`))).toBe(true);
    } finally {
      fs.writeFileSync(barrier, "go", "utf8");
    }
    await Promise.all(exits);

    const incidents = storage.readIncidents();
    expect(incidents).toHaveLength(5);
    expect(new Set(incidents.map((incident) => incident.incidentId)).size).toBe(5);
    expect(incidents.find((incident) => incident.lastCommand === "repeat")?.occurrenceCount).toBe(4);
  }, 30_000);
});
