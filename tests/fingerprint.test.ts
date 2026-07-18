import { describe, expect, it } from "vitest";
import {
  fingerprintFromError,
  fingerprintFromProcess,
  normalizeMessage,
} from "../src/fingerprint.js";

describe("normalizeMessage", () => {
  it("replaces numbers, ids and quoted values", () => {
    expect(normalizeMessage("user 42 not found")).toBe("user <n> not found");
    expect(normalizeMessage("id 550e8400-e29b-41d4-a716-446655440000 missing")).toBe(
      "id <id> missing",
    );
    expect(normalizeMessage("cannot open 'foo.txt'")).toBe("cannot open <str>");
    expect(normalizeMessage("address 0xdeadbeef")).toBe("address <hex>");
  });

  it("keeps stable text unchanged", () => {
    expect(normalizeMessage("Cannot read properties of undefined")).toBe(
      "Cannot read properties of undefined",
    );
  });
});

describe("fingerprintFromError", () => {
  it("excludes line numbers so shifted code merges (spec 4.4)", () => {
    const a = fingerprintFromError("NullPointerException", "oops", {
      file: "src/main/java/UserService.java",
      line: 42,
      function: "findUser",
    });
    const b = fingerprintFromError("NullPointerException", "oops", {
      file: "src/main/java/UserService.java",
      line: 97,
      function: "findUser",
    });
    expect(a).toBe(b);
    expect(a).not.toContain("42");
  });

  it("separates different error types", () => {
    const a = fingerprintFromError("TypeError", "x is undefined");
    const b = fingerprintFromError("RangeError", "x is undefined");
    expect(a).not.toBe(b);
  });

  it("merges messages differing only in volatile values", () => {
    const a = fingerprintFromError("TypeError", "user 42 not found");
    const b = fingerprintFromError("TypeError", "user 977 not found");
    expect(a).toBe(b);
  });
});

describe("fingerprintFromProcess", () => {
  it("keys on kind + exit code + normalized command + cwd", () => {
    const a = fingerprintFromProcess("PROCESS_FAILURE", "npm test", 1, null, "/repo/svc-a");
    const b = fingerprintFromProcess("PROCESS_FAILURE", "npm test", 1, null, "/repo/svc-a");
    const c = fingerprintFromProcess("PROCESS_FAILURE", "npm test", 2, null, "/repo/svc-a");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("separates the same command failing in different services (monorepo/MSA)", () => {
    const a = fingerprintFromProcess("PROCESS_FAILURE", "npm test", 1, null, "/repo/svc-a");
    const b = fingerprintFromProcess("PROCESS_FAILURE", "npm test", 1, null, "/repo/svc-b");
    expect(a).not.toBe(b);
  });
});
