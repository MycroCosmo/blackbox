import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { shouldStore } from "../src/network.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbb-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (yaml: string) => {
  fs.writeFileSync(path.join(dir, "config.yml"), yaml, "utf8");
  return loadConfig(dir);
};

describe("loadConfig", () => {
  it("applies valid overrides and keeps unspecified defaults", () => {
    const config = write(
      [
        "reportLanguage: ko",
        "ringBuffer:",
        "  maxLines: 50",
        "storage:",
        "  maxSessionFiles: 25",
        "collector:",
        "  port: 5000",
        "sampling:",
        "  defaultRate: 0.5",
        "  rules:",
        "    - route: /api/health",
        "      rate: 0.01",
      ].join("\n"),
    );
    expect(config.reportLanguage).toBe("ko");
    expect(config.ringBuffer.maxLines).toBe(50);
    expect(config.ringBuffer.maxAgeSeconds).toBe(DEFAULT_CONFIG.ringBuffer.maxAgeSeconds);
    expect(config.storage.maxSessionFiles).toBe(25);
    expect(config.collector.port).toBe(5000);
    expect(config.sampling.rules).toEqual([{ route: "/api/health", rate: 0.01 }]);
  });

  it("falls back to defaults for wrongly typed values instead of passing them through", () => {
    const config = write(
      [
        "ringBuffer:",
        '  maxLines: "1000"', // string disabled line-count eviction
        "detection:",
        "  softSignalIncident: yes-please", // not a boolean
        "collector:",
        "  port: 99999", // out of range
        "security:",
        "  redactBodyKeys: password", // not a list
      ].join("\n"),
    );
    expect(config.ringBuffer.maxLines).toBe(DEFAULT_CONFIG.ringBuffer.maxLines);
    expect(config.detection.softSignalIncident).toBe(false);
    expect(config.collector.port).toBe(DEFAULT_CONFIG.collector.port);
    expect(config.security.redactBodyKeys).toEqual(DEFAULT_CONFIG.security.redactBodyKeys);
  });

  it("falls back for unsafe numeric ranges before they can discard stored evidence", () => {
    const config = write(
      [
        "version: 0",
        "ringBuffer:",
        "  maxLines: -1",
        "  maxMemoryMB: 0",
        "storage:",
        "  maxTotalSizeMB: -1",
        "  maxSessionFiles: 0",
        "retention:",
        "  resolvedIncidentDays: -1",
        "  autoPruneIntervalHours: 0",
        "network:",
        "  maxRequestBodyBytes: -1",
        "sampling:",
        "  defaultRate: 2",
        "  rules:",
        "    - route: /api",
        "      rate: -0.1",
      ].join("\n"),
    );

    expect(config.version).toBe(DEFAULT_CONFIG.version);
    expect(config.ringBuffer.maxLines).toBe(DEFAULT_CONFIG.ringBuffer.maxLines);
    expect(config.ringBuffer.maxMemoryMB).toBe(DEFAULT_CONFIG.ringBuffer.maxMemoryMB);
    expect(config.storage.maxTotalSizeMB).toBe(DEFAULT_CONFIG.storage.maxTotalSizeMB);
    expect(config.storage.maxSessionFiles).toBe(DEFAULT_CONFIG.storage.maxSessionFiles);
    expect(config.retention.resolvedIncidentDays).toBe(DEFAULT_CONFIG.retention.resolvedIncidentDays);
    expect(config.retention.autoPruneIntervalHours).toBe(DEFAULT_CONFIG.retention.autoPruneIntervalHours);
    expect(config.network.maxRequestBodyBytes).toBe(DEFAULT_CONFIG.network.maxRequestBodyBytes);
    expect(config.sampling).toEqual(DEFAULT_CONFIG.sampling);
  });

  it("keeps sampling usable when rules have the wrong shape", () => {
    // `rules: {}` used to make shouldStore's .find throw on EVERY event; the
    // collector turned that into a 400 and dropped the event silently.
    const config = write("sampling:\n  rules: {}\n");
    expect(config.sampling.rules).toEqual([]);
    expect(() => shouldStore("/api/todos", "success", config)).not.toThrow();
    expect(shouldStore("/api/todos", "success", config)).toBe(true);
  });

  it("rejects a rule list containing malformed entries", () => {
    const config = write(
      ["sampling:", "  rules:", "    - route: /api", "      rate: nope"].join("\n"),
    );
    expect(config.sampling.rules).toEqual([]);
  });

  it("falls back entirely when the file is not a YAML mapping", () => {
    expect(write("- just\n- a list\n")).toEqual(DEFAULT_CONFIG);
    expect(loadConfig(path.join(dir, "missing"))).toEqual(DEFAULT_CONFIG);
  });
});

describe("shouldStore sampling rules", () => {
  it("uses the longest matching route prefix, not the first listed", () => {
    const config = {
      ...DEFAULT_CONFIG,
      sampling: {
        defaultRate: 1,
        rules: [
          { route: "/api", rate: 1 },
          { route: "/api/health", rate: 0 },
        ],
      },
    };
    expect(shouldStore("/api/health", "success", config)).toBe(false);
    expect(shouldStore("/api/todos", "success", config)).toBe(true);
  });
});
