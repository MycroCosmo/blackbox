import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { startCollector, type Collector } from "../src/collector-server.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { Storage } from "../src/storage.js";
import { createMcpTools } from "../src/mcp-server.js";
import { getNetwork, listRecords, getIncident } from "../src/query.js";
import { prune } from "../src/retention.js";
import { diagnose } from "../src/diagnostics.js";

let dir: string, storage: Storage, collector: Collector;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbb-trace-"));
  storage = new Storage(path.join(dir, ".dev-blackbox"));
  collector = await startCollector({ storage, config: DEFAULT_CONFIG, port: 0 });
});
afterEach(async () => { await collector.close(); fs.rmSync(dir, { recursive: true, force: true }); });
const event = (id = "one", cause = "inventory unavailable", service = "api") => ({
  traceId: id, source: { application: service }, timestamp: "2026-10-19T00:00:00.000Z",
  request: { method: "GET", url: "/checkout/42?token=secret-query" }, response: { status: 500 }, durationMs: 12,
  profile: { logs: [`marker=${id} password=secret-password cookie=secret-cookie`, "Authorization: Bearer abcdefghijkl"],
    exception: { type: "java.lang.IllegalStateException", message: "checkout failed", stack: ["at app.Controller.checkout(Controller.java:10)"],
      causes: [{ type: "java.lang.IllegalArgumentException", message: cause, stack: ["at app.Inventory.load(Inventory.java:20)", "at java.lang.Thread.run(Thread.java:1)"] }] } },
});
async function post(body: unknown) {
  const r = await fetch(`http://127.0.0.1:${collector.port}/events/network`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

it("joins only explicit requests, groups repeats but separates causes and services, and masks every view", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post(event(`r-${i}`))));
  await post(event("different", "currency unsupported"));
  await post(event("service", "inventory unavailable", "other"));
  expect(new Set(results.map(r => r.body.incidentId)).size).toBe(1);
  expect(storage.readIncidents()).toHaveLength(3);
  expect(storage.readIncidents()[0]!.occurrenceCount).toBe(8);
  for (let i = 0; i < results.length; i++) {
    const e = storage.findNetwork(results[i]!.body.requestId)!;
    expect(e.profile!.logs[0]).toContain(`marker=r-${i} `);
    expect(e.profile!.logs).toHaveLength(2);
  }
  const { call } = createMcpTools(storage, DEFAULT_CONFIG);
  const list: any = await call("list_incidents", { service: "api" });
  expect(list.incidents).toHaveLength(2);
  expect(JSON.stringify(list)).not.toContain("stack");
  const detail: any = await call("get_incident", { incidentId: list.incidents.find((i: any) => i.occurrenceCount === 8).incidentId });
  expect(detail.rootCause.message).toBe("inventory unavailable");
  expect(detail.rootCause.frames).toEqual(["at app.Inventory.load(Inventory.java:20)"]);
  const raw = await call("get_network_request", { requestId: detail.event.requestId, view: "raw" });
  for (const value of [list, detail, raw, fs.readFileSync(storage.networkFile, "utf8")]) {
    expect(JSON.stringify(value)).not.toMatch(/secret-password|secret-cookie|secret-query|abcdefghijkl/);
  }
});

it("paginates stable occurrences, polls repeats and detects expired or mismatched cursors", async () => {
  await Promise.all([post(event("1")), post(event("2")), post(event("3"))]);
  const first: any = listRecords(storage, { limit: 1, service: "api" }, "events");
  await post(event("4"));
  const second: any = listRecords(storage, { limit: 10, service: "api", cursor: first.nextCursor }, "events");
  expect(second.events).toHaveLength(2);
  const fresh: any = listRecords(storage, { service: "api", after: first.pollCursor }, "events");
  expect(fresh.events).toHaveLength(1);
  const grouped: any = listRecords(storage, { service: "api" }, "incidents");
  await post(event("5"));
  expect((listRecords(storage, { service: "api", after: grouped.pollCursor }, "incidents") as any).incidents[0].matchingOccurrences).toBe(1);
  expect(() => listRecords(storage, { cursor: first.nextCursor }, "events")).toThrow(/filters/);
  storage.compactNetwork([]);
  expect(() => listRecords(storage, { service: "api", after: first.pollCursor }, "events")).toThrow(/expired/);
  const before = storage.nextRequestSeq().next;
  expect(before).toBe(6);
});

it("shows recent occurrences first, keeps page snapshots and polls later repeats", async () => {
  const old = await post(event("old"));
  for (let i = 0; i < 24; i++) await post(event(`unique-${i}`, `cause ${String.fromCharCode(65 + i)}`));
  const repeated = await post(event("repeat"));
  const page: any = listRecords(storage, { limit: 20 }, "incidents");
  expect(page.incidents[0].incidentId).toBe(old.body.incidentId);
  expect(page.incidents[0].latestRequestId).toBe(repeated.body.requestId);
  await post(event("between-pages", "cause A"));
  const next: any = listRecords(storage, { cursor: page.nextCursor }, "incidents");
  expect(next.incidents).toHaveLength(5);
  expect(new Set([...page.incidents, ...next.incidents].map(i => i.incidentId)).size).toBe(25);
  const fresh: any = listRecords(storage, { after: next.pollCursor }, "incidents");
  expect(fresh.incidents).toHaveLength(1);
  expect(fresh.incidents[0].matchingOccurrences).toBe(1);
});

it("masks prefixed colon secrets in storage, detail and paged raw MCP responses", async () => {
  const e = event();
  e.profile.logs = ["2026-10-19 INFO app password: secret-colon words", "INFO app Authorization: Basic c2VjcmV0", "INFO app api_key: secret-key"];
  const { body } = await post(e);
  const { call } = createMcpTools(storage, DEFAULT_CONFIG);
  for (const value of [fs.readFileSync(storage.networkFile, "utf8"),
    await call("get_incident", { incidentId: body.incidentId }),
    await call("get_network_request", { requestId: body.requestId, view: "raw", section: "event" }),
    await call("get_network_request", { requestId: body.requestId, view: "raw", section: "logs" })])
    expect(JSON.stringify(value)).not.toMatch(/secret-colon|c2VjcmV0|secret-key/);
});

it("reserves recent logs even when exception frames consume their budget", async () => {
  const e = event();
  e.profile.exception.causes[0]!.stack = Array.from({ length: 256 }, () => "at app." + "x".repeat(4000));
  e.profile.logs = [...Array.from({ length: 550 }, (_, i) => `INFO ${i}`), "ERROR database pool exhausted"];
  const { body } = await post(e);
  const detail: any = getNetwork(storage, body.requestId);
  expect(detail.logPreview).toContain("ERROR database pool exhausted");
  expect(detail.exception.type).toBe("java.lang.IllegalStateException");
  expect(detail.rootCause.type).toBe("java.lang.IllegalArgumentException");
  expect(detail.profile.truncated).toBe(true);
});

it("bounds raw and detail JSON, reports truncation and reconstructs raw text without loss", async () => {
  const e = event();
  e.profile.logs = Array.from({ length: 700 }, (_, i) => `line ${i} ${"한글😀".repeat(80)} token=secret-token`);
  e.profile.exception.stack = Array.from({ length: 400 }, (_, i) => `at app.Deep.call(Deep.java:${i})`);
  const { body } = await post(e);
  const stored = storage.findNetwork(body.requestId)!;
  expect(stored.profile!.truncated).toBe(true);
  let cursor: string | undefined, text = "", pages = 0;
  do {
    const page: any = getNetwork(storage, body.requestId, { view: "raw", section: "logs", cursor, maxBytes: 4096 });
    expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThanOrEqual(4096);
    text += page.text; cursor = page.nextCursor; pages++;
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(text).toBe(stored.profile!.logs.join("\n"));
  expect(text).not.toContain("secret-token");
  for (const q of [getNetwork(storage, body.requestId, { maxBytes: 4096 }), getIncident(storage, body.incidentId, { maxBytes: 4096 })])
    expect(Buffer.byteLength(JSON.stringify(q, null, 2))).toBeLessThanOrEqual(4096);
});

it("validates profile, time and budget; masks multiline PEM; records collector status", async () => {
  expect((await post({ ...event(), profile: { logs: [123] } })).status).toBe(400);
  const e = event(); e.profile.logs = ["-----BEGIN PRIVATE KEY-----", "very-private-material", "-----END PRIVATE KEY-----"];
  const r = await post(e);
  expect(JSON.stringify(storage.findNetwork(r.body.requestId))).not.toContain("very-private-material");
  expect(() => listRecords(storage, { since: "bad" }, "events")).toThrow(/timestamp/);
  expect(() => listRecords(storage, { limit: -1 }, "events")).toThrow();
  const health = await (await fetch(`http://127.0.0.1:${collector.port}/health`)).json();
  expect(health).toMatchObject({ accepted: 1, rejected: 1 });
  expect(health.lastEventAt).toBeTruthy();
});

it("normalizes labeled request IDs and timestamps, while retaining different root causes", async () => {
  const a = await post(event("a", "inventory unavailable requestId=alpha at 2026-10-19T00:00:00Z"));
  const b = await post(event("b", "inventory unavailable requestId=beta at 2026-10-20T12:14:22Z"));
  expect(a.body.incidentId).toBe(b.body.incidentId);
  const raw: any = getNetwork(storage, a.body.requestId, { view: "raw", section: "logs", startLine: 2, lineCount: 1 });
  expect(raw.text).toBe("Authorization: [REDACTED]");
  expect(() => getNetwork(storage, a.body.requestId, { view: "typo" })).toThrow(/view/);
});

it("expires profiles under existing retention policy and rejects new data at storage cap", async () => {
  const r = await post(event());
  const old = storage.findNetwork(r.body.requestId)!;
  storage.compactNetwork([{ ...old, receivedAt: "2020-01-01T00:00:00Z" }]);
  prune(storage, DEFAULT_CONFIG);
  expect(storage.findNetwork(r.body.requestId)!.profileExpired).toBe(true);
  expect(() => getNetwork(storage, r.body.requestId, { view: "raw", section: "stack" })).toThrow(/expired/);
  await collector.close();
  collector = await startCollector({ storage, config: { ...DEFAULT_CONFIG, storage: { ...DEFAULT_CONFIG.storage, maxTotalSizeMB: 0.001 } }, port: 0 });
  expect((await post(event())).status).toBe(507);
  expect((await (await fetch(`http://127.0.0.1:${collector.port}/health`)).json()).storageFull).toBe(true);
});

it("diagnoses the live collector and write denial; startup write failure releases its port", async () => {
  const health = await diagnose(storage, DEFAULT_CONFIG);
  expect(health).toMatchObject({ writable: true, portAvailable: false, collector: { ok: true } });
  const write = fs.writeFileSync;
  const denied = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: any, ...args: any[]) => {
    if (String(file).includes(".doctor-")) throw new Error("permission denied");
    return (write as any)(file, ...args);
  }) as any);
  try { expect((await diagnose(storage, DEFAULT_CONFIG)).writable).toBe(false); }
  finally { denied.mockRestore(); }
  const lock = vi.spyOn(storage, "writeCollectorLock").mockImplementation(() => { throw new Error("read only"); });
  try { await expect(startCollector({ storage, config: DEFAULT_CONFIG, port: 0 })).rejects.toThrow("read only"); }
  finally { lock.mockRestore(); }
  const next = await startCollector({ storage: new Storage(path.join(dir, "second")), config: DEFAULT_CONFIG, port: 0 });
  await next.close(); await next.close();
  expect(fs.existsSync(path.join(dir, "second", "collector.json"))).toBe(false);
});
