import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCollector, type Collector } from "../src/collector-server.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { setStatus } from "../src/incident.js";
import { renderNetworkReport } from "../src/network-report.js";
import { prune } from "../src/retention.js";
import { Storage } from "../src/storage.js";

let dir: string;
let storage: Storage;
let collector: Collector;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbb-col-"));
  storage = new Storage(path.join(dir, ".dev-blackbox"));
  collector = await startCollector({ storage, config: DEFAULT_CONFIG, port: 0 });
});

afterEach(async () => {
  await collector.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const post = (event: unknown) =>
  fetch(`http://127.0.0.1:${collector.port}/events/network`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });

const event = (over: object = {}) => ({
  traceId: "TRACE-001",
  source: { application: "frontend", page: "/todos" },
  request: { method: "POST", url: "/api/todos", body: { title: "x" } },
  response: { status: 500, body: { message: "Internal Server Error" } },
  durationMs: 84,
  ...over,
});

describe("collector server", () => {
  it("binds to 127.0.0.1 and answers /health", async () => {
    const res = await fetch(`http://127.0.0.1:${collector.port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe(collector.sessionId);
  });

  it("stores a network event and assigns sequential REQ ids", async () => {
    const first = await (await post(event())).json();
    const second = await (await post(event())).json();
    expect(first.requestId).toMatch(/^REQ-\d{8}-001$/);
    expect(second.requestId).toMatch(/-002$/);
    const stored = storage.readNetwork();
    expect(stored).toHaveLength(2);
    expect(stored[0]!.classification).toBe("http_error");
    expect(stored[0]!.sessionId).toBe(collector.sessionId);
  });

  it("automatically regenerates incident and network Markdown views", async () => {
    const response = await (await post(event())).json() as { requestId: string; incidentId: string };
    expect(fs.existsSync(storage.networkSummaryFile)).toBe(true);
    expect(fs.readFileSync(storage.networkSummaryFile, "utf8")).toContain("Failed: 1");
    const requestReport = path.join(storage.networkReportsDir, `${response.requestId}.md`);
    expect(fs.readFileSync(requestReport, "utf8")).toContain(response.incidentId);
    const incidentReport = path.join(storage.reportsDir, `${response.incidentId}.md`);
    expect(fs.readFileSync(incidentReport, "utf8")).toContain(response.requestId);
  });

  it("rejects invalid payloads without crashing", async () => {
    const bad = await fetch(`http://127.0.0.1:${collector.port}/events/network`, {
      method: "POST",
      body: "not json{{",
    });
    expect(bad.status).toBe(400);
    const missing = await (await post({ request: { method: "GET" } })).status;
    expect(missing).toBe(400);
    expect((await fetch(`http://127.0.0.1:${collector.port}/nope`)).status).toBe(404);
  });

  it("masks secrets before they reach disk (spec 8)", async () => {
    await post(
      event({
        request: {
          method: "POST",
          url: "/api/login",
          headers: { Authorization: "Bearer tok" },
          body: { email: "a@b.c", password: "hunter2" },
        },
      }),
    );
    const raw = fs.readFileSync(storage.networkFile, "utf8");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("Bearer tok");
    expect(raw).toContain("[REDACTED]");
  });

  it("masks normalized secret-key variants before they reach disk", async () => {
    await post(
      event({
        request: {
          method: "POST",
          url: "/api/login?auth-token=query-secret&ok=1",
          headers: { "X-Api-Key": "header-secret" },
          body: {
            private_key: "private-secret",
            nested: { "db-password": "db-secret" },
          },
        },
      }),
    );
    const raw = fs.readFileSync(storage.networkFile, "utf8");
    for (const secret of ["query-secret", "header-secret", "private-secret", "db-secret"]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain("ok=1");
    expect(raw).toContain("[REDACTED]");
  });

  it("masks secrets in URL, source metadata and error messages", async () => {
    await post({
      traceId: "TRACE-SECRET",
      source: { application: "frontend", accessToken: "source-secret" },
      request: {
        method: "GET",
        url: "/api/user?accessToken=query-secret&ok=1",
      },
      error: { type: "network_error", message: "Authorization: Bearer error-secret-123" },
    });
    const raw = fs.readFileSync(storage.networkFile, "utf8");
    expect(raw).not.toContain("source-secret");
    expect(raw).not.toContain("query-secret");
    expect(raw).not.toContain("error-secret-123");
    expect(raw).toContain("ok=1");
    expect(raw).toContain("REDACTED");
  });

  it("survives a truncated private key without poisoning later events", async () => {
    // One event carrying a truncated key marker must not flip shared redactor
    // state and blank out every event stored after it.
    await post(event({ request: { method: "POST", url: "/api/upload", body: { note: "-----BEGIN RSA PRIVATE KEY-----" } } }));
    await post(event({ request: { method: "POST", url: "/api/todos", body: { title: "still here" } } }));
    const [first, second] = storage.readNetwork();
    expect(JSON.stringify(first!.requestBody)).toContain("[REDACTED]");
    expect(second!.url).toBe("/api/todos");
    expect(JSON.stringify(second!.requestBody)).toContain("still here");
  });

  it("links events by trace id", async () => {
    await post(event({ source: { application: "frontend" } }));
    await post(event({ source: { application: "backend" }, request: { method: "POST", url: "/api/todos" } }));
    const events = storage.readNetwork().filter((e) => e.traceId === "TRACE-001");
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.source?.application))).toEqual(
      new Set(["frontend", "backend"]),
    );
  });

  it("writes and clears the collector lock (single writer)", async () => {
    expect(storage.readCollectorLock()?.sessionId).toBe(collector.sessionId);
    await collector.close();
    expect(storage.readCollectorLock()).toBeUndefined();
    collector = await startCollector({ storage, config: DEFAULT_CONFIG, port: 0 });
  });
});

describe("NETWORK.md view (spec 5.5)", () => {
  it("renders a regenerated summary", async () => {
    await post(event());
    await post(event({ response: { status: 200, body: { ok: true } }, request: { method: "GET", url: "/api/todos" } }));
    const md = renderNetworkReport(storage.readNetwork());
    expect(md).toContain("# Network Summary");
    expect(md).toContain("Total requests: 2");
    expect(md).toContain("Failed: 1");
    expect(md).toContain("POST /api/todos");
    expect(md).toContain("TRACE-001");
  });
});

describe("network retention (spec 7.2)", () => {
  it("strips success bodies after session end, keeps failure bodies", async () => {
    await post(event()); // failure — body kept
    await post(event({ response: { status: 200, body: { ok: true } } })); // success
    await collector.close(); // session ends

    // Collector shutdown now runs retention automatically, so the explicit
    // prune is idempotent and has nothing left to strip.
    const result = prune(storage, DEFAULT_CONFIG);
    expect(result.strippedNetworkBodies).toBe(0);
    const [fail, ok] = storage.readNetwork();
    expect(fail!.responseBody).toBeDefined();
    expect(ok!.responseBody).toBeUndefined();

    collector = await startCollector({ storage, config: DEFAULT_CONFIG, port: 0 });
  });

  it("drops old success metadata but keeps failures", async () => {
    await post(event());
    await post(event({ response: { status: 200, body: { ok: true } } }));
    await collector.close();
    // Backdate everything by rewriting receivedAt.
    storage.compactNetwork(
      storage.readNetwork().map((e) => ({ ...e, receivedAt: "2026-01-01T00:00:00.000Z" })),
    );
    const result = prune(storage, DEFAULT_CONFIG, { now: new Date("2026-07-14") });
    expect(result.removedNetworkEvents).toBe(1);
    expect(storage.readNetwork().map((e) => e.classification)).toEqual(["http_error"]);
    collector = await startCollector({ storage, config: DEFAULT_CONFIG, port: 0 });
  });

  it("removes reports and linked network data after an incident is resolved and expires", async () => {
    const created = await (await post(event())).json() as { requestId: string; incidentId: string };
    await collector.close();
    setStatus(storage, created.incidentId, "resolved");
    storage.compactIncidents(
      storage.readIncidents().map((incident) => ({
        ...incident,
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      })),
    );

    const result = prune(storage, DEFAULT_CONFIG, { now: new Date("2026-07-14") });
    expect(result.removedIncidents).toBe(1);
    expect(result.removedNetworkEvents).toBe(1);
    expect(result.removedReports).toBe(2);
    expect(storage.readNetwork()).toHaveLength(0);
    expect(fs.existsSync(path.join(storage.reportsDir, `${created.incidentId}.md`))).toBe(false);
    expect(fs.existsSync(path.join(storage.networkReportsDir, `${created.requestId}.md`))).toBe(false);
    expect(fs.readFileSync(storage.networkSummaryFile, "utf8")).toContain("Total requests: 0");
    collector = await startCollector({ storage, config: DEFAULT_CONFIG, port: 0 });
  });
});
