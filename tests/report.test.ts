import { describe, expect, it } from "vitest";
import { renderIncidentReport } from "../src/report.js";
import type { IncidentRecord } from "../src/types.js";

const incident: IncidentRecord = {
  schemaVersion: 1,
  incidentId: "INC-20260713-001",
  fingerprint: "NullPointerException|<n>|UserService.java:findUser",
  kind: "PROCESS_FAILURE",
  errorType: "NullPointerException",
  message: "null",
  status: "open",
  pinned: false,
  firstSeenAt: "2026-07-13T22:10:00.000Z",
  lastSeenAt: "2026-07-13T22:51:00.000Z",
  occurrenceCount: 17,
  lastCommand: "./gradlew test",
  lastCwd: "/proj",
  lastExitCode: 1,
  lastSignal: null,
  timedOut: false,
  lastLocation: { file: "UserService.java", line: 42, function: "findUser" },
  relatedFiles: ["src/main/java/UserService.java"],
  facts: [
    "Process exited with code 1",
    "NullPointerException at UserService.java:42 in findUser (latest occurrence)",
  ],
  hypotheses: [{ description: "Missing null check on repository return value", confidence: 0.82 }],
};

describe("renderIncidentReport", () => {
  it("renders an English report by default (spec 3.4)", () => {
    const md = renderIncidentReport(incident);
    expect(md).toContain("# INC-20260713-001 NullPointerException");
    expect(md).toContain("Occurrences: 17");
    expect(md).toContain("Exit code: 1");
    expect(md).toContain("## Confirmed facts");
    expect(md).toContain("## Suspected causes");
    expect(md).toContain("confidence: 82%");
    expect(md).toContain("UserService.java:42");
  });

  it("renders Korean when configured", () => {
    const md = renderIncidentReport(incident, "ko");
    expect(md).toContain("## 확인된 사실");
    expect(md).toContain("## 추정 원인");
    expect(md).toContain("발생 횟수: 17");
  });

  it("separates facts from hypotheses (spec 3.6)", () => {
    const md = renderIncidentReport(incident);
    const factsIdx = md.indexOf("## Confirmed facts");
    const hypIdx = md.indexOf("## Suspected causes");
    expect(factsIdx).toBeGreaterThan(-1);
    expect(hypIdx).toBeGreaterThan(factsIdx);
    expect(md.slice(factsIdx, hypIdx)).toContain("Process exited with code 1");
    expect(md.slice(hypIdx)).toContain("Missing null check");
  });

  it("shows the signal instead of exit code for signal terminations", () => {
    const md = renderIncidentReport({ ...incident, lastSignal: "SIGKILL", lastExitCode: null });
    expect(md).toContain("Signal: SIGKILL");
    expect(md).not.toContain("Exit code");
  });
});
