import http from "node:http";
import type { BlackboxConfig } from "./config.js";
import { loadContracts } from "./contracts.js";
import { recordNetworkFailure } from "./incident.js";
import { buildNetworkRecord, isFailure, shouldStore } from "./network.js";
import { renderNetworkFailureReport, renderNetworkReport } from "./network-report.js";
import { writeIncidentReport } from "./report.js";
import { autoPrune, prune } from "./retention.js";
import { Redactor } from "./security.js";
import type { Storage } from "./storage.js";

/** Local network-event collector (spec 5.2, 6.1, 8).
 *  - Binds to 127.0.0.1 ONLY; never reachable from outside the machine.
 *  - While running it is the single writer of network.jsonl; the port bind
 *    doubles as the writer lock.
 *  - Every payload is redacted and size-limited BEFORE it touches disk. */

const MAX_EVENT_BYTES = 1024 * 1024; // hard cap on a single POST body
const DEFAULT_NETWORK_REPORT_INTERVAL_MS = 5_000;

export interface Collector {
  port: number;
  sessionId: string;
  flushReports(): void;
  close(): Promise<void>;
}

export function parseCollectorPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid collector port '${value}' (expected an integer from 1 to 65535)`);
  }
  return port;
}

export function startCollector(opts: {
  storage: Storage;
  config: BlackboxConfig;
  port?: number;
  /** Test/embedding override. Public CLI uses the 5 second default. */
  networkReportIntervalMs?: number;
}): Promise<Collector> {
  const { storage, config } = opts;
  const redactor = new Redactor(config.security.redactBodyKeys);
  const sessionId = `SESSION-${storage.newSessionId()}`;
  let seq = storage.nextRequestSeq();
  const contracts = loadContracts(storage);
  try {
    autoPrune(storage, config);
  } catch {
    /* retention must never prevent collection */
  }
  const pruneEveryMs = Math.max(1, config.retention.autoPruneIntervalHours) * 60 * 60 * 1000;
  const pruneTimer = setInterval(() => {
    try {
      autoPrune(storage, config);
    } catch {
      /* best-effort background maintenance */
    }
  }, pruneEveryMs);
  pruneTimer.unref();
  let networkReportDirty = false;
  let networkReportTimer: NodeJS.Timeout | undefined;

  const flushNetworkSummary = () => {
    if (!networkReportDirty) return;
    try {
      storage.writeNetworkSummary(
        renderNetworkReport(storage.readNetwork(), { lang: config.reportLanguage }),
      );
      networkReportDirty = false;
    } catch {
      /* leave dirty so a later timer or shutdown can retry */
    }
  };
  const scheduleNetworkSummary = () => {
    networkReportDirty = true;
    if (networkReportTimer) return;
    networkReportTimer = setTimeout(() => {
      networkReportTimer = undefined;
      flushNetworkSummary();
    }, opts.networkReportIntervalMs ?? DEFAULT_NETWORK_REPORT_INTERVAL_MS);
    networkReportTimer.unref();
  };

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const json = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json);
    };

    if (req.method === "GET" && req.url === "/health") {
      send(200, { ok: true, sessionId });
      return;
    }
    if (req.method !== "POST" || req.url !== "/events/network") {
      send(404, { ok: false, error: "not found" });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_EVENT_BYTES) {
        rejected = true;
        send(413, { ok: false, error: "event too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        send(400, { ok: false, error: "invalid JSON" });
        return;
      }
      try {
        const requestId = `${seq.prefix}${String(seq.next).padStart(3, "0")}`;
        const record = buildNetworkRecord(parsed, { requestId, sessionId }, config, redactor, contracts);
        if (!shouldStore(record.url, record.classification, config)) {
          send(202, { ok: true, stored: false, reason: "sampled_out" });
          return;
        }
        // Phase 3: failing traffic is linked to a (merged) incident.
        if (isFailure(record.classification)) {
          try {
            record.incidentId = recordNetworkFailure(storage, record).incidentId;
          } catch {
            /* incident linking must not lose the network record */
          }
        }
        storage.appendNetwork(record);
        try {
          if (isFailure(record.classification)) {
            storage.writeNetworkEventReport(
              record.requestId,
              renderNetworkFailureReport(record),
            );
            if (record.incidentId) {
              writeIncidentReport(storage, record.incidentId, config.reportLanguage);
            }
          }
        } catch {
          /* reports are regenerated views; persistence above is authoritative */
        }
        scheduleNetworkSummary();
        seq = { ...seq, next: seq.next + 1 };
        send(201, {
          ok: true,
          stored: true,
          requestId: record.requestId,
          classification: record.classification,
          traceId: record.traceId,
          incidentId: record.incidentId,
        });
      } catch (e) {
        send(400, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    req.on("error", () => {
      /* client aborted — nothing to persist */
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      clearInterval(pruneTimer);
      if (networkReportTimer) clearTimeout(networkReportTimer);
      reject(error);
    });
    // Explicit loopback bind (spec 8: 수집 서버는 127.0.0.1에만 Bind).
    server.listen(opts.port ?? config.collector.port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.collector.port;
      storage.writeCollectorLock({
        pid: process.pid,
        port,
        sessionId,
        startedAt: new Date().toISOString(),
      });
      resolve({
        port,
        sessionId,
        flushReports: flushNetworkSummary,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(pruneTimer);
            if (networkReportTimer) clearTimeout(networkReportTimer);
            networkReportTimer = undefined;
            flushNetworkSummary();
            storage.removeCollectorLock();
            server.close(() => {
              try {
                prune(storage, config);
              } catch {
                /* best-effort shutdown maintenance */
              }
              res();
            });
          }),
      });
    });
  });
}
