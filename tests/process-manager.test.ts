import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  listProcesses,
  readProcessLogs,
  startProcess,
  stopProcess,
  superviseProcess,
} from "../src/process-manager.js";
import { Storage } from "../src/storage.js";

let dir: string;
let storage: Storage;
const node = process.execPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbb-proc-"));
  storage = new Storage(path.join(dir, ".dev-blackbox"));
  storage.ensureDirs();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function seedMeta(name: string, pid: number, status = "running"): void {
  fs.writeFileSync(
    path.join(storage.processesDir, `${name}.json`),
    JSON.stringify({
      schemaVersion: 1,
      name,
      command: "dummy",
      cwd: dir,
      supervisorPid: pid,
      startedAt: new Date().toISOString(),
      status,
    }),
    "utf8",
  );
}

describe("superviseProcess", () => {
  it("captures output to the log file and records no incident on clean exit", async () => {
    seedMeta("ok", process.pid);
    const code = await superviseProcess(storage, DEFAULT_CONFIG, "ok", [
      node,
      "-e",
      "console.log('server ready'); console.log('password=secret1')",
    ]);
    expect(code).toBe(0);
    const logs = readProcessLogs(storage, "ok");
    expect(logs.join("\n")).toContain("server ready");
    expect(logs.join("\n")).not.toContain("secret1"); // redacted before disk
    expect(storage.readIncidents()).toHaveLength(0);
    expect(listProcesses(storage)[0]).toMatchObject({ name: "ok", status: "exited", exitCode: 0 });
  }, 20_000);

  it("records an incident when the process crashes (spec 4.3 hard signal)", async () => {
    seedMeta("crashy", process.pid);
    const code = await superviseProcess(storage, DEFAULT_CONFIG, "crashy", [
      node,
      "-e",
      "console.error('TypeError: dev server exploded'); process.exit(1)",
    ]);
    expect(code).toBe(1);
    const incidents = storage.readIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.errorType).toBe("TypeError");
    expect(listProcesses(storage)[0]).toMatchObject({
      status: "exited",
      exitCode: 1,
      incidentId: incidents[0]!.incidentId,
    });
  }, 20_000);

  it("flushes and detects the final error line even without a newline", async () => {
    seedMeta("tail", process.pid);
    const code = await superviseProcess(storage, DEFAULT_CONFIG, "tail", [
      node,
      "-e",
      "process.stderr.write('TypeError: unterminated failure'); process.exit(1)",
    ]);
    expect(code).toBe(1);
    expect(readProcessLogs(storage, "tail").join("\n")).toContain("TypeError: unterminated failure");
    expect(storage.readIncidents()[0]).toMatchObject({
      errorType: "TypeError",
      message: "unterminated failure",
    });
  }, 20_000);
});

describe("listProcesses / stopProcess", () => {
  it("redacts command arguments before writing process metadata", async () => {
    const fakeCli = path.join(dir, "fake-cli.cjs");
    fs.writeFileSync(fakeCli, "process.exit(0)", "utf8");
    const meta = startProcess(
      storage,
      "secret-meta",
      [node, "-e", "process.exit(0)", "--", "--password", "hunter2"],
      fakeCli,
      DEFAULT_CONFIG,
    );
    expect(meta.command).not.toContain("hunter2");
    expect(meta.command).toContain("[REDACTED]");
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it("shows a live supervisor as running and stops it", async () => {
    // Stand-in supervisor: a real long-running process we control.
    const child = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      seedMeta("api", child.pid!);
      const [info] = listProcesses(storage);
      expect(info).toMatchObject({ name: "api", status: "running", alive: true });

      const stopped = stopProcess(storage, "api");
      expect(stopped.status).toBe("stopped");
      await new Promise((r) => setTimeout(r, 1500));
      expect(listProcesses(storage)[0]!.alive).toBe(false);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already stopped */
      }
    }
  }, 20_000);

  it("repairs stale state when the supervisor died without cleanup", () => {
    seedMeta("ghost", 999_999_999);
    const [info] = listProcesses(storage);
    expect(info!.alive).toBe(false);
    expect(info!.status).toBe("exited");
  });

  it("rejects stop for unknown or dead processes", () => {
    expect(() => stopProcess(storage, "nope")).toThrow(/unknown process/);
    seedMeta("dead", 999_999_999);
    expect(() => stopProcess(storage, "dead")).toThrow(/not running/);
  });
});
