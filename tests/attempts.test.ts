import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { RootCauseTracker } from "../src/detection.js";
import { detectInstall } from "../src/invocation.js";
import { runCommand } from "../src/runner.js";
import { Storage } from "../src/storage.js";
import { formatFailureSummary, localTime } from "../src/summary.js";
import type { IncidentRecord } from "../src/types.js";
import { changedFiles, takeWorkspaceSnapshot } from "../src/workspace.js";

/** "Is the agent going in circles?" — root cause beyond the log window,
 *  file changes between occurrences, and the summary that reports both. */

let dir: string;
let storage: Storage;
let stderr: string[];
const node = process.execPath;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dbb-att-")));
  storage = new Storage(path.join(dir, ".dev-blackbox"));
  stderr = [];
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function git(...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function initRepo(files: Record<string, string>): void {
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
}

const lastSummary = () => stderr.filter((s) => s.includes("✗ Command failed")).at(-1) ?? "";

/** Gradle --info with exceptionFormat 'full': the real cause once, then a
 *  wall of follow-up failures. */
const NOISY_SPRING_LOG = [
  "> Task :test",
  "PricingPropertiesTest > loadsVatRate() FAILED",
  "    java.lang.IllegalStateException: Failed to load ApplicationContext for [WebMergedContextConfiguration@1a2b3c]",
  "        at org.springframework.test.context.cache.DefaultCacheAwareContextLoaderDelegate.loadContext(DefaultCacheAwareContextLoaderDelegate.java:180)",
  "        at org.junit.jupiter.engine.execution.InvocationInterceptorChain.proceed(InvocationInterceptorChain.java:64)",
  "",
  "        Caused by:",
  "        org.springframework.boot.context.properties.bind.BindException: Failed to bind properties under 'pricing.vat-rate' to java.math.BigDecimal",
  "            at org.springframework.boot.context.properties.bind.Binder.handleBindError(Binder.java:392)",
  "",
  "            Caused by:",
  "            java.lang.NumberFormatException: Character % is neither a decimal digit number, decimal point, nor \"e\" notation exponential mark.",
  "                at java.base/java.math.BigDecimal.<init>(BigDecimal.java:608)",
  "                at com.example.pricing.PricingProperties.setVatRate(PricingProperties.java:21)",
  "                ... 87 more",
];
const NOISE_BLOCK = [
  "PriceCalculatorTest > addsVatAndRounds() FAILED",
  "    java.lang.IllegalStateException: ApplicationContext failure threshold (1) exceeded: skipping repeated attempt to load context",
  "        at org.springframework.test.context.cache.DefaultCacheAwareContextLoaderDelegate.loadContext(DefaultCacheAwareContextLoaderDelegate.java:145)",
  "        at org.junit.jupiter.engine.execution.InvocationInterceptorChain.proceed(InvocationInterceptorChain.java:64)",
];

describe("RootCauseTracker", () => {
  it("follows the first exception chain to its deepest cause", () => {
    const t = new RootCauseTracker();
    for (const line of NOISY_SPRING_LOG) t.push(line);
    for (let i = 0; i < 500; i++) for (const line of NOISE_BLOCK) t.push(line);
    const rc = t.result()!;
    expect(rc.errorType).toBe("NumberFormatException");
    expect(rc.message).toContain("Character %");
    expect(rc.outputLine).toBe(12);
    expect(rc.depth).toBe(2);
    expect(rc.location).toMatchObject({ file: "PricingProperties.java", line: 21 });
    expect(rc.excerpt[0]).toContain("java.lang.NumberFormatException: Character %");
  });

  it("reads inline Java causes", () => {
    const t = new RootCauseTracker();
    t.push('Exception in thread "main" java.lang.RuntimeException: wrapper');
    t.push("\tat com.example.Main.run(Main.java:10)");
    t.push("Caused by: java.io.FileNotFoundException: config.yml (No such file or directory)");
    t.push("\tat com.example.Config.load(Config.java:7)");
    expect(t.result()).toMatchObject({
      errorType: "FileNotFoundException",
      location: { file: "Config.java", line: 7 },
    });
  });

  it("locates Vitest assertion failures by their code frame", async () => {
    const { detectSoftSignals } = await import("../src/detection.js");
    const [signal] = detectSoftSignals([
      " ❯ test/pricing.test.ts (6 tests | 3 failed) 23ms",
      " FAIL  test/pricing.test.ts > cart > summarizes item count and total",
      "AssertionError: expected '3 items · $4,997' to be '3 items · $49.97' // Object.is equality",
      "",
      "- Expected",
      "+ Received",
      "",
      " ❯ test/pricing.test.ts:23:32",
    ]);
    expect(signal).toMatchObject({
      errorType: "AssertionError",
      location: { file: "test/pricing.test.ts", line: 23 },
    });
  });

  it("recognizes the JVM's uncaught-exception line in soft signals too", async () => {
    const { detectSoftSignals } = await import("../src/detection.js");
    const [signal] = detectSoftSignals([
      'Exception in thread "main" java.lang.IllegalStateException: boom',
      "\tat com.example.Main.main(Main.java:5)",
    ]);
    expect(signal).toMatchObject({ errorType: "IllegalStateException", message: "boom" });
  });

  it("does not attach causes from a later, unrelated exception", () => {
    const t = new RootCauseTracker();
    t.push("TypeError: first failure");
    t.push("    at main (src/app.ts:3:1)");
    for (let i = 0; i < 10; i++) t.push("ordinary output");
    t.push("java.lang.IllegalStateException: second failure");
    t.push("Caused by: java.lang.NumberFormatException: belongs to the second failure");
    const rc = t.result()!;
    expect(rc.errorType).toBe("TypeError");
    expect(rc.depth).toBe(0);
  });
});

describe("root cause beyond the ring-buffer window", () => {
  it("records and reports a cause that scrolled out of the captured log", async () => {
    const script = path.join(dir, "noisy.cjs");
    fs.writeFileSync(
      script,
      `const head = ${JSON.stringify(NOISY_SPRING_LOG)};
       const noise = ${JSON.stringify(NOISE_BLOCK)};
       console.log(head.join("\\n"));
       for (let i = 0; i < 600; i++) console.log(noise.join("\\n"));
       process.exit(1);`,
    );
    const config = { ...DEFAULT_CONFIG, ringBuffer: { ...DEFAULT_CONFIG.ringBuffer, maxLines: 200 } };
    const outcome = await runCommand([node, script], { cwd: dir, config, storage });
    const inc = storage.findIncident(outcome.incidentId!)!;

    expect(inc.errorType).toBe("IllegalStateException"); // what the tail shows
    expect(inc.rootCause).toMatchObject({ errorType: "NumberFormatException", outputLine: 12 });
    expect(inc.rootCause!.excerpt![0]).toContain("Character %");

    const log = storage.readLogBlob(inc.logBlob!)!;
    expect(log.split("\n")[0]).toMatch(/^--- root cause from earlier output \(line 12/);
    expect(log).toContain("Character % is neither");
    expect(log.split("\n").length).toBeLessThanOrEqual(200);

    expect(lastSummary()).toMatch(
      /Earliest cause \(output line 12\): NumberFormatException: Character %.* at PricingProperties\.java:21/,
    );
  });
});

describe("changes between occurrences", () => {
  const failing = `const fs = require("fs");
    const v = fs.readFileSync(__dirname + "/value.txt", "utf8").trim();
    if (v !== "ok") { console.error("TypeError: value was " + "not ok"); process.exit(1); }`;

  it("lists the files edited between failing runs, or says nothing changed", async () => {
    initRepo({ "check.cjs": failing, "value.txt": "bad\n", "other.txt": "x\n" });
    const run = () => runCommand([node, "check.cjs"], { cwd: dir, config: DEFAULT_CONFIG, storage });

    const first = await run();
    expect(lastSummary()).toContain("Occurrences: 1");

    fs.writeFileSync(path.join(dir, "value.txt"), "still bad\n");
    await run();
    let inc = storage.findIncident(first.incidentId!)!;
    expect(inc.occurrenceCount).toBe(2);
    expect(inc.attempts).toEqual([
      expect.objectContaining({ occurrence: 2, changedFiles: ["value.txt"] }),
    ]);
    expect(lastSummary()).toContain("this failure happened before");
    expect(lastSummary()).toContain("#1 → #2: changed value.txt — same failure");

    await run();
    inc = storage.findIncident(first.incidentId!)!;
    expect(inc.attempts!.at(-1)).toMatchObject({ occurrence: 3, changedFiles: [] });
    expect(lastSummary()).toContain("#2 → #3: no file changes — re-run without edits");

    // A commit in between is a change too; the working tree is clean afterwards.
    fs.writeFileSync(path.join(dir, "other.txt"), "y\n");
    git("add", "-A");
    git("commit", "-q", "-m", "attempt");
    await run();
    inc = storage.findIncident(first.incidentId!)!;
    // value.txt was dirty ("still bad") before and is now committed with the
    // same content, so only other.txt counts as changed.
    expect(inc.attempts!.at(-1)!.changedFiles).toEqual(["other.txt"]);

    // The snapshot is internal bookkeeping and stays out of agent-facing JSON.
    const { publicIncident } = await import("../src/incident.js");
    expect(publicIncident(inc)).not.toHaveProperty("lastWorkspace");
  });

  it("reports unknown changes outside a git repository", async () => {
    fs.writeFileSync(path.join(dir, "check.cjs"), failing);
    fs.writeFileSync(path.join(dir, "value.txt"), "bad\n");
    const run = () => runCommand([node, "check.cjs"], { cwd: dir, config: DEFAULT_CONFIG, storage });
    await run();
    const second = await run();
    const inc = storage.findIncident(second.incidentId!)!;
    expect(inc.attempts).toEqual([expect.objectContaining({ changedFiles: null })]);
  });
});

describe("workspace snapshots", () => {
  it("ignores .dev-blackbox and detects reverts to HEAD", () => {
    initRepo({ "a.txt": "1\n" });
    fs.mkdirSync(path.join(dir, ".dev-blackbox"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".dev-blackbox", "x.json"), "{}");
    fs.writeFileSync(path.join(dir, "a.txt"), "2\n");
    const dirty = takeWorkspaceSnapshot(dir)!;
    expect(Object.keys(dirty.files)).toEqual(["a.txt"]);

    git("checkout", "--", "a.txt");
    const clean = takeWorkspaceSnapshot(dir)!;
    expect(clean.files).toEqual({});
    expect(changedFiles(dir, dirty, clean)).toEqual(["a.txt"]);
    expect(changedFiles(dir, clean, takeWorkspaceSnapshot(dir)!)).toEqual([]);
  });

  it("returns undefined outside git", () => {
    expect(takeWorkspaceSnapshot(dir)).toBeUndefined();
  });
});

describe("failure summary", () => {
  const base: IncidentRecord = {
    schemaVersion: 1,
    incidentId: "INC-20261005-001",
    fingerprint: "f",
    kind: "PROCESS_FAILURE",
    errorType: "NullPointerException",
    message: "Cannot invoke \"Address.getCity()\" because \"address\" is null",
    status: "open",
    pinned: false,
    firstSeenAt: "2026-10-05T10:00:00.000Z",
    lastSeenAt: "2026-10-05T10:05:00.000Z",
    occurrenceCount: 1,
    lastCommand: "./gradlew test",
    lastCwd: "/p",
    lastExitCode: 1,
    lastSignal: null,
    timedOut: false,
    lastLocation: { file: "ShippingLabelService.java", line: 14, function: "labelFor" },
    relatedFiles: [],
    facts: [],
    hypotheses: [],
  };
  const summary = (inc: Partial<IncidentRecord>) =>
    formatFailureSummary({
      incident: { ...base, ...inc },
      exitCode: 1,
      signal: null,
      timedOut: false,
      cli: "npx dev-blackbox",
    });

  it("states the error and its location inline", () => {
    const s = summary({});
    expect(s).toContain('Error: NullPointerException: Cannot invoke "Address.getCity()"');
    expect(s).toContain("At: ShippingLabelService.java:14 (labelFor)");
    expect(s).toContain("Occurrences: 1");
    expect(s).toContain("Details: npx dev-blackbox incident show INC-20261005-001 --format json");
    expect(s).not.toContain("Earliest cause");
  });

  it("shows the newest attempts first and caps long file lists", () => {
    const s = summary({
      occurrenceCount: 5,
      attempts: [
        { occurrence: 2, at: "", changedFiles: ["old.java"] },
        { occurrence: 3, at: "", changedFiles: ["a", "b", "c", "d", "e", "f"], changedCount: 30 },
        { occurrence: 4, at: "", changedFiles: [] },
        { occurrence: 5, at: "", changedFiles: ["CustomerMapper.java"] },
      ],
    });
    const lines = s.split("\n");
    const at = lines.findIndex((l) =>
      l.startsWith(`Occurrences: 5 (first seen ${localTime(base.firstSeenAt)})`),
    );
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 4)).toEqual([
      "  #4 → #5: changed CustomerMapper.java — same failure",
      "  #3 → #4: no file changes — re-run without edits",
      "  #2 → #3: changed a, b, c, d, e (+25 more) — same failure",
    ]);
    expect(s).not.toContain("old.java");
  });

  it("omits Error for incidents without a detected exception", () => {
    expect(summary({ errorType: "PROCESS_FAILURE", message: "Command failed: x", lastLocation: undefined }))
      .not.toContain("Error:");
  });
});

describe("install detection", () => {
  it("distinguishes local, npx-cache, and global installs", () => {
    const project = path.join(dir, "proj");
    fs.mkdirSync(project);
    const globalCli = path.join(dir, "npm-global", "node_modules", "dev-blackbox", "dist", "cli.js");
    const npxCli = path.join(dir, "cache", "_npx", "abc", "node_modules", "dev-blackbox", "dist", "cli.js");
    expect(detectInstall(project, globalCli)).toBe("global");
    expect(detectInstall(project, npxCli)).toBe("npx");

    const local = path.join(project, "node_modules", "dev-blackbox");
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, "package.json"), "{}");
    expect(detectInstall(project, globalCli)).toBe("local");
  });
});
