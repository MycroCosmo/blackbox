import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface BlackboxConfig {
  version: number;
  reportLanguage: "en" | "ko";
  ringBuffer: {
    maxLines: number;
    maxAgeSeconds: number;
    maxMemoryMB: number;
  };
  detection: {
    softSignalIncident: boolean;
  };
  storage: {
    maxTotalSizeMB: number;
  };
  retention: {
    successfulCommandDays: number;
    resolvedIncidentDays: number;
    successfulRequestDays: number;
    failedRequestBodyDays: number;
    autoPruneIntervalHours: number;
    autoPruneMinIntervalMinutes: number;
  };
  security: {
    redactBodyKeys: string[];
  };
  collector: {
    port: number;
  };
  network: {
    maxRequestBodyBytes: number;
    maxResponseBodyBytes: number;
    excludeBinaryBody: boolean;
    slowResponseMs: number;
  };
  sampling: {
    defaultRate: number;
    rules: { route: string; rate: number }[];
  };
}

export const DEFAULT_CONFIG: BlackboxConfig = {
  version: 1,
  reportLanguage: "en",
  ringBuffer: { maxLines: 1000, maxAgeSeconds: 300, maxMemoryMB: 10 },
  detection: { softSignalIncident: false },
  storage: { maxTotalSizeMB: 500 },
  retention: {
    successfulCommandDays: 3,
    resolvedIncidentDays: 90,
    successfulRequestDays: 3,
    failedRequestBodyDays: 30,
    autoPruneIntervalHours: 24,
    autoPruneMinIntervalMinutes: 5,
  },
  security: {
    redactBodyKeys: [
      "password",
      "passwd",
      "accessToken",
      "refreshToken",
      "apiKey",
      "api_key",
      "clientSecret",
      "secret",
      "authorization",
      "cookie",
      "set-cookie",
    ],
  },
  collector: { port: 4319 },
  network: {
    maxRequestBodyBytes: 64 * 1024,
    maxResponseBodyBytes: 128 * 1024,
    excludeBinaryBody: true,
    slowResponseMs: 3000,
  },
  sampling: { defaultRate: 1.0, rules: [] },
};

export const CONFIG_FILE = "config.yml";

/** Deep-merges the user config over the defaults so missing keys never break. */
function mergeConfig(base: BlackboxConfig, user: unknown): BlackboxConfig {
  if (typeof user !== "object" || user === null) return base;
  const u = user as Record<string, unknown>;
  const pick = <T extends object>(def: T, over: unknown): T =>
    typeof over === "object" && over !== null ? { ...def, ...(over as object) } : def;
  return {
    version: typeof u.version === "number" ? u.version : base.version,
    reportLanguage: u.reportLanguage === "ko" ? "ko" : base.reportLanguage,
    ringBuffer: pick(base.ringBuffer, u.ringBuffer),
    detection: pick(base.detection, u.detection),
    storage: pick(base.storage, u.storage),
    retention: pick(base.retention, u.retention),
    security: pick(base.security, u.security),
    collector: pick(base.collector, u.collector),
    network: pick(base.network, u.network),
    sampling: pick(base.sampling, u.sampling),
  };
}

export function loadConfig(blackboxRoot: string): BlackboxConfig {
  const file = path.join(blackboxRoot, CONFIG_FILE);
  try {
    const raw = fs.readFileSync(file, "utf8");
    return mergeConfig(DEFAULT_CONFIG, YAML.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function defaultConfigYaml(): string {
  return [
    "# Dev Blackbox configuration",
    "version: 1",
    "# Report/CLI language: en (default, agent-friendly) or ko",
    "reportLanguage: en",
    "ringBuffer:",
    "  maxLines: 1000",
    "  maxAgeSeconds: 300",
    "  maxMemoryMB: 10",
    "detection:",
    "  # Create incidents from soft signals alone (exit code 0). Off by default.",
    "  softSignalIncident: false",
    "storage:",
    "  maxTotalSizeMB: 500",
    "retention:",
    "  successfulCommandDays: 3",
    "  resolvedIncidentDays: 90",
    "  successfulRequestDays: 3",
    "  failedRequestBodyDays: 30",
    "  autoPruneIntervalHours: 24",
    "  autoPruneMinIntervalMinutes: 5",
    "collector:",
    "  # The collector binds to 127.0.0.1 only (never exposed externally).",
    "  port: 4319",
    "network:",
    "  maxRequestBodyBytes: 65536",
    "  maxResponseBodyBytes: 131072",
    "  excludeBinaryBody: true",
    "  slowResponseMs: 3000",
    "sampling:",
    "  defaultRate: 1.0",
    "  # rules:",
    "  #   - route: /api/health",
    "  #     rate: 0.01",
    "  rules: []",
    "security:",
    "  redactBodyKeys:",
    ...DEFAULT_CONFIG.security.redactBodyKeys.map((k) => `    - ${k}`),
    "",
  ].join("\n");
}
