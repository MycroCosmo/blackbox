import { describe, expect, it } from "vitest";
import { detectSoftSignals } from "../src/detection.js";

describe("detectSoftSignals", () => {
  it("detects a JS TypeError with an application stack frame", () => {
    const lines = [
      "some output",
      "TypeError: Cannot read properties of undefined (reading 'name')",
      "    at getName (/app/src/user.js:12:5)",
      "    at process (/app/node_modules/lib/index.js:99:1)",
    ];
    const [signal] = detectSoftSignals(lines);
    expect(signal).toBeDefined();
    expect(signal!.errorType).toBe("TypeError");
    expect(signal!.location?.file).toBe("/app/src/user.js");
    expect(signal!.location?.line).toBe(12);
    expect(signal!.relatedFiles).toEqual(["/app/src/user.js"]);
  });

  it("detects a Java stack trace and picks the app frame", () => {
    const lines = [
      "java.lang.NullPointerException: null",
      "    at com.example.UserService.findUser(UserService.java:42)",
      "    at java.base.Thread.run(Thread.java:833)",
    ];
    const [signal] = detectSoftSignals(lines);
    expect(signal!.errorType).toBe("NullPointerException");
    expect(signal!.location).toMatchObject({
      file: "UserService.java",
      line: 42,
      function: "findUser",
    });
  });

  it("detects Python tracebacks (frames appear before the error line)", () => {
    const lines = [
      "Traceback (most recent call last):",
      '  File "app.py", line 7, in main',
      "    do_thing()",
      '  File "app.py", line 3, in do_thing',
      "ValueError: bad value",
    ];
    const [signal] = detectSoftSignals(lines);
    expect(signal!.errorType).toBe("ValueError");
    expect(signal!.location?.file).toBe("app.py");
  });

  it("detects test-failure and build-failure summaries", () => {
    expect(detectSoftSignals(["Tests: 2 failed, 18 passed"])[0]?.errorType).toBe("TEST_FAILURE");
    expect(detectSoftSignals(["FAILURE: Build failed with an exception."])[0]?.errorType).toBe(
      "BUILD_FAILURE",
    );
  });

  it("prefers a located exception over a bare summary line", () => {
    const lines = [
      "Tests: 1 failed, 3 passed",
      "TypeError: boom",
      "    at run (/app/src/x.js:3:1)",
    ];
    const [first] = detectSoftSignals(lines);
    expect(first!.errorType).toBe("TypeError");
  });

  it("does not fire on ordinary text mentioning error-ish words", () => {
    const lines = ["all good", "checking error handling paths...", "done in 3s"];
    expect(detectSoftSignals(lines)).toHaveLength(0);
  });
});
