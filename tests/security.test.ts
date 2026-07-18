import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { Redactor } from "../src/security.js";

const redactor = new Redactor(DEFAULT_CONFIG.security.redactBodyKeys);

describe("Redactor.redactLine", () => {
  it("masks JSON-style secret values", () => {
    const line = '{"email": "ian@example.com", "password": "hunter2", "accessToken": "abc123"}';
    const out = redactor.redactLine(line);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123");
    expect(out).toContain('"password": "[REDACTED]"');
    expect(out).toContain("ian@example.com");
  });

  it("masks header-style values", () => {
    expect(redactor.redactLine("Authorization: Bearer abcdef123456")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(redactor.redactLine("cookie: session=xyz")).toBe("cookie: [REDACTED]");
  });

  it("masks env-style assignments", () => {
    const out = redactor.redactLine("DB_PASSWORD=supersecret npm start");
    expect(out).not.toContain("supersecret");
  });

  it("masks separator and prefix variants consistently", () => {
    const json = redactor.redactLine(
      '{"x-api-key": "json-secret", "private_key": "private-secret", "ok": 1}',
    );
    const lines = [
      json,
      "X-Api-Key: header-secret",
      "PRIVATE_KEY=env-secret npm start",
      "GET /api?auth-token=query-secret&ok=1",
      "--client_secret=cli-secret",
    ];
    const out = lines.map((line) => redactor.redactLine(line)).join("\n");
    for (const secret of [
      "json-secret",
      "private-secret",
      "header-secret",
      "env-secret",
      "query-secret",
      "cli-secret",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(json).toContain('"ok": 1');
    expect(out).toContain("ok=1");
  });

  it("supports custom keys without changing ordinary fields", () => {
    const custom = new Redactor(["sessionCredential"]);
    expect(custom.redactLine('{"session-credential": "secret", "sessionId": "safe"}')).toBe(
      '{"session-credential": "[REDACTED]", "sessionId": "safe"}',
    );
  });

  it("masks JWTs and AWS keys anywhere in the line", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    expect(redactor.redactLine(`token ${jwt} used`)).not.toContain(jwt);
    expect(redactor.redactLine("key AKIAIOSFODNN7EXAMPLE ok")).not.toContain(
      "AKIAIOSFODNN7EXAMPLE",
    );
  });

  it("masks every line of a streamed private key block", () => {
    const fresh = new Redactor(DEFAULT_CONFIG.security.redactBodyKeys);
    expect(fresh.redactStreamLine("-----BEGIN PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(fresh.redactStreamLine("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC")).toBe("[REDACTED]");
    expect(fresh.redactStreamLine("-----END PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(fresh.redactStreamLine("normal output")).toBe("normal output");
  });

  it("keeps redactLine stateless after a truncated private key", () => {
    const fresh = new Redactor(DEFAULT_CONFIG.security.redactBodyKeys);
    // BEGIN without END: the marker line itself is masked...
    expect(fresh.redactLine("-----BEGIN RSA PRIVATE KEY-----")).toBe("[REDACTED]");
    // ...but no state may leak into later, unrelated calls.
    expect(fresh.redactLine("GET /api/todos 200 81ms")).toBe("GET /api/todos 200 81ms");
    const obj = fresh.redactObject({ note: "-----BEGIN RSA PRIVATE KEY-----" });
    expect(obj.note).toBe("[REDACTED]");
    expect(fresh.redactObject({ message: "ok", user: "ian" })).toEqual({
      message: "ok",
      user: "ian",
    });
  });

  it("redacts secret command arguments and URL credentials", () => {
    const command = redactor.redactCommand([
      "curl",
      "--password",
      "hunter2",
      "--access-token=abc123",
      "https://user:pw@example.test/api?apiKey=query-secret&ok=1",
    ]);
    expect(command).not.toContain("hunter2");
    expect(command).not.toContain("abc123");
    expect(command).not.toContain("query-secret");
    expect(command).not.toContain("user:pw");
    expect(command).toContain("[REDACTED]");
    expect(command).toContain("ok=1");
  });

  it("preserves the recorded shape of relative URLs (replay resolves them)", () => {
    // "api/x" vs "/api/x" resolve differently against a base URL with a path.
    expect(redactor.redactUrl("api/x")).toBe("api/x");
    const noSlash = redactor.redactUrl("api/x?apiKey=url-secret&ok=1");
    expect(noSlash.startsWith("api/x?")).toBe(true);
    expect(noSlash).not.toContain("url-secret");
    expect(noSlash).toContain("ok=1");
    const dotted = redactor.redactUrl("../v2/x?token=url-secret");
    expect(dotted.startsWith("../v2/x?")).toBe(true);
    expect(dotted).not.toContain("url-secret");
    expect(redactor.redactUrl("/api/x?ok=1")).toBe("/api/x?ok=1");
  });

  it("redacts the argument after a value-less secret flag (intentionally conservative)", () => {
    // We cannot tell a flag from a secret that starts with "-", so the next
    // argument is always masked. Over-masking beats leaking here.
    expect(redactor.redactCommand(["curl", "--password", "--verbose"])).toBe(
      "curl --password [REDACTED]",
    );
  });

  it("leaves normal log lines alone", () => {
    const line = "GET /api/todos 200 81ms";
    expect(redactor.redactLine(line)).toBe(line);
  });
});

describe("Redactor.redactObject", () => {
  it("masks matching keys recursively", () => {
    const out = redactor.redactObject({
      user: { email: "a@b.c", password: "pw", nested: { apiKey: "k" } },
      list: [{ refreshToken: "r" }],
    });
    expect(out.user.password).toBe("[REDACTED]");
    expect(out.user.nested.apiKey).toBe("[REDACTED]");
    expect(out.list[0]!.refreshToken).toBe("[REDACTED]");
    expect(out.user.email).toBe("a@b.c");
  });

  it("masks normalized and common secret-key variants recursively", () => {
    const out = redactor.redactObject({
      "x-api-key": "api-secret",
      private_key: "private-secret",
      nested: {
        "db-password": "db-secret",
        client_secret: "client-secret",
        harmless_key: "safe",
      },
    });
    expect(out["x-api-key"]).toBe("[REDACTED]");
    expect(out.private_key).toBe("[REDACTED]");
    expect(out.nested["db-password"]).toBe("[REDACTED]");
    expect(out.nested.client_secret).toBe("[REDACTED]");
    expect(out.nested.harmless_key).toBe("safe");
  });
});
