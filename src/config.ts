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
    maxSessionFiles: number;
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
  storage: { maxTotalSizeMB: 500, maxSessionFiles: 100 },
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

function section(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Every reader below falls back to the default when the YAML value has the
 *  wrong type or an unsafe range. The config file is hand-edited, and an
 *  unchecked value used to reach code that assumes its type —
 *  `sampling.rules: {}` made `.find` throw
 *  on every collected event, which the collector reported as a 400 and dropped
 *  silently. Bad config now degrades to the default instead. */
function nonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : fallback;
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function samplingRules(value: unknown, fallback: { route: string; rate: number }[]) {
  if (!Array.isArray(value)) return fallback;
  const rules: { route: string; rate: number }[] = [];
  for (const item of value) {
    const rule = section(item);
    if (typeof rule.route !== "string" || rule.route.length === 0 || !isRate(rule.rate)) {
      return fallback;
    }
    rules.push({ route: rule.route, rate: rule.rate });
  }
  return rules;
}

/** Deep-merges the user config over the defaults so missing keys never break. */
function mergeConfig(base: BlackboxConfig, user: unknown): BlackboxConfig {
  const u = section(user);
  const ringBuffer = section(u.ringBuffer);
  const detection = section(u.detection);
  const storage = section(u.storage);
  const retention = section(u.retention);
  const security = section(u.security);
  const collector = section(u.collector);
  const network = section(u.network);
  const sampling = section(u.sampling);
  return {
    version: int(u.version, base.version, 1, Number.MAX_SAFE_INTEGER),
    reportLanguage: u.reportLanguage === "ko" ? "ko" : base.reportLanguage,
    ringBuffer: {
      maxLines: int(ringBuffer.maxLines, base.ringBuffer.maxLines, 1, Number.MAX_SAFE_INTEGER),
      maxAgeSeconds: nonNegative(ringBuffer.maxAgeSeconds, base.ringBuffer.maxAgeSeconds),
      maxMemoryMB: positive(ringBuffer.maxMemoryMB, base.ringBuffer.maxMemoryMB),
    },
    detection: {
      softSignalIncident: bool(detection.softSignalIncident, base.detection.softSignalIncident),
    },
    storage: {
      maxTotalSizeMB: positive(storage.maxTotalSizeMB, base.storage.maxTotalSizeMB),
      maxSessionFiles: int(
        storage.maxSessionFiles,
        base.storage.maxSessionFiles,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    },
    retention: {
      successfulCommandDays: nonNegative(retention.successfulCommandDays, base.retention.successfulCommandDays),
      resolvedIncidentDays: nonNegative(retention.resolvedIncidentDays, base.retention.resolvedIncidentDays),
      successfulRequestDays: nonNegative(retention.successfulRequestDays, base.retention.successfulRequestDays),
      failedRequestBodyDays: nonNegative(retention.failedRequestBodyDays, base.retention.failedRequestBodyDays),
      autoPruneIntervalHours: positive(retention.autoPruneIntervalHours, base.retention.autoPruneIntervalHours),
      autoPruneMinIntervalMinutes: nonNegative(
        retention.autoPruneMinIntervalMinutes,
        base.retention.autoPruneMinIntervalMinutes,
      ),
    },
    security: { redactBodyKeys: stringList(security.redactBodyKeys, base.security.redactBodyKeys) },
    collector: { port: int(collector.port, base.collector.port, 1, 65_535) },
    network: {
      maxRequestBodyBytes: int(
        network.maxRequestBodyBytes,
        base.network.maxRequestBodyBytes,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      maxResponseBodyBytes: int(
        network.maxResponseBodyBytes,
        base.network.maxResponseBodyBytes,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      excludeBinaryBody: bool(network.excludeBinaryBody, base.network.excludeBinaryBody),
      slowResponseMs: nonNegative(network.slowResponseMs, base.network.slowResponseMs),
    },
    sampling: {
      defaultRate: isRate(sampling.defaultRate) ? sampling.defaultRate : base.sampling.defaultRate,
      rules: samplingRules(sampling.rules, base.sampling.rules),
    },
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
    "  maxSessionFiles: 100",
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
