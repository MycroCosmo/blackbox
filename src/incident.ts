import { fingerprintFromError, fingerprintFromProcess, normalizeRoutePath } from "./fingerprint.js";
import type { NetworkRecord } from "./network.js";
import type { Storage } from "./storage.js";
import type { RootCause } from "./detection.js";
import { SCHEMA_VERSION } from "./types.js";
import type {
  IncidentAttempt,
  IncidentKind,
  IncidentRecord,
  SoftSignal,
} from "./types.js";
import { changedFiles, type WorkspaceSnapshot } from "./workspace.js";

/** Incident creation and fingerprint-based merging (spec 4.4).
 *  A recurring fingerprint updates the existing incident (occurrence count,
 *  last-seen data, latest location incl. line number) instead of creating a
 *  new one. A resolved incident that reoccurs is reopened. */

export interface FailureContext {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  softSignal?: SoftSignal;
  /** Deepest cause of the first exception chain anywhere in the output. */
  rootCause?: RootCause;
  /** Git workspace state when the command finished (undefined outside git). */
  workspace?: WorkspaceSnapshot;
  logText: string;
  now?: Date;
}

const MAX_ATTEMPTS = 10;
const MAX_ATTEMPT_FILES = 20;

/** What changed in the workspace between the previous occurrence and this one. */
function nextAttempt(existing: IncidentRecord, ctx: FailureContext, now: string): IncidentAttempt {
  const occurrence = existing.occurrenceCount + 1;
  if (!existing.lastWorkspace || !ctx.workspace) return { occurrence, at: now, changedFiles: null };
  let files: string[];
  try {
    files = changedFiles(ctx.cwd, existing.lastWorkspace, ctx.workspace);
  } catch {
    return { occurrence, at: now, changedFiles: null };
  }
  return files.length > MAX_ATTEMPT_FILES
    ? { occurrence, at: now, changedFiles: files.slice(0, MAX_ATTEMPT_FILES), changedCount: files.length }
    : { occurrence, at: now, changedFiles: files };
}

function storedRootCause(rc: RootCause | undefined): IncidentRecord["rootCause"] {
  if (!rc) return undefined;
  return {
    errorType: rc.errorType,
    message: rc.message,
    ...(rc.location ? { location: rc.location } : {}),
    outputLine: rc.outputLine,
    excerpt: rc.excerpt.slice(0, 10),
  };
}

/** The incident as shown to agents: drops internal bookkeeping (the
 *  workspace snapshot can list hundreds of file hashes). */
export function publicIncident(inc: IncidentRecord): Omit<IncidentRecord, "lastWorkspace"> {
  const { lastWorkspace: _internal, ...rest } = inc;
  return rest;
}

export function classifyKind(ctx: FailureContext): IncidentKind {
  if (ctx.timedOut) return "TIMEOUT";
  if (ctx.signal) return "SIGNAL";
  // Exit code 0 but recorded anyway → soft-signal opt-in (spec 4.3),
  // e.g. long-running dev servers that log errors without dying.
  if (ctx.exitCode === 0) return "SOFT_SIGNAL";
  return "PROCESS_FAILURE";
}

function buildFacts(ctx: FailureContext, kind: IncidentKind): string[] {
  const facts: string[] = [];
  if (kind === "TIMEOUT") facts.push(`Process timed out and was killed`);
  else if (kind === "SIGNAL") facts.push(`Process was terminated by signal ${ctx.signal}`);
  else if (kind === "SOFT_SIGNAL")
    facts.push(`Process exited with code 0 but the log matched an error pattern (softSignalIncident opt-in)`);
  else facts.push(`Process exited with code ${ctx.exitCode}`);
  const s = ctx.softSignal;
  if (s) {
    if (s.location) {
      const loc = `${s.location.file}${s.location.line ? `:${s.location.line}` : ""}`;
      facts.push(`${s.errorType} at ${loc}${s.location.function ? ` in ${s.location.function}` : ""} (latest occurrence)`);
    } else {
      facts.push(`${s.errorType}: ${s.message}`.trim());
    }
  }
  return facts;
}

/** Creates a new incident or merges into an existing one by fingerprint.
 *  Returns the up-to-date record; the caller persists side outputs (report). */
export function recordFailure(storage: Storage, ctx: FailureContext): IncidentRecord {
  return storage.withIncidentLock(() => recordFailureLocked(storage, ctx));
}

function recordFailureLocked(storage: Storage, ctx: FailureContext): IncidentRecord {
  const now = (ctx.now ?? new Date()).toISOString();
  const kind = classifyKind(ctx);
  const s = ctx.softSignal;
  const fingerprint = s
    ? fingerprintFromError(s.errorType, s.message, s.location)
    : fingerprintFromProcess(kind, ctx.command, ctx.exitCode, ctx.signal, ctx.cwd);

  const existing = storage.findIncidentByFingerprint(fingerprint);
  const incidentId = existing?.incidentId ?? storage.nextIncidentId(ctx.now ?? new Date());
  const logBlob = safeWriteBlob(storage, incidentId, ctx.logText);

  if (existing) {
    const updated: IncidentRecord = {
      ...existing,
      status: existing.status === "resolved" || existing.status === "resolve_candidate"
        ? "open"
        : existing.status,
      lastSeenAt: now,
      occurrenceCount: existing.occurrenceCount + 1,
      lastCommand: ctx.command,
      lastCwd: ctx.cwd,
      lastExitCode: ctx.exitCode,
      lastSignal: ctx.signal,
      timedOut: ctx.timedOut,
      lastLocation: s?.location ?? existing.lastLocation,
      relatedFiles: mergeFiles(existing.relatedFiles, s?.relatedFiles ?? []),
      logBlob: logBlob ?? existing.logBlob,
      message: s?.message || existing.message,
      facts: buildFacts(ctx, kind),
      resolvedAt: undefined,
      rootCause: storedRootCause(ctx.rootCause),
      lastWorkspace: ctx.workspace,
      attempts: [...(existing.attempts ?? []), nextAttempt(existing, ctx, now)].slice(-MAX_ATTEMPTS),
    };
    storage.appendIncident(updated);
    return updated;
  }

  const record: IncidentRecord = {
    schemaVersion: SCHEMA_VERSION,
    incidentId,
    fingerprint,
    kind,
    errorType: s?.errorType ?? kind,
    message: s?.message ?? `Command failed: ${ctx.command}`,
    status: "open",
    pinned: false,
    firstSeenAt: now,
    lastSeenAt: now,
    occurrenceCount: 1,
    lastCommand: ctx.command,
    lastCwd: ctx.cwd,
    lastExitCode: ctx.exitCode,
    lastSignal: ctx.signal,
    timedOut: ctx.timedOut,
    lastLocation: s?.location,
    relatedFiles: s?.relatedFiles ?? [],
    logBlob,
    facts: buildFacts(ctx, kind),
    hypotheses: [],
    ...(ctx.rootCause ? { rootCause: storedRootCause(ctx.rootCause) } : {}),
    ...(ctx.workspace ? { lastWorkspace: ctx.workspace } : {}),
  };
  storage.appendIncident(record);
  return record;
}

/** Links a failing network event to an incident (Phase 3: 에러 Incident와
 *  네트워크 요청 연결). Same fingerprint-merge semantics as command failures;
 *  volatile URL segments (ids, numbers) are normalized so /api/todos/42 and
 *  /api/todos/7 merge. */
export function recordNetworkFailure(storage: Storage, record: NetworkRecord): IncidentRecord {
  return storage.withIncidentLock(() => recordNetworkFailureLocked(storage, record));
}

function recordNetworkFailureLocked(storage: Storage, record: NetworkRecord): IncidentRecord {
  const now = record.receivedAt;
  const pathOnly = (() => {
    try {
      return new URL(record.url, "http://localhost").pathname;
    } catch {
      return record.url;
    }
  })();
  const fingerprint = ["NETWORK", record.classification, record.method, normalizeRoutePath(pathOnly)].join("|");
  const errorType =
    record.classification === "http_error" && record.status != null
      ? `HTTP_${record.status}`
      : record.classification.toUpperCase();
  const message = `${record.method} ${record.url} -> ${record.status ?? record.classification}`;
  const facts = [
    `${record.method} ${record.url} classified as ${record.classification}` +
      (record.status != null ? ` (status ${record.status})` : ""),
    `Latest request: ${record.requestId}${record.traceId ? `, trace ${record.traceId}` : ""}`,
    ...(record.contractMismatches?.slice(0, 5).map(
      (m) => `Contract mismatch at ${m.path}: expected ${m.expected}, got ${m.actual}`,
    ) ?? []),
    ...(record.errorMessage ? [`Reported error: ${record.errorMessage}`] : []),
  ];

  const existing = storage.findIncidentByFingerprint(fingerprint);
  if (existing) {
    const updated: IncidentRecord = {
      ...existing,
      status: "open",
      lastSeenAt: now,
      occurrenceCount: existing.occurrenceCount + 1,
      lastCommand: `${record.method} ${record.url}`,
      lastExitCode: record.status ?? null,
      message,
      facts,
      resolvedAt: undefined,
    };
    storage.appendIncident(updated);
    return updated;
  }

  const created: IncidentRecord = {
    schemaVersion: SCHEMA_VERSION,
    incidentId: storage.nextIncidentId(new Date(now)),
    fingerprint,
    kind: "NETWORK_FAILURE",
    errorType,
    message,
    status: "open",
    pinned: false,
    firstSeenAt: now,
    lastSeenAt: now,
    occurrenceCount: 1,
    lastCommand: `${record.method} ${record.url}`,
    lastCwd: "",
    lastExitCode: record.status ?? null,
    lastSignal: null,
    timedOut: record.classification === "timeout",
    relatedFiles: [],
    facts,
    hypotheses: [],
  };
  storage.appendIncident(created);
  return created;
}

/** After a SUCCESSFUL run: open incidents whose last command AND cwd match
 *  become resolve candidates (spec 4.4). The cwd check prevents a success in
 *  one service from marking another service's incident in a monorepo. */
export function markResolveCandidates(
  storage: Storage,
  command: string,
  cwd: string,
): IncidentRecord[] {
  return storage.withIncidentLock(() => {
    const marked: IncidentRecord[] = [];
    for (const inc of storage.readIncidents()) {
      if (inc.status === "open" && inc.lastCommand === command && inc.lastCwd === cwd) {
        const updated: IncidentRecord = { ...inc, status: "resolve_candidate" };
        storage.appendIncident(updated);
        marked.push(updated);
      }
    }
    return marked;
  });
}

export function setStatus(
  storage: Storage,
  id: string,
  status: IncidentRecord["status"],
): IncidentRecord | undefined {
  return storage.withIncidentLock(() => {
    const inc = storage.findIncident(id);
    if (!inc) return undefined;
    const updated: IncidentRecord = {
      ...inc,
      status,
      resolvedAt: status === "resolved" ? new Date().toISOString() : inc.resolvedAt,
    };
    storage.appendIncident(updated);
    return updated;
  });
}

export function setPinned(storage: Storage, id: string, pinned: boolean): IncidentRecord | undefined {
  return storage.withIncidentLock(() => {
    const inc = storage.findIncident(id);
    if (!inc) return undefined;
    const updated: IncidentRecord = { ...inc, pinned };
    storage.appendIncident(updated);
    return updated;
  });
}

function mergeFiles(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].slice(0, 10);
}

/** Recorder failures must never break the child command (spec 14). */
function safeWriteBlob(storage: Storage, incidentId: string, logText: string): string | undefined {
  try {
    return storage.writeLogBlob(incidentId, logText);
  } catch {
    return undefined;
  }
}
