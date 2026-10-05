import type { IncidentAttempt, IncidentRecord } from "./types.js";

/** The failure summary appended to stderr after a failing `run` (spec 3.7).
 *
 *  It is the one piece of dev-blackbox output an agent is guaranteed to read,
 *  so it carries the answer itself — the error, where it happened, the
 *  earliest cause in the output, and whether the agent's last edits changed
 *  anything — instead of only pointing at `incident show`. Lines keep the
 *  "Key: value" shape so they stay machine-parsable. */

const MAX_MESSAGE = 200;
const MAX_FILES_SHOWN = 5;
const MAX_ATTEMPTS_SHOWN = 3;

export interface SummaryInput {
  incident: IncidentRecord;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  reportPath?: string;
  /** How the agent should invoke the CLI, e.g. "npx dev-blackbox". */
  cli: string;
}

function clip(text: string, max = MAX_MESSAGE): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function describeError(errorType: string, message: string): string {
  return message ? `${errorType}: ${clip(message)}` : errorType;
}

function fileList(files: string[], total = files.length): string {
  const shown = files.slice(0, MAX_FILES_SHOWN).join(", ");
  const more = total - Math.min(files.length, MAX_FILES_SHOWN);
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

function describeAttempt(a: IncidentAttempt): string {
  const step = `#${a.occurrence - 1} → #${a.occurrence}`;
  if (a.changedFiles === null) return `${step}: file changes unknown (not a git workspace)`;
  if (a.changedFiles.length === 0) return `${step}: no file changes — re-run without edits`;
  return `${step}: changed ${fileList(a.changedFiles, a.changedCount ?? a.changedFiles.length)} — same failure`;
}

/** Local wall-clock time, matching the agent's and the user's terminal. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
}

export function formatFailureSummary(s: SummaryInput): string {
  const inc = s.incident;
  const lines = ["", "✗ Command failed", "", `Incident: ${inc.incidentId}`, `Type: ${inc.kind}`];
  lines.push(s.signal ? `Signal: ${s.signal}` : `Exit code: ${s.exitCode}`);
  if (s.timedOut) lines.push("Timed out: true");

  const hasError = inc.errorType !== inc.kind;
  if (hasError) lines.push(`Error: ${describeError(inc.errorType, inc.message)}`);
  if (inc.lastLocation) {
    const loc = inc.lastLocation;
    lines.push(`At: ${loc.file}${loc.line ? `:${loc.line}` : ""}${loc.function ? ` (${loc.function})` : ""}`);
  }
  const rc = inc.rootCause;
  if (rc && (rc.errorType !== inc.errorType || clip(rc.message) !== clip(inc.message))) {
    const where = rc.location
      ? ` at ${rc.location.file}${rc.location.line ? `:${rc.location.line}` : ""}`
      : "";
    // "Earliest", not "root": the first exception printed is usually, but not
    // always, the one that matters.
    lines.push(`Earliest cause (output line ${rc.outputLine}): ${describeError(rc.errorType, rc.message)}${where}`);
  }

  if (inc.occurrenceCount > 1) {
    lines.push(`Occurrences: ${inc.occurrenceCount} (first seen ${localTime(inc.firstSeenAt)}) — this failure happened before`);
    const attempts = (inc.attempts ?? []).slice(-MAX_ATTEMPTS_SHOWN).reverse();
    for (const a of attempts) lines.push(`  ${describeAttempt(a)}`);
  } else {
    lines.push(`Occurrences: 1`);
  }

  if (s.reportPath) lines.push(`Report: ${s.reportPath}`);
  lines.push(`Details: ${s.cli} incident show ${inc.incidentId} --format json`);
  lines.push("");
  return lines.join("\n");
}
