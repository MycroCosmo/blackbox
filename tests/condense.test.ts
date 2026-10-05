import { describe, expect, it } from "vitest";
import {
  condenseOutput,
  FAILURE_MAX_LINES,
  resolveOutputMode,
  SUCCESS_MAX_LINES,
  VERBATIM_MAX_LINES,
} from "../src/condense.js";

/** A Spring/Gradle-style failing build: chatter, a root cause early on, then
 *  the same context-load exception repeated for every test. */
function noisyGradleFailure(): { lines: string[]; rootCauseIdx: number } {
  const lines: string[] = [];
  for (let i = 0; i < 80; i++)
    lines.push(`2026-10-05T16:37:10.387+09:00  INFO 1234 --- [main] c.e.p.PricingApplication : step ${i}`);
  const rootCauseIdx = lines.length;
  lines.push("Caused by: java.lang.NumberFormatException: Character % is neither a decimal digit number");
  for (let i = 0; i < 40; i++) lines.push(`\tat java.base/java.math.BigDecimal.<init>(BigDecimal.java:${500 + i})`);
  for (let t = 0; t < 21; t++) {
    lines.push("", `PricingPropertiesTest > case${t}() FAILED`);
    lines.push(`    java.lang.IllegalStateException: ApplicationContext failure threshold (1) exceeded for [MergedContextConfiguration@${(0x30c1da48 + t).toString(16)}]`);
    for (let i = 0; i < 30; i++)
      lines.push(`        at org.springframework.test.context.Frame${i}.load(Frame${i}.java:${100 + i})`);
  }
  lines.push(
    "",
    "Deprecated Gradle features were used in this build, making it incompatible with Gradle 9.0.",
    "5 actionable tasks: 1 executed, 4 up-to-date",
    "",
    "21 tests completed, 21 failed",
    "",
    "FAILURE: Build failed with an exception.",
    "BUILD FAILED in 1s",
  );
  return { lines, rootCauseIdx };
}

describe("condenseOutput", () => {
  it("passes short output through verbatim", () => {
    const lines = Array.from({ length: VERBATIM_MAX_LINES }, (_, i) => `INFO line ${i}`);
    expect(condenseOutput({ lines, failed: true })).toBe(`${lines.join("\n")}\n`);
  });

  it("cuts a noisy failure to the lines that locate it", () => {
    const { lines, rootCauseIdx } = noisyGradleFailure();
    const out = condenseOutput({ lines, failed: true, rootCauseIdx, fullLogPath: ".dev-blackbox/last-run.log" });
    const outLines = out.trimEnd().split("\n");

    expect(outLines.length).toBeLessThanOrEqual(FAILURE_MAX_LINES + 1);
    expect(out.length).toBeLessThan(lines.join("\n").length / 5);
    expect(outLines[0]).toContain(".dev-blackbox/last-run.log");
    expect(out).toContain("NumberFormatException: Character %");
    expect(out).toContain("21 tests completed, 21 failed");
    expect(out).toContain("BUILD FAILED");
    expect(out).not.toMatch(/\bINFO\b/);
    expect(out).not.toContain("Deprecated Gradle features");
    // The repeated exception is shown once, not once per test.
    expect(out.match(/ApplicationContext failure threshold/g)).toHaveLength(1);
    expect(out).toMatch(/… \d+ frames …/);
  });

  it("keeps the earliest cause even when it falls in the cut middle", () => {
    // Letter-only names: lines that differ only in digits would be collapsed.
    const name = (i: number) => String.fromCharCode(97 + (i % 26), 97 + Math.floor(i / 26));
    const lines = [
      ...Array.from({ length: 100 }, (_, i) => `compiling module ${name(i)} with warnings enabled for target`),
      "Error: config value 'vat-rate' is not a number",
      ...Array.from({ length: 100 }, (_, i) => `verifying artifact ${name(i)} checksum against the lockfile`),
    ];
    const out = condenseOutput({ lines, failed: true, rootCauseIdx: 100 });
    expect(out).toContain("Error: config value 'vat-rate' is not a number");
    expect(out).toMatch(/… \d+ lines omitted …/);
  });

  it("shows only the last lines of a long successful run", () => {
    const lines = [
      ...Array.from({ length: 200 }, (_, i) => `✓ test case number ${i} passed in the suite`),
      "Test Files  1 passed (1)",
      "     Tests  200 passed (200)",
    ];
    const outLines = condenseOutput({ lines, failed: false }).trimEnd().split("\n");
    expect(outLines.length).toBeLessThanOrEqual(SUCCESS_MAX_LINES + 1);
    expect(outLines).toContain("… 198 similar lines …");
    expect(outLines[outLines.length - 1]).toContain("200 passed");
  });

  it("drops repeats that differ only in timestamp, pid, or identity hash", () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) =>
        `2026-10-06T01:49:34.${100 + i}+09:00  WARN ${7000 + i} --- [worker] o.s.TestContextManager : Caught exception for Ctx@${(0xd277579 + i).toString(16)}`,
    );
    const out = condenseOutput({ lines, failed: true });
    expect(out.match(/Caught exception/g)).toHaveLength(1);
  });
});

describe("resolveOutputMode", () => {
  it("is compact inside Claude Code and full elsewhere", () => {
    expect(resolveOutputMode({}, { CLAUDECODE: "1" })).toBe("compact");
    expect(resolveOutputMode({}, {})).toBe("full");
  });

  it("lets flags and DEV_BLACKBOX_OUTPUT override the default", () => {
    expect(resolveOutputMode({ full: true }, { CLAUDECODE: "1" })).toBe("full");
    expect(resolveOutputMode({ compact: true }, {})).toBe("compact");
    expect(resolveOutputMode({}, { CLAUDECODE: "1", DEV_BLACKBOX_OUTPUT: "full" })).toBe("full");
    expect(resolveOutputMode({}, { DEV_BLACKBOX_OUTPUT: "compact" })).toBe("compact");
  });
});
