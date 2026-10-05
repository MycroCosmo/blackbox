import path from "node:path";
import type { ErrorLocation } from "./types.js";

/** Fingerprinting (spec 4.4):
 *  fingerprint = error type + normalized message + top application frame
 *  (file basename + function). Line numbers are deliberately EXCLUDED so
 *  unrelated edits that shift lines do not split an incident. */

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_RE = /\b0x[0-9a-fA-F]+\b/g;
const LONG_HEX_RE = /\b[0-9a-f]{12,}\b/gi;
const QUOTED_RE = /(["'`])(?:\\.|(?!\1).)*\1/g;
const WIN_PATH_RE = /[A-Za-z]:\\[^\s:'"`)]+/g;
const UNIX_PATH_RE = /(?:^|[\s('"`])((?:\/[\w.-]+){2,})/g;
const NUMBER_RE = /\b\d+\b/g;
// Java's default toString(): `MergedContextConfiguration@30c1da48`. The hash
// changes on every JVM start, so without this every Spring context failure
// would look like a new incident.
const IDENTITY_HASH_RE = /([A-Za-z_$][\w$]*)@[0-9a-f]{1,8}\b/g;

/** Replaces volatile values (ids, numbers, paths, quoted args) with
 *  placeholders so the same logical error always produces the same message. */
export function normalizeMessage(message: string): string {
  return message
    .replace(UUID_RE, "<id>")
    .replace(IDENTITY_HASH_RE, "$1@<hex>")
    .replace(HEX_RE, "<hex>")
    .replace(LONG_HEX_RE, "<hex>")
    .replace(WIN_PATH_RE, (m) => `<path:${path.basename(m)}>`)
    .replace(UNIX_PATH_RE, (m, p: string) => m.replace(p, `<path:${path.posix.basename(p)}>`))
    .replace(QUOTED_RE, "<str>")
    .replace(NUMBER_RE, "<n>")
    .trim();
}

/** Normalizes volatile values within each URL path segment without letting
 * the generic Unix-path rule collapse the whole route to its basename.
 * Thus `/api/todos/42` and `/api/todos/977` merge, while `/charge/42` and
 * `/refund/42` remain distinct incidents. */
export function normalizeRoutePath(route: string): string {
  return route
    .split("/")
    // An API version is part of the route's identity, not a volatile id:
    // /api/v1/users and /api/v2/users are different endpoints.
    .map((segment) => (/^v\d+$/i.test(segment) ? segment : normalizeMessage(segment)))
    .join("/");
}

export function fingerprintFromError(
  errorType: string,
  message: string,
  location?: ErrorLocation,
): string {
  const parts = [errorType, normalizeMessage(message)];
  if (location) {
    parts.push(
      `${path.basename(location.file)}${location.function ? ":" + location.function : ""}`,
    );
  }
  return parts.join("|");
}

/** Fallback fingerprint when a process fails without a recognizable error
 *  pattern: kind + exit code/signal + normalized command + cwd. The cwd is
 *  included so the same command failing in DIFFERENT services of a monorepo
 *  (e.g. `npm test` in service-a vs service-b) never merges. */
export function fingerprintFromProcess(
  kind: string,
  command: string,
  exitCode: number | null,
  signal: string | null,
  cwd: string,
): string {
  return [kind, signal ?? `exit:${exitCode}`, normalizeMessage(command), cwd].join("|");
}
