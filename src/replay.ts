import { setStatus } from "./incident.js";
import { loadConfig, type BlackboxConfig } from "./config.js";
import { loadContracts } from "./contracts.js";
import {
  evaluateNetworkEvent,
  isFailure,
  type NetworkClassification,
  type NetworkRecord,
} from "./network.js";
import type { Storage } from "./storage.js";

/** Request replay (spec 8 Replay 안전 규칙, Phase 3).
 *  - Only idempotent methods (GET/HEAD/OPTIONS) replay by default; anything
 *    else requires the explicit --allow-unsafe flag.
 *  - External URLs (anything not loopback) are ALWAYS blocked.
 *  - Every replayed request carries `X-Dev-Blackbox-Replay: true`.
 *  - The previous and current responses are compared; if a failing request
 *    now succeeds, its linked incident becomes a resolve candidate. */

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface ReplayResult {
  schemaVersion: number;
  requestId: string;
  replayedAt: string;
  method: string;
  targetUrl: string;
  before: { status?: number; classification: string };
  after: { status: number; body?: unknown; classification: NetworkClassification };
  statusChanged: boolean;
  bodyDiff: string[];
  /** Set when the linked incident was marked as a resolve candidate. */
  resolveCandidate?: string;
}

export interface ReplayOptions {
  allowUnsafe?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  config?: BlackboxConfig;
}

export async function replayRequest(
  storage: Storage,
  requestId: string,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const record = storage.findNetwork(requestId);
  if (!record) throw new Error(`network event not found: ${requestId}`);

  if (!IDEMPOTENT.has(record.method) && !opts.allowUnsafe) {
    throw new Error(
      `${record.method} is not idempotent — replaying it repeats its side effects. ` +
        `Re-run with --allow-unsafe only after the user confirmed.`,
    );
  }

  const target = resolveTarget(record, opts.baseUrl);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(record.requestHeaders ?? {})) {
    // Redacted values are placeholders, not credentials — never send them.
    if (!v.includes("[REDACTED]") && k.toLowerCase() !== "content-length") headers[k] = v;
  }
  headers["X-Dev-Blackbox-Replay"] = "true";
  if (record.traceId) headers["X-Dev-Blackbox-Trace-Id"] = record.traceId;

  let body: string | undefined;
  if (
    record.requestBody !== undefined &&
    !record.requestBodyMeta && // never replay truncated/excluded bodies
    !["GET", "HEAD"].includes(record.method)
  ) {
    if (containsRedacted(record.requestBody)) {
      throw new Error("recorded request body contains redacted values and cannot be replayed safely");
    }
    body = typeof record.requestBody === "string" ? record.requestBody : JSON.stringify(record.requestBody);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
  }

  const startedAt = Date.now();
  const res = await fetchLoopback(target, {
    method: record.method,
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  const text = await res.text();
  const parsed = parseBody(text, res.headers.get("content-type"));
  const newBody = parsed.body;
  const config = opts.config ?? loadConfig(storage.root);
  const responseForEvaluation = {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    ...(record.method === "HEAD" || res.status === 204 || res.status === 205
      ? {}
      : { body: text === "" ? "" : newBody }),
  };
  const evaluation = evaluateNetworkEvent(
    {
      request: { method: record.method, url: record.url },
      response: responseForEvaluation,
      durationMs: Date.now() - startedAt,
      classification: parsed.deserializationError ? "deserialization_error" : undefined,
    },
    config,
    loadContracts(storage),
  );

  const result: ReplayResult = {
    schemaVersion: 1,
    requestId: record.requestId,
    replayedAt: new Date().toISOString(),
    method: record.method,
    targetUrl: target,
    before: { status: record.status, classification: record.classification },
    after: { status: res.status, body: newBody, classification: evaluation.classification },
    statusChanged: record.status !== res.status,
    bodyDiff: diffValues(record.responseBody, newBody),
  };

  // Phase 3: fix verification — the failure no longer reproduces.
  const recoveryIsVerified =
    !isFailure(evaluation.classification) &&
    (record.classification !== "contract_mismatch" || evaluation.contractChecked);
  if (isFailure(record.classification) && recoveryIsVerified && record.incidentId) {
    const updated = setStatus(storage, record.incidentId, "resolve_candidate");
    if (updated) result.resolveCandidate = updated.incidentId;
  }

  return result;
}

function resolveTarget(record: NetworkRecord, baseUrl?: string): string {
  let url: URL;
  if (/^https?:\/\//i.test(record.url)) {
    url = new URL(record.url);
  } else {
    if (!baseUrl) {
      throw new Error(
        `the recorded URL is relative (${record.url}) — pass --base-url, e.g. --base-url http://127.0.0.1:8080`,
      );
    }
    url = new URL(record.url, baseUrl);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`replay to external hosts is blocked (${url.hostname}); only 127.0.0.1/localhost is allowed`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`replay protocol is blocked (${url.protocol}); only HTTP(S) loopback URLs are allowed`);
  }
  if (url.toString().includes("REDACTED")) {
    throw new Error("recorded URL contains redacted values and cannot be replayed safely");
  }
  return url.toString();
}

function parseBody(
  text: string,
  contentType: string | null,
): { body: unknown; deserializationError: boolean } {
  try {
    return { body: JSON.parse(text), deserializationError: false };
  } catch {
    return {
      body: text === "" ? undefined : text,
      deserializationError: text !== "" && Boolean(contentType?.toLowerCase().includes("json")),
    };
  }
}

async function fetchLoopback(target: string, init: RequestInit): Promise<Response> {
  let current = new URL(target);
  let method = String(init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);

  for (let redirects = 0; ; redirects++) {
    assertLoopback(current);
    const response = await fetch(current, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects >= 5) throw new Error("replay redirect limit exceeded");
    const next = new URL(location, current);
    assertLoopback(next);

    if (
      (response.status === 303 && method !== "GET" && method !== "HEAD") ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      method = "GET";
      body = undefined;
      headers.delete("content-length");
      headers.delete("content-type");
    }
    current = next;
  }
}

function assertLoopback(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`replay protocol is blocked (${url.protocol}); only HTTP(S) loopback URLs are allowed`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`replay to external hosts is blocked (${url.hostname}); only 127.0.0.1/localhost is allowed`);
  }
}

function containsRedacted(value: unknown): boolean {
  if (typeof value === "string") return value.includes("[REDACTED]");
  if (Array.isArray(value)) return value.some(containsRedacted);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsRedacted);
  }
  return false;
}

/** Shallow-to-deep structural diff, reported as human/agent-readable paths.
 *  Capped at 20 entries. */
export function diffValues(before: unknown, after: unknown, atPath = "$", out: string[] = []): string[] {
  if (out.length >= 20) return out;
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  const bt = valueType(before);
  const at = valueType(after);
  if (bt !== at) {
    out.push(`${atPath}: ${bt} (${short(before)}) -> ${at} (${short(after)})`);
    return out;
  }
  if (bt === "object") {
    const b = before as Record<string, unknown>;
    const a = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!(key in a)) out.push(`${atPath}.${key}: removed (was ${short(b[key])})`);
      else if (!(key in b)) out.push(`${atPath}.${key}: added (${short(a[key])})`);
      else diffValues(b[key], a[key], `${atPath}.${key}`, out);
      if (out.length >= 20) return out;
    }
    return out;
  }
  if (bt === "array") {
    const b = before as unknown[];
    const a = after as unknown[];
    if (b.length !== a.length) out.push(`${atPath}: array length ${b.length} -> ${a.length}`);
    const n = Math.min(b.length, a.length, 10);
    for (let i = 0; i < n; i++) diffValues(b[i], a[i], `${atPath}[${i}]`, out);
    return out;
  }
  out.push(`${atPath}: ${short(before)} -> ${short(after)}`);
  return out;
}

function valueType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 60 ? s.slice(0, 57) + "..." : s;
}
