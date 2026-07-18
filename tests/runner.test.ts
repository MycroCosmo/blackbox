import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runCommand } from "../src/runner.js";
import { Storage } from "../src/storage.js";

/** Integration tests: spawn real node child processes in a temp directory
 *  (spec 14: 임시 디렉터리 기반 통합 테스트). */

let dir: string;
let storage: Storage;
const node = process.execPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbb-run-"));
  storage = new Storage(path.join(dir, ".dev-blackbox"));
  // Keep the child's tee'd output out of the test report.
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (args: string[], timeoutMs?: number) =>
  runCommand(args, { cwd: dir, config: DEFAULT_CONFIG, storage, timeoutMs });

describe("exit code propagation (spec 3.7)", () => {
  it("propagates 0 on success and records metadata only", async () => {
    const outcome = await run([node, "-e", "console.log('ok')"]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.incidentId).toBeUndefined();
    expect(storage.readIncidents()).toHaveLength(0);
    const [cmd] = storage.readCommands();
    expect(cmd?.exitCode).toBe(0);
    expect(cmd?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates 1 and creates an incident (first acceptance criterion)", async () => {
    const outcome = await run([
      node,
      "-e",
      "console.error('TypeError: test failure'); process.exit(1)",
    ]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.incidentId).toMatch(/^INC-\d{8}-\d{3}$/);
    const inc = storage.findIncident(outcome.incidentId!)!;
    expect(inc.errorType).toBe("TypeError");
    expect(inc.lastExitCode).toBe(1);
    // Report generated
    expect(fs.existsSync(path.join(storage.reportsDir, `${inc.incidentId}.md`))).toBe(true);
  });

  it("propagates arbitrary exit codes (137)", async () => {
    const outcome = await run([node, "-e", "process.exit(137)"]);
    expect(outcome.exitCode).toBe(137);
  });
});

describe("incident merging on re-run (second acceptance criterion)", () => {
  it("re-running the same failure increments occurrences, no new incident", async () => {
    const script = "console.error('TypeError: test failure'); process.exit(1)";
    const first = await run([node, "-e", script]);
    const second = await run([node, "-e", script]);
    expect(second.incidentId).toBe(first.incidentId);
    expect(storage.readIncidents()).toHaveLength(1);
    expect(storage.findIncident(first.incidentId!)?.occurrenceCount).toBe(2);
  });
});

describe("soft signals alone never create incidents (spec 4.3)", () => {
  it("exit 0 with error-looking output → no incident by default", async () => {
    const outcome = await run([
      node,
      "-e",
      "console.log('TypeError: this is intentional test output'); process.exit(0)",
    ]);
    expect(outcome.exitCode).toBe(0);
    expect(storage.readIncidents()).toHaveLength(0);
  });

  it("softSignalIncident opt-in records a SOFT_SIGNAL incident but keeps exit 0", async () => {
    const config = { ...DEFAULT_CONFIG, detection: { softSignalIncident: true } };
    const outcome = await runCommand(
      [node, "-e", "console.error('TypeError: logged but alive'); process.exit(0)"],
      { cwd: dir, config, storage },
    );
    expect(outcome.exitCode).toBe(0); // agent contract unchanged
    const [inc] = storage.readIncidents();
    expect(inc?.kind).toBe("SOFT_SIGNAL");
    expect(inc?.errorType).toBe("TypeError");
  });
});

describe("resolve candidate flow", () => {
  it("success of the same command marks the open incident (spec 4.4)", async () => {
    fs.writeFileSync(path.join(dir, "flaky.js"), "process.exit(1)", "utf8");
    const failing = await run([node, "flaky.js"]);
    expect(failing.incidentId).toBeDefined();
    fs.writeFileSync(path.join(dir, "flaky.js"), "process.exit(0)", "utf8");
    const passing = await run([node, "flaky.js"]);
    expect(passing.exitCode).toBe(0);
    expect(storage.findIncident(failing.incidentId!)?.status).toBe("resolve_candidate");
  });
});

describe("timeout handling", () => {
  it("kills a hanging command and records a TIMEOUT incident", async () => {
    const outcome = await run([node, "-e", "setInterval(() => {}, 1000)"], 500);
    expect(outcome.exitCode).not.toBe(0);
    const inc = storage.findIncident(outcome.incidentId!)!;
    expect(inc.kind).toBe("TIMEOUT");
    expect(inc.timedOut).toBe(true);
  }, 15_000);
});

describe("large output (spec 15: 대량 stdout)", () => {
  it("survives megabytes of output and keeps only the ring buffer tail", async () => {
    const outcome = await run([
      node,
      "-e",
      "for (let i=0;i<200000;i++) console.log('line '+i); console.error('TypeError: at the end'); process.exit(1)",
    ]);
    expect(outcome.exitCode).toBe(1);
    const inc = storage.findIncident(outcome.incidentId!)!;
    expect(inc.errorType).toBe("TypeError");
    const log = storage.readLogBlob(inc.logBlob!)!;
    expect(log.split("\n").length).toBeLessThanOrEqual(DEFAULT_CONFIG.ringBuffer.maxLines + 1);
    expect(log).toContain("TypeError: at the end");
  }, 30_000);
});

describe("secret masking end to end (spec 8)", () => {
  it("secrets printed by the child never reach the log blob", async () => {
    const outcome = await run([
      node,
      "-e",
      `console.error('password=hunter2'); console.error('TypeError: boom'); process.exit(1)`,
    ]);
    const inc = storage.findIncident(outcome.incidentId!)!;
    const log = storage.readLogBlob(inc.logBlob!)!;
    expect(log).not.toContain("hunter2");
    expect(log).toContain("[REDACTED]");
  });

  it("secrets passed as command arguments never reach metadata or reports", async () => {
    const outcome = await run([
      node,
      "-e",
      "process.exit(1)",
      "--",
      "--password",
      "hunter2",
      "--access-token=abc123",
    ]);
    const incident = storage.findIncident(outcome.incidentId!)!;
    const command = storage.readCommands()[0]!.command;
    const report = fs.readFileSync(path.join(storage.reportsDir, `${incident.incidentId}.md`), "utf8");
    for (const persisted of [command, incident.lastCommand, report]) {
      expect(persisted).not.toContain("hunter2");
      expect(persisted).not.toContain("abc123");
      expect(persisted).toContain("[REDACTED]");
    }
  });
});

describe("nonexistent command", () => {
  it("fails with a recorded incident instead of crashing", async () => {
    const outcome = await run(["definitely-not-a-real-command-xyz"]);
    expect(outcome.exitCode).not.toBe(0);
    expect(storage.readIncidents().length).toBeGreaterThanOrEqual(1);
  }, 15_000);
});
