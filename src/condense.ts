/** Condensed command output for AI agents (`run --compact`).
 *
 *  An agent pays for every line a command prints, and again on every later
 *  turn that re-reads the conversation. Build and test logs are mostly lines
 *  that never help locate a failure: log chatter below WARN, build-tool
 *  boilerplate, the middle of stack traces, and the same exception repeated
 *  for every test. Compact mode drops those, keeps the lines around the
 *  earliest cause, and leaves the full output in `.dev-blackbox/last-run.log`
 *  for the rare case the excerpt is not enough. Short output passes through
 *  unchanged: there is nothing to save, and the agent may need every line. */

export type OutputMode = "full" | "compact";

/** Output up to this many lines is shown verbatim. */
export const VERBATIM_MAX_LINES = 40;
export const FAILURE_MAX_LINES = 60;
export const SUCCESS_MAX_LINES = 15;
const MAX_LINE_CHARS = 300;
const FRAMES_HEAD = 2;
const FRAMES_TAIL = 1;
/** Lines kept before and after the earliest cause when the middle is cut. */
const PIN_BEFORE = 2;
const PIN_AFTER = 6;

const FRAME_RE = /^\s*(?:at\s+[\w$<.(/[]|\.\.\. \d+ (?:more|common frames omitted)\s*$|File ".+", line \d+)/;
const LOG_CHATTER_RE = /^\s*(?:\S+\s+){0,3}\[?(?:DEBUG|TRACE|INFO)\]?[\s:]/;
const BOILERPLATE_RE = [
  /^> Task :\S+(?: (?:UP-TO-DATE|NO-SOURCE|SKIPPED|FROM-CACHE))?$/,
  /^Deprecated Gradle features were used/,
  /^You can use '--warning-mode all'/,
  /^For more on this, please refer to https:\/\/docs\.gradle\.org/,
  /^\[Incubating\] Problems report is available/,
  /^\* Try:$/,
  /^> Run with --(?:stacktrace|info|debug|scan)/,
  /^> Get more help at/,
  /^\d+ actionable tasks?:/,
  /^(?:Starting a Gradle Daemon|Reusing configuration cache|Configuration cache entry)/,
  /^npm (?:ERR!|error) (?:A complete log of this run|code |path |workspace |location |command )/,
  / STANDARD_(?:OUT|ERR)$/,
];

const TIMESTAMP_RE = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?|\b\d\d:\d\d:\d\d[.,]\d+/g;

/** `--compact`/`--full` win; otherwise DEV_BLACKBOX_OUTPUT, then compact
 *  inside Claude Code (which sets CLAUDECODE=1 for the shells it spawns). */
export function resolveOutputMode(
  flags: { compact?: boolean; full?: boolean },
  env: NodeJS.ProcessEnv,
): OutputMode {
  if (flags.full) return "full";
  if (flags.compact) return "compact";
  const configured = env.DEV_BLACKBOX_OUTPUT?.trim().toLowerCase();
  if (configured === "full" || configured === "compact") return configured;
  return env.CLAUDECODE === "1" ? "compact" : "full";
}

interface Kept {
  /** 0-based index into the original output. */
  idx: number;
  text: string;
}

const isNoise = (line: string) =>
  LOG_CHATTER_RE.test(line) || BOILERPLATE_RE.some((re) => re.test(line.trim()));

/** Timestamps, the process id after a log level, and identity hashes
 *  (`Foo@30c1da48`) vary between otherwise identical repeats. Other numbers
 *  stay: `module-3` and `module-4` are different lines. */
const dedupKey = (line: string) =>
  line
    .trim()
    .replace(TIMESTAMP_RE, "#")
    .replace(/\b(WARN|ERROR|INFO|DEBUG)\s+\d+\b/, "$1 #")
    .replace(/@[0-9a-f]{4,}\b/g, "@#");

/** Lines with the same shape differ only in numbers: `[17] SKU-0017 FAILED`. */
const shape = (line: string) => line.trim().replace(/\d+/g, "#");

/** Runs of consecutive same-shape lines (blank lines between them included)
 *  become the first line, a count, and the last line. */
function collapseSimilar(kept: Kept[]): Kept[] {
  const out: Kept[] = [];
  let run: Kept[] = [];
  const closeRun = () => {
    if (run.length === 2) out.push(run[1]!);
    if (run.length > 2) {
      out.push({ idx: run[1]!.idx, text: `… ${run.length - 2} similar lines …` }, run[run.length - 1]!);
    }
    run = [];
  };
  for (const k of kept) {
    if (k.text.trim() === "") {
      if (run.length <= 1) out.push(k);
      continue;
    }
    if (run.length > 0 && shape(k.text) === shape(run[0]!.text)) {
      if (run.length === 1) while (out.length && out[out.length - 1]!.text.trim() === "") out.pop();
      run.push(k);
      continue;
    }
    closeRun();
    out.push(k);
    run = [k];
  }
  closeRun();
  return out;
}

const clipLine = (line: string) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;

/** Drops noise and repeats, and keeps only both ends of each stack trace. */
export function filterNoise(lines: string[]): Kept[] {
  const kept: Kept[] = [];
  const seen = new Set<string>();
  let frames: Kept[] = [];

  const firstSighting = (text: string) => {
    if (text.trim().length <= 20) return true;
    const key = dedupKey(text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const flushFrames = () => {
    const fresh = frames.filter((f) => firstSighting(f.text));
    frames = [];
    if (fresh.length <= FRAMES_HEAD + FRAMES_TAIL + 1) {
      kept.push(...fresh);
      return;
    }
    const omitted = fresh.length - FRAMES_HEAD - FRAMES_TAIL;
    const indent = /^\s*/.exec(fresh[0]!.text)![0];
    kept.push(
      ...fresh.slice(0, FRAMES_HEAD),
      { idx: fresh[FRAMES_HEAD]!.idx, text: `${indent}… ${omitted} frames …` },
      ...fresh.slice(-FRAMES_TAIL),
    );
  };

  lines.forEach((text, idx) => {
    if (FRAME_RE.test(text)) {
      frames.push({ idx, text });
      return;
    }
    if (frames.length > 0) flushFrames();
    if (isNoise(text)) return;
    if (text.trim() === "") {
      if (kept.length > 0 && kept[kept.length - 1]!.text.trim() !== "") kept.push({ idx, text: "" });
      return;
    }
    if (firstSighting(text)) kept.push({ idx, text });
  });
  if (frames.length > 0) flushFrames();
  return collapseSimilar(kept);
}

/** Head and tail of `kept`, plus the lines around `pinnedIdx` when the cut
 *  would otherwise remove them. */
function fit(kept: Kept[], max: number, pinnedIdx?: number): string[] {
  if (kept.length <= max) return kept.map((k) => k.text);
  const headCount = Math.round(max * 0.3);
  const head = kept.slice(0, headCount);
  let tail = kept.slice(-(max - headCount));

  let pinned: Kept[] = [];
  if (pinnedIdx !== undefined) {
    const at = kept.findIndex((k) => k.idx >= pinnedIdx);
    const shown = at >= 0 && (at < headCount || at >= kept.length - tail.length);
    if (at >= 0 && !shown) {
      pinned = kept.slice(Math.max(headCount, at - PIN_BEFORE), at + PIN_AFTER + 1);
      tail = tail.slice(Math.min(tail.length, pinned.length));
    }
  }

  const gap = (from: Kept[], to: Kept[]) => {
    const a = from[from.length - 1];
    const b = to[0];
    if (!a || !b) return [];
    const n = kept.indexOf(b) - kept.indexOf(a) - 1;
    return n > 0 ? [`… ${n} lines omitted …`] : [];
  };
  const out = [...head.map((k) => k.text)];
  if (pinned.length > 0) out.push(...gap(head, pinned), ...pinned.map((k) => k.text));
  const before = pinned.length > 0 ? pinned : head;
  out.push(...gap(before, tail), ...tail.map((k) => k.text));
  return out;
}

export interface CondenseInput {
  lines: string[];
  failed: boolean;
  /** 0-based index of the earliest cause in `lines`, kept even when cut. */
  rootCauseIdx?: number;
  /** Where the full output was saved, for the header line. */
  fullLogPath?: string;
}

/** The text an agent sees in place of the command's raw output. */
export function condenseOutput(input: CondenseInput): string {
  const { lines } = input;
  if (lines.length <= VERBATIM_MAX_LINES) return lines.length ? `${lines.join("\n")}\n` : "";

  const kept = filterNoise(lines);
  const body = input.failed
    ? fit(kept, FAILURE_MAX_LINES, input.rootCauseIdx)
    : kept.filter((k) => k.text.trim() !== "").slice(-SUCCESS_MAX_LINES).map((k) => k.text);
  const where = input.fullLogPath ? `; full output: ${input.fullLogPath}` : "";
  const header = input.failed
    ? `[dev-blackbox] ${lines.length} output lines condensed to ${body.length}${where}`
    : `[dev-blackbox] ${lines.length} output lines; last ${body.length} after removing noise${where}`;
  return `${[header, ...body.map(clipLine)].join("\n")}\n`;
}
