import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markResolveCandidates, recordFailure, setPinned, setStatus } from "../src/incident.js";
import { Storage } from "../src/storage.js";

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbb-inc-"));
  storage = new Storage(path.join(dir, ".dev-blackbox"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const failureWithTrace = (line: number) => ({
  command: "npm test",
  cwd: dir,
  exitCode: 1,
  signal: null,
  timedOut: false,
  softSignal: {
    errorType: "TypeError",
    message: "Cannot read properties of undefined",
    location: { file: "src/user.js", line, function: "getName" },
    relatedFiles: ["src/user.js"],
    excerpt: [],
  },
  logText: "TypeError: Cannot read properties of undefined",
});

describe("recordFailure", () => {
  it("creates an incident with a date-based id and stores the log blob", () => {
    const inc = recordFailure(storage, failureWithTrace(12));
    expect(inc.incidentId).toMatch(/^INC-\d{8}-001$/);
    expect(inc.status).toBe("open");
    expect(inc.occurrenceCount).toBe(1);
    expect(inc.lastLocation?.line).toBe(12);
    expect(inc.logBlob).toBeDefined();
    expect(storage.readLogBlob(inc.logBlob!)).toContain("TypeError");
  });

  it("merges the same error even when the line number moved (spec 4.4)", () => {
    const first = recordFailure(storage, failureWithTrace(12));
    const second = recordFailure(storage, failureWithTrace(97));
    expect(second.incidentId).toBe(first.incidentId);
    expect(second.occurrenceCount).toBe(2);
    expect(second.lastLocation?.line).toBe(97); // latest line kept as detail
    expect(storage.readIncidents()).toHaveLength(1);
  });

  it("creates separate incidents for different errors", () => {
    recordFailure(storage, failureWithTrace(12));
    const other = recordFailure(storage, {
      ...failureWithTrace(12),
      softSignal: {
        errorType: "RangeError",
        message: "Maximum call stack size exceeded",
        relatedFiles: [],
        excerpt: [],
      },
    });
    expect(other.incidentId).toMatch(/-002$/);
    expect(storage.readIncidents()).toHaveLength(2);
  });

  it("reopens a resolved incident when the error reoccurs", () => {
    const inc = recordFailure(storage, failureWithTrace(12));
    setStatus(storage, inc.incidentId, "resolved");
    const again = recordFailure(storage, failureWithTrace(12));
    expect(again.incidentId).toBe(inc.incidentId);
    expect(again.status).toBe("open");
  });

  it("falls back to a process fingerprint when no soft signal exists", () => {
    const ctx = {
      command: "npm test",
      cwd: dir,
      exitCode: 1,
      signal: null,
      timedOut: false,
      softSignal: undefined,
      logText: "no recognizable error pattern",
    };
    const a = recordFailure(storage, ctx);
    const b = recordFailure(storage, ctx);
    expect(a.kind).toBe("PROCESS_FAILURE");
    expect(b.incidentId).toBe(a.incidentId);
    expect(b.occurrenceCount).toBe(2);
  });
});

describe("markResolveCandidates", () => {
  it("marks open incidents of the same command + cwd after a success", () => {
    const inc = recordFailure(storage, failureWithTrace(12));
    const marked = markResolveCandidates(storage, "npm test", dir);
    expect(marked.map((m) => m.incidentId)).toEqual([inc.incidentId]);
    expect(storage.findIncident(inc.incidentId)?.status).toBe("resolve_candidate");
  });

  it("does not touch incidents of other commands", () => {
    recordFailure(storage, failureWithTrace(12));
    expect(markResolveCandidates(storage, "npm run build", dir)).toHaveLength(0);
  });

  it("does not mark incidents from a different service directory (MSA)", () => {
    recordFailure(storage, failureWithTrace(12)); // cwd = dir (service A)
    expect(markResolveCandidates(storage, "npm test", dir + "-other-service")).toHaveLength(0);
  });
});

describe("pin / resolve", () => {
  it("pins and resolves incidents", () => {
    const inc = recordFailure(storage, failureWithTrace(12));
    expect(setPinned(storage, inc.incidentId, true)?.pinned).toBe(true);
    const resolved = setStatus(storage, inc.incidentId, "resolved");
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).toBeDefined();
  });

  it("returns undefined for unknown ids", () => {
    expect(setStatus(storage, "INC-19700101-999", "resolved")).toBeUndefined();
  });
});
