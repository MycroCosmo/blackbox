import { Buffer } from "node:buffer";
import type { BlackboxConfig } from "./config.js";
import { findContract, validateAgainstSchema, type Contract, type ContractMismatch } from "./contracts.js";
import type { Redactor } from "./security.js";

/** Network event model, classification and payload policies (spec 5, 7.3, 7.4). */

export type NetworkClassification =
  | "success"
  | "http_error"
  | "network_error"
  | "timeout"
  | "aborted"
  | "cors_error"
  | "contract_mismatch"
  | "deserialization_error"
  | "empty_response"
  | "slow_response";

const CLIENT_ERROR_TYPES: NetworkClassification[] = [
  "network_error",
  "timeout",
  "aborted",
  "cors_error",
  "contract_mismatch",
  "deserialization_error",
];

/** Shape accepted on POST /events/network. Everything except request.method
 *  and request.url is optional so any language can report with plain HTTP. */
export interface NetworkEventInput {
  timestamp?: string;
  traceId?: string;
  source?: { application?: string; page?: string; action?: string };
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
  durationMs?: number;
  error?: { type?: string; message?: string };
  classification?: string;
}

export interface BodyMeta {
  truncated?: boolean;
  capturedBytes?: number;
  originalBytes?: number;
  excluded?: "binary";
}

export interface NetworkRecord {
  schemaVersion: number;
  requestId: string;
  sessionId: string;
  receivedAt: string;
  timestamp: string;
  traceId?: string;
  source?: { application?: string; page?: string; action?: string };
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  requestBodyMeta?: BodyMeta;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  responseBodyMeta?: BodyMeta;
  durationMs?: number;
  classification: NetworkClassification;
  contractMismatches?: ContractMismatch[];
  errorMessage?: string;
  /** Set when this failing event was linked to an incident (Phase 3). */
  incidentId?: string;
}

export function isFailure(c: NetworkClassification): boolean {
  return c !== "success" && c !== "slow_response";
}

/** HTTP 200 alone never means success (spec 5.4). */
export function classify(
  input: NetworkEventInput,
  config: BlackboxConfig,
): NetworkClassification {
  const claimed = (input.classification ?? input.error?.type) as
    | NetworkClassification
    | undefined;
  if (claimed && CLIENT_ERROR_TYPES.includes(claimed)) return claimed;

  const status = input.response?.status;
  if (input.error) return "network_error";
  if (status == null) return "network_error";
  if (status >= 400) return "http_error";
  // Only flag empty_response when the reporter explicitly included an empty body.
  if (
    input.response &&
    "body" in input.response &&
    (input.response.body === null || input.response.body === "")
  ) {
    return "empty_response";
  }
  if (input.durationMs != null && input.durationMs > config.network.slowResponseMs) {
    return "slow_response";
  }
  return "success";
}

export interface NetworkEvaluation {
  classification: NetworkClassification;
  contractMismatches?: ContractMismatch[];
  /** True when a registered contract matched this method and route. */
  contractChecked: boolean;
}

/** Applies the same status/body/contract rules for collection and replay so
 *  replay cannot declare a failure fixed using HTTP status alone. */
export function evaluateNetworkEvent(
  input: NetworkEventInput,
  config: BlackboxConfig,
  contracts: Contract[] = [],
): NetworkEvaluation {
  let classification = classify(input, config);
  let contractMismatches: ContractMismatch[] | undefined;
  let contractChecked = false;

  if (
    (classification === "success" || classification === "slow_response") &&
    input.response &&
    "body" in input.response
  ) {
    const contract = findContract(contracts, input.request.method, input.request.url);
    if (contract) {
      contractChecked = true;
      const mismatches = validateAgainstSchema(input.response.body, contract.responseSchema);
      if (mismatches.length > 0) {
        classification = "contract_mismatch";
        contractMismatches = mismatches;
      }
    }
  }

  return { classification, contractMismatches, contractChecked };
}

/** Sampling (spec 7.3): failures are ALWAYS stored; successes are sampled by
 *  route rules. Returns true when the event should be persisted. */
export function shouldStore(
  url: string,
  classification: NetworkClassification,
  config: BlackboxConfig,
  random: () => number = Math.random,
): boolean {
  if (isFailure(classification)) return true;
  const route = urlPath(url);
  const rule = config.sampling.rules.find((r) => route.startsWith(r.route));
  const rate = rule ? rule.rate : config.sampling.defaultRate;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return random() < rate;
}

function urlPath(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return url;
  }
}

const BINARY_CONTENT_TYPES =
  /^(image|video|audio)\/|^application\/(octet-stream|zip|gzip|pdf|x-tar)|^multipart\//i;
// A large unbroken base64-charset string that also uses base64-specific
// characters (+ / =). Plain long text (e.g. "aaaa…") must NOT match.
const BASE64_BLOB_RE = /^(?=[\s\S]*[+/=])[A-Za-z0-9+/=\r\n]{10000,}$/;

function contentType(headers?: Record<string, string>): string {
  if (!headers) return "";
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "content-type") return v;
  }
  return "";
}

/** Redacts, excludes binary, and truncates a payload (spec 7.4, 8). */
export function processBody(
  body: unknown,
  headers: Record<string, string> | undefined,
  maxBytes: number,
  redactor: Redactor,
  excludeBinary: boolean,
): { body?: unknown; meta?: BodyMeta } {
  if (body === undefined) return {};
  if (excludeBinary) {
    if (BINARY_CONTENT_TYPES.test(contentType(headers))) return { meta: { excluded: "binary" } };
    if (typeof body === "string" && BASE64_BLOB_RE.test(body)) return { meta: { excluded: "binary" } };
  }
  const redacted = redactor.redactObject(body);
  const serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= maxBytes) return { body: redacted };
  const captured = Buffer.from(serialized, "utf8").subarray(0, maxBytes).toString("utf8");
  return {
    body: captured,
    meta: { truncated: true, capturedBytes: Buffer.byteLength(captured, "utf8"), originalBytes },
  };
}

/** Validates and normalizes an incoming event into a storable record.
 *  Throws Error with a message suitable for a 400 response. */
export function buildNetworkRecord(
  input: unknown,
  ids: { requestId: string; sessionId: string },
  config: BlackboxConfig,
  redactor: Redactor,
  contracts: Contract[] = [],
  now = new Date(),
): NetworkRecord {
  if (typeof input !== "object" || input === null) throw new Error("body must be a JSON object");
  const ev = input as NetworkEventInput;
  if (!ev.request || typeof ev.request.method !== "string" || typeof ev.request.url !== "string") {
    throw new Error("request.method and request.url are required");
  }
  // Contract validation runs on the raw body before redaction/truncation so
  // types and required keys remain intact.
  const evaluation = evaluateNetworkEvent(ev, config, contracts);
  const req = processBody(
    ev.request.body,
    ev.request.headers,
    config.network.maxRequestBodyBytes,
    redactor,
    config.network.excludeBinaryBody,
  );
  const res = processBody(
    ev.response?.body,
    ev.response?.headers,
    config.network.maxResponseBodyBytes,
    redactor,
    config.network.excludeBinaryBody,
  );
  return {
    schemaVersion: 1,
    requestId: ids.requestId,
    sessionId: ids.sessionId,
    receivedAt: now.toISOString(),
    timestamp: typeof ev.timestamp === "string" ? ev.timestamp : now.toISOString(),
    traceId: typeof ev.traceId === "string" ? redactor.redactLine(ev.traceId) : undefined,
    source: ev.source ? redactor.redactObject(ev.source) : undefined,
    method: ev.request.method.toUpperCase(),
    url: redactor.redactUrl(ev.request.url),
    requestHeaders: ev.request.headers ? redactor.redactObject(ev.request.headers) : undefined,
    requestBody: req.body,
    requestBodyMeta: req.meta,
    status: ev.response?.status,
    responseHeaders: ev.response?.headers ? redactor.redactObject(ev.response.headers) : undefined,
    responseBody: res.body,
    responseBodyMeta: res.meta,
    durationMs: ev.durationMs,
    classification: evaluation.classification,
    contractMismatches: evaluation.contractMismatches,
    errorMessage: ev.error?.message ? redactor.redactLine(ev.error.message) : undefined,
  };
}
