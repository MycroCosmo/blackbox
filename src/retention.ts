import fs from "node:fs";
import path from "node:path";
import type { BlackboxConfig } from "./config.js";
import { isFailure } from "./network.js";
import { renderNetworkReport } from "./network-report.js";
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
  removedReports: number;
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
    removedReports: 0,
  };
  const removedIncidentIds = new Set<string>();
  const removedRequestIds = new Set<string>();
  const collectorLock = storage.readCollectorLock();
  const canMaintainNetwork = collectorLock == null || collectorLock.pid === process.pid;

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
        i.status === "resolved" &&
        !i.pinned &&
        Date.parse(i.lastSeenAt) < incCutoff &&
        (i.kind !== "NETWORK_FAILURE" || canMaintainNetwork);
      if (expired) {
        result.removedIncidents++;
        removedIncidentIds.add(i.incidentId);
      }
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
  if (events.length > 0 && canMaintainNetwork) {
    const activeSession = storage.readCollectorLock()?.sessionId;
    const successCutoff = cutoff(now, opts.olderThanDays ?? config.retention.successfulRequestDays);
    const failedBodyCutoff = cutoff(now, opts.olderThanDays ?? config.retention.failedRequestBodyDays);
    let changed = false;
    const keptEvents = events.filter((e) => {
      const failure = isFailure(e.classification);
      if (
        (!failure && Date.parse(e.receivedAt) < successCutoff) ||
        (e.incidentId != null && removedIncidentIds.has(e.incidentId))
      ) {
        result.removedNetworkEvents++;
        removedRequestIds.add(e.requestId);
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

  enforceSizeLimit(
    storage,
    config,
    result,
    removedIncidentIds,
    removedRequestIds,
    canMaintainNetwork,
  );
  result.removedReports += cleanupReportViews(storage, canMaintainNetwork);
  if (canMaintainNetwork) {
    try {
      storage.writeNetworkSummary(
        renderNetworkReport(storage.readNetwork(), { lang: config.reportLanguage }),
      );
    } catch {
      /* reports are disposable regenerated views */
    }
  }

  return result;
}

/** Enforces the configured cap without deleting open or pinned incidents.
 * Old command sessions and successful network events go first, followed by
 * resolved unpinned incidents. If protected data alone exceeds the cap, it is
 * deliberately left intact and storage status reports the overage. */
function enforceSizeLimit(
  storage: Storage,
  config: BlackboxConfig,
  result: PruneResult,
  removedIncidentIds: Set<string>,
  removedRequestIds: Set<string>,
  canMaintainNetwork: boolean,
): void {
  const maxBytes = Math.max(0, config.storage.maxTotalSizeMB) * 1024 * 1024;
  if (storage.totalSizeBytes() <= maxBytes) return;

  const sessionFiles = listFilesByAge(storage.sessionsDir);
  for (const file of sessionFiles) {
    if (storage.totalSizeBytes() <= maxBytes) break;
    if (safeRemove(file)) result.removedSessionFiles++;
  }

  if (storage.totalSizeBytes() > maxBytes && canMaintainNetwork) {
    const events = storage.readNetwork();
    const successes = events
      .filter((event) => !isFailure(event.classification))
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const drop = new Set<string>();
    for (const event of successes) {
      if (storage.totalSizeBytes() <= maxBytes) break;
      drop.add(event.requestId);
      removedRequestIds.add(event.requestId);
      result.removedNetworkEvents++;
      // Compact as we go so the cap check observes reclaimed bytes.
      storage.compactNetwork(events.filter((candidate) => !drop.has(candidate.requestId)));
    }
  }

  if (storage.totalSizeBytes() > maxBytes) {
    storage.withIncidentLock(() => {
      const incidents = storage.readIncidents();
      const removable = incidents
        .filter(
          (incident) =>
            incident.status === "resolved" &&
            !incident.pinned &&
            (incident.kind !== "NETWORK_FAILURE" || canMaintainNetwork),
        )
        .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));
      const drop = new Set<string>();
      for (const incident of removable) {
        if (storage.totalSizeBytes() <= maxBytes) break;
        drop.add(incident.incidentId);
        removedIncidentIds.add(incident.incidentId);
        result.removedIncidents++;
        if (incident.logBlob && safeRemove(path.join(storage.root, incident.logBlob))) {
          result.removedBlobs++;
        }
        if (safeRemove(path.join(storage.reportsDir, `${incident.incidentId}.md`))) {
          result.removedReports++;
        }
        if (canMaintainNetwork) {
          const networkEvents = storage.readNetwork();
          const linked = networkEvents.filter(
            (event) => event.incidentId === incident.incidentId,
          );
          if (linked.length > 0) {
            storage.compactNetwork(
              networkEvents.filter((event) => event.incidentId !== incident.incidentId),
            );
            for (const event of linked) {
              if (!removedRequestIds.has(event.requestId)) {
                removedRequestIds.add(event.requestId);
                result.removedNetworkEvents++;
              }
              if (safeRemove(path.join(storage.networkReportsDir, `${event.requestId}.md`))) {
                result.removedReports++;
              }
            }
          }
        }
        storage.compactIncidents(
          incidents.filter((candidate) => !drop.has(candidate.incidentId)),
        );
      }
    });
  }

  if (removedIncidentIds.size > 0 && canMaintainNetwork) {
    const events = storage.readNetwork();
    const kept = events.filter((event) => {
      const remove = event.incidentId != null && removedIncidentIds.has(event.incidentId);
      if (remove && !removedRequestIds.has(event.requestId)) {
        removedRequestIds.add(event.requestId);
        result.removedNetworkEvents++;
      }
      return !remove;
    });
    if (kept.length !== events.length) storage.compactNetwork(kept);
  }
}

function cleanupReportViews(storage: Storage, includeNetwork: boolean): number {
  let removed = 0;
  const incidentNames = new Set(storage.readIncidents().map((incident) => `${incident.incidentId}.md`));
  const networkNames = new Set(storage.readNetwork().map((event) => `${event.requestId}.md`));
  const targets: Array<[string, Set<string>]> = [[storage.reportsDir, incidentNames]];
  if (includeNetwork) targets.push([storage.networkReportsDir, networkNames]);
  for (const [dir, keep] of targets) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md") || keep.has(name)) continue;
      if (safeRemove(path.join(dir, name))) removed++;
    }
  }
  return removed;
}

function listFilesByAge(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try {
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  } catch {
    return [];
  }
}

function safeRemove(file: string): boolean {
  try {
    fs.rmSync(file);
    return true;
  } catch {
    return false;
  }
}

function cutoff(now: Date, days: number): number {
  return now.getTime() - days * 24 * 60 * 60 * 1000;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
