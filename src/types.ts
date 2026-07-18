/** Shared data model. JSON output schemas built from these types are
 *  backward-compatible within a major version (see spec 3.7). */

export const SCHEMA_VERSION = 1;

export interface ErrorLocation {
  file: string;
  line?: number;
  function?: string;
}

export type IncidentKind =
  | "PROCESS_FAILURE"
  | "TIMEOUT"
  | "SIGNAL"
  | "SOFT_SIGNAL"
  | "NETWORK_FAILURE"
  | "MANUAL";

export type IncidentStatus = "open" | "resolve_candidate" | "resolved";

export interface IncidentRecord {
  schemaVersion: number;
  incidentId: string;
  fingerprint: string;
  kind: IncidentKind;
  errorType: string;
  message: string;
  status: IncidentStatus;
  pinned: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  lastCommand: string;
  lastCwd: string;
  lastExitCode: number | null;
  lastSignal: string | null;
  timedOut: boolean;
  /** Most-recent error location. Line numbers live here, never in the fingerprint. */
  lastLocation?: ErrorLocation;
  relatedFiles: string[];
  /** Path of the gzipped log blob, relative to the .dev-blackbox root. */
  logBlob?: string;
  facts: string[];
  hypotheses: { description: string; confidence?: number }[];
  resolvedAt?: string;
}

export interface CommandRecord {
  schemaVersion: number;
  sessionId: string;
  command: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  incidentId?: string;
}

export interface SoftSignal {
  errorType: string;
  message: string;
  location?: ErrorLocation;
  relatedFiles: string[];
  /** The log lines this signal was extracted from (already redacted). */
  excerpt: string[];
}

export interface RunOutcome {
  exitCode: number;
  incidentId?: string;
}
