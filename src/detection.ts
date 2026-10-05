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

// Vitest code frame: " ❯ test/pricing.test.ts:23:32" (the file summary line
// " ❯ test/pricing.test.ts (6 tests | 3 failed)" has no line:col and is skipped).
const VITEST_FRAME_RE = /^\s*❯\s+(\S+?):(\d+):(\d+)\s*$/;

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

// Playwright prefixes stdout/stderr from configured webServer processes. Keep
// the original line for excerpts, but parse the diagnostic beneath the label.
// The JVM's uncaught-exception line, `Exception in thread "main" java.lang.X: …`,
// is parsed the same way.
function diagnosticLine(line: string): string {
  return line.replace(/^\s*\[WebServer\]\s?/, "").replace(/^Exception in thread "[^"]*"\s+/, "");
}

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
  m = VITEST_FRAME_RE.exec(line);
  if (m) {
    const [, file, lineNo] = m;
    return { file: file!, line: Number(lineNo), app: isAppFrameFile(file!) };
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
    const err = ERROR_LINE_RE.exec(diagnosticLine(line).trim());
    if (err) {
      const [, rawType, message] = err;
      const errorType = rawType!.split(".").pop()!;
      // Walk the following (and for Python, preceding) lines for stack frames.
      const frames: (ErrorLocation & { app: boolean })[] = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
        const frame = parseFrame(diagnosticLine(lines[j]!));
        if (frame) frames.push(frame);
        else if (frames.length > 0) break;
      }
      if (frames.length === 0) {
        for (let j = i - 1; j >= Math.max(0, i - 40); j--) {
          const frame = parseFrame(diagnosticLine(lines[j]!));
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

/** Picks the strongest soft signal across several INDEPENDENT line sequences.
 *
 *  Each group is scanned on its own. Callers must never concatenate groups
 *  themselves: detectSoftSignals reads stack frames from the lines FOLLOWING
 *  an error, so a spliced sequence lets an error at the end of one group pick
 *  up unrelated frames from the start of the next — which silently changes the
 *  incident fingerprint. Ties keep the earlier group, so pass the primary
 *  source (the full ring buffer) first. */
export function bestSoftSignal(...groups: string[][]): SoftSignal | undefined {
  let best: SoftSignal | undefined;
  for (const group of groups) {
    const candidate = detectSoftSignals(group)[0];
    if (candidate && (best === undefined || rank(candidate) > rank(best))) best = candidate;
  }
  return best;
}

// Java/Kotlin chained cause, optionally indented (Gradle's full exception format).
const CAUSED_BY_RE = /^\s*Caused by:\s+(.+)$/;
// A chain whose header was this many lines ago is considered finished.
const CHAIN_WINDOW = 800;
const ROOT_EXCERPT_LINES = 6;

/** Follows the FIRST exception chain in a command's output, over every line
 *  the command printed — not just the ring-buffer window — and keeps its
 *  deepest cause.
 *
 *  Long builds often print the real cause once, early, and then bury it
 *  under thousands of lines of follow-up failures (e.g. Spring's "failure
 *  threshold exceeded" for every later test). The ring buffer only keeps the
 *  tail, so this tracker is what still knows the original cause. Memory is
 *  bounded: it keeps a handful of lines, never the stream. */
export class RootCauseTracker {
  private lineNo = 0;
  private readonly recent: string[] = [];
  private current?: RootCause;
  private headerLine = 0;
  private pending = 0;
  private causeOnNextLine = false;
  private done = false;

  push(line: string): void {
    this.lineNo++;
    if (this.done) return;
    const diag = diagnosticLine(line);

    if (this.current && this.pending > 0) {
      this.current.excerpt.push(line);
      this.pending--;
      if (!this.current.location) {
        const frame = parseFrame(diag);
        if (frame?.app) {
          this.current.location = { file: frame.file, line: frame.line, function: frame.function };
        }
      }
    }

    // Gradle's full exception format puts "Caused by:" on a line of its own
    // and the exception on the next one.
    if (this.current && diag.trim() === "Caused by:") {
      this.causeOnNextLine = true;
      return;
    }
    const pendingCause = this.causeOnNextLine && diag.trim() !== "";
    if (pendingCause) this.causeOnNextLine = false;
    const caused = pendingCause ? [diag, diag] : CAUSED_BY_RE.exec(diag);
    if (caused && this.current) {
      if (this.lineNo - this.headerLine > CHAIN_WINDOW) {
        this.done = true;
        return;
      }
      const err = ERROR_LINE_RE.exec(caused[1]!.trim());
      if (err) {
        this.current = {
          errorType: err[1]!.split(".").pop()!,
          message: err[2] ?? "",
          outputLine: this.lineNo,
          depth: this.current.depth + 1,
          excerpt: [line],
        };
        this.pending = ROOT_EXCERPT_LINES;
      }
    } else if (!this.current) {
      const err = ERROR_LINE_RE.exec(diag.trim());
      if (err) {
        this.current = {
          errorType: err[1]!.split(".").pop()!,
          message: err[2] ?? "",
          outputLine: this.lineNo,
          depth: 0,
          excerpt: [...this.recent, line],
        };
        this.headerLine = this.lineNo;
        this.pending = ROOT_EXCERPT_LINES;
      } else {
        this.recent.push(line);
        if (this.recent.length > 2) this.recent.shift();
      }
    } else if (
      this.pending === 0 &&
      (this.lineNo - this.headerLine > CHAIN_WINDOW || ERROR_LINE_RE.test(diag.trim()))
    ) {
      // A new top-level exception (or a long gap) ends the first chain.
      this.done = true;
    }
  }

  /** Number of lines seen so far (1-based line numbers in RootCause). */
  get lines(): number {
    return this.lineNo;
  }

  result(): RootCause | undefined {
    return this.current
      ? { ...this.current, excerpt: [...this.current.excerpt] }
      : undefined;
  }
}

export interface RootCause {
  errorType: string;
  message: string;
  location?: ErrorLocation;
  /** 1-based line number in the command's combined output. */
  outputLine: number;
  /** 0 for the first exception itself, N for its N-th nested cause. */
  depth: number;
  excerpt: string[];
}

function rank(s: SoftSignal): number {
  if (s.location && s.errorType !== "TEST_FAILURE" && s.errorType !== "BUILD_FAILURE") return 3;
  if (s.errorType !== "TEST_FAILURE" && s.errorType !== "BUILD_FAILURE") return 2;
  if (s.errorType === "TEST_FAILURE") return 1;
  return 0;
}
