import fs from "node:fs";
import path from "node:path";
import type { BlackboxConfig } from "./config.js";
import { isFailure } from "./network.js";
import type { Storage } from "./storage.js";
import { dirSize } from "./storage.js";

/** Storage-size reporting and pruning (spec 7).
 *  Deletion order: old successful command metadata → resolved incidents past
 *  retention → orphaned/old log blobs. Never deletes pinned or unresolved
 *  incidents, or anything recent (spec 7.1). */

export interface StorageStatus {
  schemaVersion: number;
  root: string;
  totalBytes: number;
  maxTotalBytes: number;
  incidents: { total: number; open: number; resolveCandidates: number; resolved: number; pinned: number };
  commandRecords: number;
  blobBytes: number;
  reportBytes: number;
}

export function storageStatus(storage: Storage, config: BlackboxConfig): StorageStatus {
  const incidents = storage.readIncidents();
  return {
    schemaVersion: 1,
    root: storage.root,
    totalBytes: storage.totalSizeBytes(),
    maxTotalBytes: config.storage.maxTotalSizeMB * 1024 * 1024,
    incidents: {
      total: incidents.length,
      open: incidents.filter((i) => i.status === "open").length,
      resolveCandidates: incidents.filter((i) => i.status === "resolve_candidate").length,
      resolved: incidents.filter((i) => i.status === "resolved").length,
      pinned: incidents.filter((i) => i.pinned).length,
    },
    commandRecords: storage.readCommands().length,
    blobBytes: dirSize(path.join(storage.root, "blobs")),
    reportBytes: dirSize(path.join(storage.root, "reports")),
  };
}

export interface PruneResult {
  removedSessionFiles: number;
  removedIncidents: number;
  removedBlobs: number;
  removedNetworkEvents: number;
  strippedNetworkBodies: number;
}

export function prune(
  storage: Storage,
  config: BlackboxConfig,
  opts: { olderThanDays?: number; now?: Date } = {},
): PruneResult {
  const now = opts.now ?? new Date();
  const result: PruneResult = {
    removedSessionFiles: 0,
    removedIncidents: 0,
    removedBlobs: 0,
    removedNetworkEvents: 0,
    strippedNetworkBodies: 0,
  };

  // 1. Old successful-command session files.
  const cmdCutoff = cutoff(now, opts.olderThanDays ?? config.retention.successfulCommandDays);
  if (fs.existsSync(storage.sessionsDir)) {
    for (const f of fs.readdirSync(storage.sessionsDir)) {
      const file = path.join(storage.sessionsDir, f);
      try {
        if (fs.statSync(file).mtimeMs < cmdCutoff) {
          fs.rmSync(file);
          result.removedSessionFiles++;
        }
      } catch {
        /* ignore races */
      }
    }
  }

  // 2-3. Incident compaction and blob cleanup share the incident lock. This
  // prevents a concurrent failure from appending a record (or its new blob)
  // between the reference snapshot and deletion.
  const incCutoff = cutoff(now, opts.olderThanDays ?? config.retention.resolvedIncidentDays);
  storage.withIncidentLock(() => {
    const incidents = storage.readIncidents();
    const kept = incidents.filter((i) => {
      const expired =
        i.status === "resolved" && !i.pinned && Date.parse(i.lastSeenAt) < incCutoff;
      if (expired) result.removedIncidents++;
      return !expired;
    });
    if (result.removedIncidents > 0) storage.compactIncidents(kept);

    const referenced = new Set(kept.filter((i) => i.status !== "resolved" || i.pinned).map((i) => i.logBlob));
    const allReferenced = new Set(kept.map((i) => i.logBlob));
    if (fs.existsSync(storage.blobsDir)) {
      for (const f of fs.readdirSync(storage.blobsDir)) {
        const rel = path.join("blobs", "logs", f);
        const file = path.join(storage.blobsDir, f);
        try {
          const orphaned = !allReferenced.has(rel);
          const oldResolved = !referenced.has(rel) && fs.statSync(file).mtimeMs < incCutoff;
          if (orphaned || oldResolved) {
            fs.rmSync(file);
            result.removedBlobs++;
          }
        } catch {
          /* ignore races */
        }
      }
    }
  });

  // 4. Network events (spec 7.2):
  //    - successful request METADATA: dropped after successfulRequestDays
  //    - successful request BODIES: kept until the collector session ends,
  //      then stripped (deletion priority #1)
  //    - failed request BODIES: stripped after failedRequestBodyDays
  //      (metadata kept — failures are preserved longest)
  const events = storage.readNetwork();
  if (events.length > 0) {
    const activeSession = storage.readCollectorLock()?.sessionId;
    const successCutoff = cutoff(now, opts.olderThanDays ?? config.retention.successfulRequestDays);
    const failedBodyCutoff = cutoff(now, opts.olderThanDays ?? config.retention.failedRequestBodyDays);
    let changed = false;
    const keptEvents = events.filter((e) => {
      const failure = isFailure(e.classification);
      if (!failure && Date.parse(e.receivedAt) < successCutoff) {
        result.removedNetworkEvents++;
        changed = true;
        return false;
      }
      return true;
    });
    for (let i = 0; i < keptEvents.length; i++) {
      const e = keptEvents[i]!;
      const failure = isFailure(e.classification);
      const hasBody = e.requestBody !== undefined || e.responseBody !== undefined;
      const sessionEnded = e.sessionId !== activeSession;
      const strip = hasBody &&
        ((!failure && sessionEnded) || (failure && Date.parse(e.receivedAt) < failedBodyCutoff));
      if (strip) {
        keptEvents[i] = { ...e, requestBody: undefined, responseBody: undefined };
        result.strippedNetworkBodies++;
        changed = true;
      }
    }
    if (changed) storage.compactNetwork(keptEvents);
  }

  return result;
}

function cutoff(now: Date, days: number): number {
  return now.getTime() - days * 24 * 60 * 60 * 1000;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
