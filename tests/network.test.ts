import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildNetworkRecord, classify, processBody, shouldStore } from "../src/network.js";
import { Redactor } from "../src/security.js";

const redactor = new Redactor(DEFAULT_CONFIG.security.redactBodyKeys);
const cfg = DEFAULT_CONFIG;
const req = (over: object = {}) => ({
  request: { method: "GET", url: "/api/todos" },
  response: { status: 200, body: { ok: true } },
  durationMs: 50,
  ...over,
});

describe("classify (spec 5.4: HTTP 200 alone is not success)", () => {
  it("classifies basic outcomes", () => {
    expect(classify(req(), cfg)).toBe("success");
    expect(classify(req({ response: { status: 500, body: {} } }), cfg)).toBe("http_error");
    expect(classify(req({ response: { status: 404 } }), cfg)).toBe("http_error");
    expect(classify(req({ response: undefined, error: { message: "refused" } }), cfg)).toBe(
      "network_error",
    );
    expect(classify(req({ error: { type: "timeout" } }), cfg)).toBe("timeout");
    expect(classify(req({ error: { type: "cors_error" } }), cfg)).toBe("cors_error");
    expect(classify(req({ classification: "contract_mismatch" }), cfg)).toBe("contract_mismatch");
  });

  it("flags empty and slow 200 responses", () => {
    expect(classify(req({ response: { status: 200, body: null } }), cfg)).toBe("empty_response");
    expect(classify(req({ durationMs: 5000 }), cfg)).toBe("slow_response");
  });
});

describe("shouldStore sampling (spec 7.3)", () => {
  const sampled = {
    ...cfg,
    sampling: { defaultRate: 1.0, rules: [{ route: "/api/health", rate: 0 }] },
  };
  it("always stores failures, even on rate-0 routes", () => {
    expect(shouldStore("/api/health", "http_error", sampled)).toBe(true);
  });
  it("drops sampled-out successes", () => {
    expect(shouldStore("/api/health", "success", sampled)).toBe(false);
    expect(shouldStore("/api/todos", "success", sampled)).toBe(true);
  });
  it("applies fractional rates", () => {
    const half = { ...cfg, sampling: { defaultRate: 0.5, rules: [] } };
    expect(shouldStore("/x", "success", half, () => 0.4)).toBe(true);
    expect(shouldStore("/x", "success", half, () => 0.6)).toBe(false);
  });
});

describe("processBody (spec 7.4, 8)", () => {
  it("truncates oversized payloads with metadata", () => {
    const big = "a".repeat(200 * 1024);
    const { body, meta } = processBody(big, undefined, 64 * 1024, redactor, true);
    expect(meta).toMatchObject({ truncated: true, originalBytes: 200 * 1024 });
    expect((body as string).length).toBeLessThanOrEqual(64 * 1024);
  });

  it("excludes binary bodies by content type", () => {
    const { body, meta } = processBody("....", { "Content-Type": "image/png" }, 1024, redactor, true);
    expect(body).toBeUndefined();
    expect(meta).toEqual({ excluded: "binary" });
  });

  it("redacts secrets before storing", () => {
    const { body } = processBody(
      { email: "a@b.c", password: "hunter2" },
      undefined,
      64 * 1024,
      redactor,
      true,
    );
    expect(body).toEqual({ email: "a@b.c", password: "[REDACTED]" });
  });
});

describe("buildNetworkRecord", () => {
  it("validates required fields", () => {
    expect(() =>
      buildNetworkRecord({}, { requestId: "REQ-1", sessionId: "S" }, cfg, redactor),
    ).toThrow(/request\.method/);
  });

  it("normalizes a full event and masks headers", () => {
    const record = buildNetworkRecord(
      {
        traceId: "TRACE-001",
        request: {
          method: "post",
          url: "/api/todos",
          headers: { Authorization: "Bearer tok123", "content-type": "application/json" },
          body: { title: "x", priority: null },
        },
        response: { status: 500, body: { message: "Internal Server Error" } },
        durationMs: 84,
      },
      { requestId: "REQ-20260714-001", sessionId: "SESSION-1" },
      cfg,
      redactor,
    );
    expect(record.method).toBe("POST");
    expect(record.classification).toBe("http_error");
    expect(record.traceId).toBe("TRACE-001");
    expect(record.requestHeaders?.Authorization).toBe("[REDACTED]");
    expect(record.requestBody).toEqual({ title: "x", priority: null });
  });
});
