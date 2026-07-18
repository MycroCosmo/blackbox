import type { BlackboxConfig } from "./config.js";
import { startCollector, type Collector } from "./collector-server.js";
import { prune } from "./retention.js";
import { runCommand } from "./runner.js";
import type { Storage } from "./storage.js";
import type { RunOutcome } from "./types.js";

export interface DevSessionOptions {
  cwd: string;
  storage: Storage;
  config: BlackboxConfig;
  port?: number;
}

export function buildInstrumentedEnv(
  base: NodeJS.ProcessEnv,
  collectorUrl: string,
): NodeJS.ProcessEnv {
  const registerUrl = new URL("./register.js", import.meta.url);
  const preload = fs.existsSync(fileURLToPath(registerUrl)) ? `--import=${registerUrl.href}` : "";
  const current = base.NODE_OPTIONS?.trim() ?? "";
  return {
    ...base,
    DEV_BLACKBOX_COLLECTOR_URL: collectorUrl,
    NODE_OPTIONS: current.includes(registerUrl.href)
      ? current
      : [current, preload].filter(Boolean).join(" "),
  };
}

/** Runs a development command in the foreground while a local collector is
 * active. Existing collectors are reused; collectors started here are closed
 * before the command returns. */
export async function runDevSession(
  argv: string[],
  opts: DevSessionOptions,
): Promise<RunOutcome> {
  const { storage, config, cwd } = opts;
  let collector: Collector | undefined;
  let ownsCollector = false;
  let port: number;

  try {
    prune(storage, config);
  } catch {
    /* maintenance is best effort */
  }

  const existing = storage.readCollectorLock();
  if (existing) {
    port = existing.port;
  } else {
    collector = await startCollector({ storage, config, port: opts.port });
    ownsCollector = true;
    port = collector.port;
  }
  const collectorUrl = `http://127.0.0.1:${port}`;
  process.stdout.write(
    `Dev Blackbox active (collector ${collectorUrl}, ${ownsCollector ? "started" : "reused"}).\n`,
  );

  try {
    return await runCommand(argv, {
      cwd,
      storage,
      config,
      env: buildInstrumentedEnv(process.env, collectorUrl),
    });
  } finally {
    if (ownsCollector && collector) await collector.close();
    try {
      prune(storage, config);
    } catch {
      /* maintenance is best effort */
    }
  }
}
import fs from "node:fs";
import { fileURLToPath } from "node:url";
