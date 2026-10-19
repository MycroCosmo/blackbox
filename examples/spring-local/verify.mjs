// Build TypeScript and the example jar first. JAVA_HOME or JAVA selects the JVM.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { Storage } from "../../dist/storage.js";
import { DEFAULT_CONFIG } from "../../dist/config.js";
import { startCollector } from "../../dist/collector-server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const run = fs.mkdtempSync(path.join(here, "target", "verification-"));
const storage = new Storage(path.join(run, ".dev-blackbox"));
const collector = await startCollector({ storage, config: DEFAULT_CONFIG, port: 0 });
const free = net.createServer(); free.listen(0, "127.0.0.1"); await once(free, "listening");
const port = free.address().port; await new Promise(r => free.close(r));
const java = process.env.JAVA || (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java") : "java");
const app = spawn(java, ["-jar", path.join(here, "target/spring-local-1.0.0.jar"), `--server.port=${port}`,
  `--dev.blackbox.collector=http://127.0.0.1:${collector.port}/events/network`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
// JVM console output can contain the deliberately seeded secrets; never persist it.
let startup = "";
app.stdout.on("data", b => { startup = (startup + b).slice(-1000); });
app.stderr.on("data", () => {});
const base = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await wait(50); }
  throw new Error("verification timed out");
}
const get = async url => { const r = await fetch(base + url); const body = await r.text(); return { status: r.status, body, trace: r.headers.get("X-Dev-Blackbox-Trace-Id") }; };
const cli = args => {
  const p = spawnSync(process.execPath, [path.join(repo, "dist/cli.js"), ...args, "--format", "json"], { cwd: run, encoding: "utf8", windowsHide: true });
  assert.equal(p.status, 0, p.stderr); return p.stdout.trimEnd();
};
let mcp;
try {
  await until(async () => {
    if (app.exitCode !== null) throw new Error(`Spring failed to start: ${startup}`);
    try { return (await get("/blackbox-status")).status === 200; } catch { return false; }
  });
  for (let i = 0; i < 30; i++) assert.equal((await get("/ok")).status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await get(`/fail?marker=repeat-${i}`)).status, 500);
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) => get(`/async?marker=parallel-${i}`)));
  assert(concurrent.every(r => r.status === 500 && r.trace));
  assert.equal((await get("/fail?marker=alternate&alternate=true")).status, 500);
  assert.equal((await get("/large")).status, 500);
  await until(async () => {
    const s = JSON.parse((await get("/blackbox-status")).body);
    return s.queued === 0 && s.active === 0 && storage.readNetwork().length === 44;
  });
  const records = storage.readNetwork();
  assert.equal(records.filter(e => e.status === 200).length, 30);
  for (let i = 0; i < concurrent.length; i++) {
    const record = records.find(e => e.traceId === concurrent[i].trace);
    assert(record.profile.logs.some(s => s.includes(`async marker=parallel-${i}`)));
    assert(!record.profile.logs.some(s => /parallel-\d/.test(s) && !s.includes(`parallel-${i}`)));
  }
  const allRaw = JSON.stringify(records, null, 2);
  assert(!/demo-password|demo-cookie|demo-token/.test(allRaw));
  const large = records.find(e => e.url === "/large");
  assert(large.profile.truncated && large.profile.droppedLogs > 0);
  const listingText = cli(["incident", "list"]);
  const listing = JSON.parse(listingText);
  assert.equal(listing.incidents.length, 4);
  const chosen = listing.incidents.find(i => i.path === "/fail" && i.occurrenceCount === 4);
  assert(chosen);
  const detailText = cli(["incident", "show", chosen.incidentId]);
  const detail = JSON.parse(detailText);
  assert.equal(detail.rootCause.message, "inventory unavailable");
  assert(detail.rootCause.frames.some(f => f.includes("DemoApplication.fail")));
  const rawText = cli(["network", "show", detail.event.requestId, "--view", "raw", "--section", "logs"]);
  assert(JSON.parse(rawText).text.includes("marker=repeat-3"));

  mcp = spawn(process.execPath, [path.join(repo, "dist/cli.js"), "mcp"], { cwd: run, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map(); let buffer = "", id = 0;
  mcp.stdout.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n"); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const data = JSON.parse(line); pending.get(data.id)?.(data); pending.delete(data.id);
    }
  });
  const rpc = async (method, params) => {
    const key = ++id;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(key); reject(new Error("MCP timeout")); }, 5000);
      pending.set(key, data => { clearTimeout(timer); resolve(data); });
    });
    const request = JSON.stringify({ jsonrpc: "2.0", id: key, method, params });
    mcp.stdin.write(request + "\n");
    return { request, response: await result };
  };
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  const tools = await rpc("tools/list");
  assert(tools.response.result.tools.find(t => t.name === "get_network_request").inputSchema.properties.view);
  const calls = [];
  for (const [name, args] of [["list_incidents", {}], ["get_incident", { incidentId: chosen.incidentId }],
    ["get_network_request", { requestId: detail.event.requestId, view: "raw", section: "logs" }]]) {
    const result = await rpc("tools/call", { name, arguments: args });
    assert(!result.response.result.isError);
    calls.push(result);
  }
  assert.equal(JSON.parse(calls[1].response.result.content[0].text).rootCause.message, "inventory unavailable");
  const size = text => ({ bytes: Buffer.byteLength(text), characters: [...text].length });
  const staged = calls.slice(0, 2).map(c => c.response.result.content[0].text).join("\n");
  const wire = calls.slice(0, 2).map(c => c.request + "\n" + JSON.stringify(c.response) + "\n").join("");
  const evidence = { measuredAt: new Date().toISOString(), java: spawnSync(java, ["-version"], { encoding: "utf8", windowsHide: true }).stderr.split("\n")[0],
    node: process.version, springBoot: "3.5.3", fixture: "30 /ok, 4 /fail repeats, 8 concurrent /async, 1 alternate cause, 1 /large",
    records: records.length, incidents: listing.incidents.length, sha256: createHash("sha256").update(allRaw).digest("hex"),
    A_allCapturedRecords: size(allRaw), B_listAndSelectedDetail: size(staged),
    B_twoRpcRequestsAndResponses: size(wire), optionalRawCall: size(JSON.stringify(calls[2])),
    repeatedDetailCall: size(calls[1].response.result.content[0].text),
    tokenizer: null, tokenCount: null, measurement: "UTF-8 bytes and Unicode code points, not tokens or whole-conversation cost",
    querySequence: calls.map(c => JSON.parse(c.request).params), diagnosticEvidence: { requestId: detail.event.requestId,
      rootCause: detail.rootCause, repeatedOccurrences: chosen.occurrenceCount, relatedLog: JSON.parse(rawText).text },
    adapter: JSON.parse((await get("/blackbox-status")).body), checks: ["normal", "exception/cause", "repeat grouping", "different cause separation", "concurrent async isolation", "long stack/log limits", "redaction", "CLI chain", "MCP stdio chain"] };
  // Compare before closing: normal profiles are intentionally removed on session end.
  fs.writeFileSync(path.join(run, "A-all-records.json"), allRaw);
  fs.writeFileSync(path.join(run, "B-staged.txt"), staged);
  fs.writeFileSync(path.join(run, "mcp-transcript.json"), JSON.stringify(calls, null, 2));
  fs.writeFileSync(path.join(run, "mcp-tools.json"), JSON.stringify(tools.response.result.tools));
  for (const route of ["/review-secret", "/review-logged", "/review-late"]) {
    assert.equal((await get(route)).status, 500);
  }
  await until(async () => storage.readNetwork().length === 47);
  for (const record of storage.readNetwork().slice(44)) {
    const incident = await rpc("tools/call", { name: "get_incident", arguments: { incidentId: record.incidentId } });
    assert(!incident.response.result.isError);
    const value = JSON.parse(incident.response.result.content[0].text);
    const raw = await rpc("tools/call", { name: "get_network_request", arguments: { requestId: record.requestId, view: "raw", section: "logs", maxBytes: 262144 } });
    assert(!raw.response.result.isError);
    if (record.url === "/review-secret") {
      for (const output of [JSON.stringify(record), JSON.stringify(incident), JSON.stringify(raw), cli(["incident", "show", record.incidentId])])
        assert(!/review-fake-password|cmV2aWV3OmZha2U=|review-fake-key/.test(output));
    } else if (record.url === "/review-logged") {
      assert.equal(value.rootCause.message, "hidden SQLState 08001 connection refused");
      assert(value.rootCause.frames.some(f => f.includes("ReviewEndpoints.logged")));
    } else {
      assert(record.profile.logs.some(s => s.includes("early diagnostic: connection retry failed")));
      assert(value.logPreview.some(s => s.includes("database pool exhausted")));
      assert(raw.response.result.content[0].text.includes("database pool exhausted"));
      assert(record.profile.droppedLogs > 0);
    }
  }
  evidence.checks.push("prefixed colon secrets masked in storage/CLI/MCP", "logged Throwable cause and frames", "early ERROR and late diagnostic survive overflow");
  fs.writeFileSync(path.join(run, "regression-records.json"), JSON.stringify(storage.readNetwork().slice(44), null, 2));
  await collector.close();
  assert.equal((await get("/ok")).status, 200);
  assert.equal((await get("/fail?marker=offline")).status, 500);
  await until(async () => JSON.parse((await get("/blackbox-status")).body).sendFailures >= 2);
  evidence.checks.push("collector offline does not change application responses");
  evidence.offlineAdapter = JSON.parse((await get("/blackbox-status")).body);
  // A stalled receiver proves the bounded sender rejects overflow without blocking HTTP requests.
  const sockets = new Set();
  const stalled = net.createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(r => stalled.listen(collector.port, "127.0.0.1", r));
  try {
    const burst = await Promise.all(Array.from({ length: 100 }, () => get("/ok")));
    assert(burst.every(r => r.status === 200));
    evidence.overloadAdapter = JSON.parse((await get("/blackbox-status")).body);
    assert(evidence.overloadAdapter.dropped > 0);
    assert(evidence.overloadAdapter.queued <= 64);
    evidence.checks.push("bounded queue overflow visible; 100 burst requests still succeed");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(r => stalled.close(r));
  }
  fs.writeFileSync(path.join(run, "measurement.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ run, ...evidence }, null, 2));
} finally {
  if (mcp) { mcp.stdin.end(); await once(mcp, "exit"); }
  if (app.exitCode === null) { app.kill(); await once(app, "exit"); }
  await collector.close();
}
