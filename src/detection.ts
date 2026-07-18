import type { ErrorLocation, SoftSignal } from "./types.js";

/** Error detection (spec 4.3).
 *
 *  Hard signals (non-zero exit, signal, timeout) decide WHETHER an incident
 *  is created — that logic lives in the runner. This module extracts SOFT
 *  signals from the captured log: they never create incidents on their own
 *  (unless `detection.softSignalIncident` opts in); their job is to locate
 *  the error type, message and code position inside a hard-signal incident. */

// e.g. "TypeError: Cannot read properties of undefined"
//      "java.lang.NullPointerException: something"
const ERROR_LINE_RE =
  /^(?:Uncaught\s+|Unhandled\s+\w+\s+)?((?:[a-z_][\w]*\.)*[A-Z][\w$]*(?:Error|Exception|Failure))\b:?\s*(.*)$/;

// JS/TS stack frame: "    at fn (path:line:col)" or "    at path:line:col"
const JS_FRAME_RE =
  /^\s+at\s+(?:([\w.<>\[\]$ ]+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

// Java stack frame: "    at com.example.UserService.findUser(UserService.java:42)"
const JAVA_FRAME_RE = /^\s+at\s+([\w.$]+)\.([\w$<>]+)\(([\w.$]+):(\d+)\)/;

// Python frame: '  File "app.py", line 42, in find_user'
const PY_FRAME_RE = /^\s*File\s+"(.+?)",\s+line\s+(\d+)(?:,\s+in\s+(\S+))?/;

// Test / build failure summaries
const TEST_FAIL_RES: RegExp[] = [
  /\bTests?:\s*\d+\s+failed\b/i,
  /\b\d+\s+(?:tests?\s+)?fail(?:ed|ing)\b/i,
  /^FAILED\b/,
  /\bFAIL\b\s+\S+/,
];
const BUILD_FAIL_RES: RegExp[] = [
  /FAILURE:\s*Build failed/i,
  /\bBUILD FAILED\b/i,
  /\bCompilation failed\b/i,
  /error TS\d+:/,
];

function isAppFrameFile(file: string): boolean {
  return (
    !file.startsWith("node:") &&
    !file.includes("node_modules") &&
    !/^(?:java|jdk|sun|javax)\./.test(file) &&
    !file.includes("site-packages")
  );
}

function isAppFrameClass(cls: string): boolean {
  return !/^(?:java|jdk|sun|javax|org\.junit|org\.gradle|org\.springframework)\./.test(cls);
}

function parseFrame(line: string): (ErrorLocation & { app: boolean }) | undefined {
  let m = JS_FRAME_RE.exec(line);
  if (m) {
    const [, fn, file, lineNo] = m;
    if (!file) return undefined;
    return { file, line: Number(lineNo), function: fn?.trim(), app: isAppFrameFile(file) };
  }
  m = JAVA_FRAME_RE.exec(line);
  if (m) {
    const [, cls, method, file, lineNo] = m;
    return { file: file!, line: Number(lineNo), function: method, app: isAppFrameClass(cls!) };
  }
  m = PY_FRAME_RE.exec(line);
  if (m) {
    const [, file, lineNo, fn] = m;
    return { file: file!, line: Number(lineNo), function: fn, app: isAppFrameFile(file!) };
  }
  return undefined;
}

/** Scans (already redacted) log lines and extracts soft signals.
 *  Returns the most useful signal first: exceptions with an application
 *  frame, then exceptions without one, then test/build failure summaries. */
export function detectSoftSignals(lines: string[]): SoftSignal[] {
  const signals: SoftSignal[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const err = ERROR_LINE_RE.exec(line.trim());
    if (err) {
      const [, rawType, message] = err;
      const errorType = rawType!.split(".").pop()!;
      // Walk the following (and for Python, preceding) lines for stack frames.
      const frames: (ErrorLocation & { app: boolean })[] = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
        const frame = parseFrame(lines[j]!);
        if (frame) frames.push(frame);
        else if (frames.length > 0) break;
      }
      if (frames.length === 0) {
        for (let j = i - 1; j >= Math.max(0, i - 40); j--) {
          const frame = parseFrame(lines[j]!);
          if (frame) frames.push(frame);
          else if (frames.length > 0) break;
        }
      }
      const appFrames = frames.filter((f) => f.app);
      const top = appFrames[0] ?? frames[0];
      const relatedFiles = [...new Set(appFrames.map((f) => f.file))].slice(0, 5);
      signals.push({
        errorType,
        message: message ?? "",
        location: top ? { file: top.file, line: top.line, function: top.function } : undefined,
        relatedFiles,
        excerpt: lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 8)),
      });
      continue;
    }
    if (TEST_FAIL_RES.some((re) => re.test(line))) {
      signals.push({
        errorType: "TEST_FAILURE",
        message: line.trim(),
        relatedFiles: [],
        excerpt: lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 4)),
      });
    } else if (BUILD_FAIL_RES.some((re) => re.test(line))) {
      signals.push({
        errorType: "BUILD_FAILURE",
        message: line.trim(),
        relatedFiles: [],
        excerpt: lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 4)),
      });
    }
  }

  return signals.sort((a, b) => rank(b) - rank(a));
}

function rank(s: SoftSignal): number {
  if (s.location && s.errorType !== "TEST_FAILURE" && s.errorType !== "BUILD_FAILURE") return 3;
  if (s.errorType !== "TEST_FAILURE" && s.errorType !== "BUILD_FAILURE") return 2;
  if (s.errorType === "TEST_FAILURE") return 1;
  return 0;
}
