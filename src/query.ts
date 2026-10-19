import { createHash } from "node:crypto";
import { isFailure, type NetworkRecord } from "./network.js";
import { applicationFrames } from "./request-profile.js";
import type { Storage } from "./storage.js";

export type Query = Record<string, unknown>;
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v, null, 2));
function number(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`expected integer ${min}..${max}`);
  return n;
}
function budget(q: Query) { return number(q.maxBytes, 16384, 4096, 262144); }
function validateView(q: Query) {
  if (q.view !== undefined && q.view !== "detail" && q.view !== "raw") throw new Error("view must be detail or raw");
  if (q.section !== undefined && !["logs", "stack", "event"].includes(String(q.section))) throw new Error("section must be logs, stack or event");
}
function encode(v: unknown) { return Buffer.from(JSON.stringify(v)).toString("base64url"); }
function decode(v: unknown): Record<string, any> {
  try {
    if (typeof v !== "string" || v.length > 4096) throw new Error();
    const parsed = JSON.parse(Buffer.from(v, "base64url").toString());
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) throw new Error();
    return parsed;
  } catch { throw new Error("invalid cursor; restart the query"); }
}
function signature(q: Query, kind: string) {
  return createHash("sha256").update(JSON.stringify([kind, "recent-first-v2", ...["since", "until", "service", "requestId", "traceId", "incidentId", "error", "status", "failedOnly"].map(k => q[k] ?? null)])).digest("hex").slice(0, 16);
}
function time(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) throw new Error("time filter must be an ISO timestamp");
  return Date.parse(v);
}
function match(e: NetworkRecord, q: Query) {
  const since = time(q.since), until = time(q.until);
  return (since === undefined || Date.parse(e.timestamp) >= since) &&
    (until === undefined || Date.parse(e.timestamp) <= until) &&
    (!q.service || e.source?.application === q.service) &&
    (!q.requestId || e.requestId === q.requestId) &&
    (!q.traceId || e.traceId === q.traceId) &&
    (!q.incidentId || e.incidentId === q.incidentId) &&
    (!q.error || `${e.profile?.exception?.type} ${e.profile?.exception?.message} ${e.profile?.exception?.causes.map(c => c.type + " " + c.message).join(" ")} ${e.errorMessage} ${e.classification}`.toLowerCase().includes(String(q.error).toLowerCase())) &&
    (!q.failedOnly || isFailure(e.classification));
}
export function networkSummary(e: NetworkRecord) {
  return { requestId: e.requestId, timestamp: e.timestamp, receivedAt: e.receivedAt,
    traceId: e.traceId, service: e.source?.application, method: e.method, url: e.url.slice(0, 512),
    ...(e.url.length > 512 ? { urlTruncated: true } : {}),
    status: e.status, durationMs: e.durationMs, classification: e.classification, incidentId: e.incidentId };
}

/** Network cursors use immutable persisted IDs, never timestamps supplied by applications. */
export function listRecords(storage: Storage, q: Query, kind: "events" | "incidents") {
  const since = time(q.since), until = time(q.until);
  const all = storage.readNetwork();
  const sig = signature(q, kind);
  const c = q.cursor ? decode(q.cursor) : undefined;
  const after = q.after ? decode(q.after) : undefined;
  if (c && (c.kind !== kind || c.sig !== sig)) throw new Error("cursor filters changed; restart query");
  if (after && (after.kind !== kind || after.sig !== sig)) throw new Error("after filters changed; restart query");
  const index = (id: string | undefined) => {
    if (!id) return -1;
    const i = all.findIndex(e => e.requestId === id);
    if (i < 0) throw new Error("cursor expired by retention; restart query (a gap may exist)");
    return i;
  };
  const end = c ? index(c.end) : all.length - 1;
  const start = index(c?.after ?? after?.end);
  const selected = all.slice(start + 1, end + 1).filter(e => match(e, q));
  let rows: unknown[];
  if (kind === "events") rows = selected.map(networkSummary);
  else {
    const incidents = storage.readIncidents();
    const groups = new Map<string, NetworkRecord[]>();
    for (const e of selected) if (e.incidentId) {
      const group = groups.get(e.incidentId) ?? []; group.push(e); groups.set(e.incidentId, group);
    }
    const filtered = Boolean(q.service || q.requestId || q.traceId || q.after || c?.after);
    rows = incidents.filter(i => (!q.status || (q.status === "unresolved" ? i.status !== "resolved" : i.status === q.status)) &&
      (i.kind === "NETWORK_FAILURE" ? groups.has(i.incidentId) : !filtered &&
        (!q.incidentId || i.incidentId === q.incidentId) &&
        (!q.error || `${i.errorType} ${i.message}`.toLowerCase().includes(String(q.error).toLowerCase())) &&
        (since === undefined || Date.parse(i.lastSeenAt) >= since) && (until === undefined || Date.parse(i.lastSeenAt) <= until))).map(i => {
      const occurrences = groups.get(i.incidentId) ?? [];
      const latest = occurrences.at(-1);
      return { incidentId: i.incidentId, kind: i.kind, status: i.status, errorType: i.errorType.slice(0, 128),
        message: i.message.replace(/\s+/g, " ").slice(0, 180),
        path: latest ? latest.url.split("?")[0]!.slice(0, 512) : undefined,
        service: latest?.source?.application, occurrenceCount: i.occurrenceCount,
        matchingOccurrences: occurrences.length, firstSeenAt: i.firstSeenAt, lastSeenAt: i.lastSeenAt,
        representativeRequestId: occurrences[0]?.requestId, latestRequestId: latest?.requestId };
    });
  }
  // Latest occurrence inside the captured snapshot: repeats move old groups to the top,
  // but arrivals between pages cannot reorder that snapshot.
  const key = (row: any) => kind === "events" ? row.requestId
    : `${(row.latestRequestId ?? row.incidentId).slice(4)}:${row.incidentId}`;
  if (c?.lastKey) rows = rows.filter(row => key(row).localeCompare(c.lastKey, undefined, { numeric: true }) < 0);
  rows.sort((a, b) => key(b).localeCompare(key(a), undefined, { numeric: true }));
  const offset = 0;
  const limit = number(q.limit, 20, 1, 200);
  const state = { v: 1, kind, sig, end: all[end]?.requestId, after: c?.after ?? after?.end };
  const page: Record<string, any> = { schemaVersion: 1, [kind]: [], truncated: false,
    nextCursor: null, pollCursor: encode({ ...state, after: undefined }), totalMatched: rows.length };
  let n = offset;
  while (n < rows.length && n - offset < limit) {
    page[kind].push(rows[n]);
    page.nextCursor = encode({ ...state, lastKey: key(rows[n]) });
    if (bytes(page) > budget(q)) { page[kind].pop(); break; }
    n++;
  }
  if (n === offset && n < rows.length) throw new Error("row exceeds maxBytes; increase maxBytes or narrow filters");
  page.truncated = n < rows.length;
  page.nextCursor = page.truncated ? encode({ ...state, lastKey: key(rows[n - 1]) }) : null;
  return page;
}

function rawPage(text: string, q: Query, identity: string) {
  const c = q.cursor ? decode(q.cursor) : undefined;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  if (c && (c.identity !== identity || c.hash !== hash)) throw new Error("raw cursor expired or belongs to another record/section");
  const offset = number(c?.offset, 0, 0, text.length);
  let count = Math.min(text.length - offset, budget(q));
  const build = (length: number) => {
    if (/[\uD800-\uDBFF]/.test(text.charAt(offset + length - 1)) && offset + length < text.length) length--;
    return { identity, offset, text: text.slice(offset, offset + length),
      truncated: offset + length < text.length, totalCharacters: text.length,
      nextCursor: offset + length < text.length ? encode({ v: 1, identity, hash, offset: offset + length }) : null };
  };
  let out = build(count);
  while (bytes(out) > budget(q)) { count = Math.floor(count * 0.8); out = build(count); }
  return out;
}

export function getNetwork(storage: Storage, id: string, q: Query = {}) {
  validateView(q);
  const e = storage.findNetwork(id);
  if (!e) throw new Error(`network event not found: ${id}`);
  if (q.view === "raw") {
    if (e.profileExpired && q.section !== "event") throw new Error("profile expired by retention");
    const ex = e.profile?.exception;
    const text = q.section === "logs" ? (e.profile?.logs ?? []).join("\n") : q.section === "stack"
      ? [ex, ...(ex?.causes ?? [])].filter(Boolean).map(x => `${x!.type}: ${x!.message}\n${x!.stack.join("\n")}`).join("\nCaused by: ")
      : JSON.stringify(e, null, 2);
    const startLine = number(q.startLine, 1, 1, Number.MAX_SAFE_INTEGER);
    const lineCount = number(q.lineCount, Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    const selected = text.split("\n").slice(startLine - 1, startLine - 1 + lineCount).join("\n");
    return rawPage(selected, q, `${e.requestId}:${q.section ?? "event"}:${startLine}:${lineCount}`);
  }
  const ex = e.profile?.exception;
  const cause = ex?.causes.at(-1) ?? ex;
  const frames = cause ? applicationFrames(cause.stack) : [];
  const out: Record<string, any> = { event: networkSummary(e),
    exception: ex && { type: ex.type, message: ex.message.slice(0, 512) },
    rootCause: cause && { type: cause.type, message: cause.message.slice(0, 512), frames: frames.map(f => f.slice(0, 512)) },
    logPreview: isFailure(e.classification) ? [...new Set(e.profile?.logs ?? [])].slice(-5) : [],
    profile: { logLines: e.profile?.logs.length ?? 0, droppedLogs: e.profile?.droppedLogs ?? 0,
      truncated: e.profile?.truncated ?? false, incomplete: e.profile?.incomplete ?? false, expired: e.profileExpired ?? false },
    raw: { requestId: e.requestId, view: "raw", section: "logs", sections: ["logs", "stack", "event"] }, truncated: frames.some(f => f.length > 512) };
  while (bytes(out) > budget(q) && out.logPreview.length) { out.logPreview.shift(); out.truncated = true; }
  while (bytes(out) > budget(q) && out.rootCause?.frames.length) { out.rootCause.frames.pop(); out.truncated = true; }
  if (bytes(out) > budget(q)) return { event: { requestId: e.requestId, incidentId: e.incidentId }, truncated: true, raw: out.raw };
  return out;
}

export function getIncident(storage: Storage, id: string, q: Query = {}) {
  validateView(q);
  const inc = storage.findIncident(id);
  if (!inc) throw new Error(`incident not found: ${id}`);
  const events = storage.readNetwork().filter(e => e.incidentId === inc.incidentId);
  const e = q.requestId ? events.find(e => e.requestId === q.requestId) : events.at(-1);
  if (q.requestId && !e) throw new Error("request does not belong to incident");
  if (e) {
    const out: Record<string, any> = { incident: { incidentId: inc.incidentId, occurrenceCount: inc.occurrenceCount },
      occurrenceQuery: { incidentId: inc.incidentId }, ...getNetwork(storage, e.requestId, { ...q, maxBytes: Math.max(4096, budget(q) - 1024) }) };
    while (bytes(out) > budget(q) && out.logPreview?.length) { out.logPreview.shift(); out.truncated = true; }
    if (bytes(out) > budget(q)) {
      // Raw continuation belongs to the request; return it without the extra incident envelope.
      return getNetwork(storage, e.requestId, q);
    }
    return out;
  }
  const log = inc.logBlob ? storage.readLogBlob(inc.logBlob) ?? "" : "";
  if (q.view === "raw") return rawPage(log, q, inc.incidentId);
  const out = { incident: { incidentId: inc.incidentId, kind: inc.kind, errorType: inc.errorType,
    message: inc.message.slice(0, 512), occurrenceCount: inc.occurrenceCount, lastSeenAt: inc.lastSeenAt,
    lastLocation: inc.lastLocation, attempts: inc.attempts?.slice(-3),
    rootCause: inc.rootCause && { errorType: inc.rootCause.errorType, message: inc.rootCause.message.slice(0, 512), location: inc.rootCause.location } },
    logTail: [] as string[], raw: { incidentId: inc.incidentId, view: "raw" }, truncated: false };
  if (bytes(out) > budget(q)) return { incident: { incidentId: inc.incidentId }, truncated: true, raw: out.raw };
  return out;
}

export const queryProperties = {
  since: { type: "string" }, until: { type: "string" }, service: { type: "string" },
  requestId: { type: "string" }, traceId: { type: "string" }, incidentId: { type: "string" }, error: { type: "string" },
  limit: { type: "integer", minimum: 1, maximum: 200 }, maxBytes: { type: "integer", minimum: 4096, maximum: 262144 },
  cursor: { type: "string", description: "nextCursor from previous page; keep filters" },
  after: { type: "string", description: "pollCursor after draining all pages; keep filters" },
  view: { type: "string", enum: ["detail", "raw"] }, section: { type: "string", enum: ["logs", "stack", "event"] },
  startLine: { type: "integer", minimum: 1, description: "1-based raw line start" },
  lineCount: { type: "integer", minimum: 1, description: "raw lines to select before byte pagination" },
};
