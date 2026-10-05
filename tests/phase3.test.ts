import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideClaudeHook } from "../src/claude-hook.js";
import { startCollector, type Collector } from "../src/collector-server.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { validateAgainstSchema } from "../src/contracts.js";
import { runInit, setupClaudeCodeHook } from "../src/init.js";
import { createMcpTools } from "../src/mcp-server.js";
import { diffValues, replayRequest } from "../src/replay.js";
import { Storage } from "../src/storage.js";

let dir: string;
let storage: Storage;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbb-p3-"));
  storage = new Storage(path.join(dir, ".dev-blackbox"));
  storage.ensureDirs();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ contracts
describe("contract checks (spec 5.4)", () => {
  const schema = {
    type: "object" as const,
    required: ["id", "userName"],
    properties: { id: { type: "number" as const }, userName: { type: "string" as const } },
  };

  it("detects the userName/username mismatch from the spec example", () => {
    const mismatches = validateAgainstSchema({ id: 1, username: "ian" }, schema);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ path: "$.userName", actual: "missing" });
    expect(validateAgainstSchema({ id: 1, userName: "ian" }, schema)).toHaveLength(0);
  });

  it("validates nested types, arrays and enums", () => {
    expect(validateAgainstSchema({ id: "1", userName: "x" }, schema)[0]).toMatchObject({
      path: "$.id",
      expected: "number",
      actual: "string",
    });
    expect(
      validateAgainstSchema([1, "x"], { type: "array", items: { type: "number" } }),
    ).toHaveLength(1);
    expect(validateAgainstSchema("c", { enum: ["a", "b"] })).toHaveLength(1);
  });

  it("classifies HTTP 200 with a broken shape as contract_mismatch via the collector", async () => {
    fs.writeFileSync(
      path.join(storage.root, "contracts.json"),
      JSON.stringify({ contracts: [{ method: "GET", route: "/api/user", responseSchema: schema }] }),
      "utf8",
    );
    const collector = await startCollector({ storage, config: DEFAULT_CONFIG, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${collector.port}/events/network`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: { method: "GET", url: "/api/user" },
          response: { status: 200, body: { id: 1, username: "ian" } },
          durationMs: 10,
        }),
      });
      const json = await res.json();
      expect(json.classification).toBe("contract_mismatch");
      expect(json.incidentId).toMatch(/^INC-/); // failure → linked incident
      const [event] = storage.readNetwork();
      expect(event!.contractMismatches?.[0]?.path).toBe("$.userName");
    } finally {
      await collector.close();
    }
  });
});

// ------------------------------------------------------------ incident linking
describe("network failure → incident linking (Phase 3)", () => {
  let collector: Collector;
  beforeEach(async () => {
    collector = await startCollector({ storage, config: DEFAULT_CONFIG, port: 0 });
  });
  afterEach(async () => {
    await collector.close();
  });

  const post = (url: string) =>
    fetch(`http://127.0.0.1:${collector.port}/events/network`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { method: "POST", url },
        response: { status: 500, body: { message: "boom" } },
      }),
    }).then((r) => r.json());

  it("merges repeated failures on the same route (ids normalized)", async () => {
    const a = await post("/api/todos/42");
    const b = await post("/api/todos/977");
    expect(a.incidentId).toBeDefined();
    expect(b.incidentId).toBe(a.incidentId);
    const inc = storage.findIncident(a.incidentId)!;
    expect(inc.kind).toBe("NETWORK_FAILURE");
    expect(inc.errorType).toBe("HTTP_500");
    expect(inc.occurrenceCount).toBe(2);
  });

  it("keeps failures on different routes in separate incidents", async () => {
    const charge = await post("/charge/42");
    const refund = await post("/refund/42");
    expect(refund.incidentId).not.toBe(charge.incidentId);
    expect(storage.readIncidents()).toHaveLength(2);
  });
});

// ------------------------------------------------------------ replay
describe("replay (spec 8 safety rules)", () => {
  let server: http.Server;
  let port: number;
  let lastReq: { method?: string; headers?: http.IncomingHttpHeaders };

  beforeEach(async () => {
    lastReq = {};
    server = http.createServer((req, res) => {
      lastReq = { method: req.method, headers: req.headers };
      if (req.url === "/redirect-external") {
        res.writeHead(302, { location: "https://example.com/leak" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/api/broken"
            ? { id: 1, username: "ian" }
            : { id: 1, userName: "ian" },
        ),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  function seedEvent(over: object = {}) {
    storage.appendNetwork({
      schemaVersion: 1,
      requestId: "REQ-20260714-001",
      sessionId: "S",
      receivedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
      method: "GET",
      url: "/api/user",
      status: 500,
      responseBody: { id: 1, username: "ian" },
      classification: "http_error",
      ...over,
    });
  }

  it("replays a GET, adds the replay header and diffs the responses", async () => {
    seedEvent();
    const result = await replayRequest(storage, "REQ-20260714-001", {
      baseUrl: `http://127.0.0.1:${port}`,
    });
    expect(lastReq.headers?.["x-dev-blackbox-replay"]).toBe("true");
    expect(result.after.status).toBe(200);
    expect(result.statusChanged).toBe(true);
    expect(result.bodyDiff.join("\n")).toContain("username");
  });

  it("rejects POST without --allow-unsafe and allows it with the flag", async () => {
    seedEvent({ method: "POST", requestBody: { title: "x" } });
    await expect(
      replayRequest(storage, "REQ-20260714-001", { baseUrl: `http://127.0.0.1:${port}` }),
    ).rejects.toThrow(/not idempotent/);
    const result = await replayRequest(storage, "REQ-20260714-001", {
      baseUrl: `http://127.0.0.1:${port}`,
      allowUnsafe: true,
    });
    expect(lastReq.method).toBe("POST");
    expect(result.after.status).toBe(200);
  });

  it("blocks external URLs", async () => {
    seedEvent({ url: "https://example.com/api/user" });
    await expect(replayRequest(storage, "REQ-20260714-001")).rejects.toThrow(/external hosts/);
  });

  it("blocks redirects from loopback to an external host", async () => {
    seedEvent({ url: "/redirect-external" });
    await expect(
      replayRequest(storage, "REQ-20260714-001", {
        baseUrl: `http://127.0.0.1:${port}`,
      }),
    ).rejects.toThrow(/external hosts/);
  });

  it("keeps a contract mismatch open when replay reproduces the broken body", async () => {
    fs.writeFileSync(
      path.join(storage.root, "contracts.json"),
      JSON.stringify({
        contracts: [
          {
            method: "GET",
            route: "/api/broken",
            responseSchema: {
              type: "object",
              required: ["id", "userName"],
              properties: {
                id: { type: "number" },
                userName: { type: "string" },
              },
            },
          },
        ],
      }),
      "utf8",
    );
    storage.appendIncident({
      schemaVersion: 1,
      incidentId: "INC-20260714-008",
      fingerprint: "NETWORK|contract_mismatch|GET|/api/broken",
      kind: "NETWORK_FAILURE",
      errorType: "CONTRACT_MISMATCH",
      message: "GET /api/broken -> 200",
      status: "open",
      pinned: false,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrenceCount: 1,
      lastCommand: "GET /api/broken",
      lastCwd: "",
      lastExitCode: 200,
      lastSignal: null,
      timedOut: false,
      relatedFiles: [],
      facts: [],
      hypotheses: [],
    });
    seedEvent({
      url: "/api/broken",
      status: 200,
      responseBody: { id: 1, username: "ian" },
      classification: "contract_mismatch",
      incidentId: "INC-20260714-008",
    });

    const result = await replayRequest(storage, "REQ-20260714-001", {
      baseUrl: `http://127.0.0.1:${port}`,
    });
    expect(result.after.classification).toBe("contract_mismatch");
    expect(result.resolveCandidate).toBeUndefined();
    expect(storage.findIncident("INC-20260714-008")?.status).toBe("open");
  });

  it("marks the linked incident as a resolve candidate when the failure is fixed", async () => {
    storage.appendIncident({
      schemaVersion: 1,
      incidentId: "INC-20260714-009",
      fingerprint: "NETWORK|http_error|GET|/api/user",
      kind: "NETWORK_FAILURE",
      errorType: "HTTP_500",
      message: "GET /api/user -> 500",
      status: "open",
      pinned: false,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occurrenceCount: 1,
      lastCommand: "GET /api/user",
      lastCwd: "",
      lastExitCode: 500,
      lastSignal: null,
      timedOut: false,
      relatedFiles: [],
      facts: [],
      hypotheses: [],
    });
    seedEvent({ incidentId: "INC-20260714-009" });
    const result = await replayRequest(storage, "REQ-20260714-001", {
      baseUrl: `http://127.0.0.1:${port}`,
    });
    expect(result.resolveCandidate).toBe("INC-20260714-009");
    expect(storage.findIncident("INC-20260714-009")?.status).toBe("resolve_candidate");
  });
});

// ------------------------------------------------------------ diff
describe("diffValues", () => {
  it("reports added, removed and changed paths", () => {
    const diff = diffValues({ a: 1, b: { c: "x" } }, { a: 2, b: { d: "y" } });
    expect(diff.join("\n")).toContain("$.a: 1 -> 2");
    expect(diff.join("\n")).toContain("$.b.c: removed");
    expect(diff.join("\n")).toContain("$.b.d: added");
    expect(diffValues({ a: 1 }, { a: 1 })).toHaveLength(0);
  });
});

// ------------------------------------------------------------ MCP tools
describe("MCP tools (Phase 3)", () => {
  it("lists tools and answers incident/network queries", async () => {
    const { tools, call } = createMcpTools(storage, DEFAULT_CONFIG);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "run_command",
        "list_incidents",
        "get_incident",
        "find_similar_incidents",
        "list_network_requests",
        "get_network_request",
        "replay_request",
        "generate_report",
      ]),
    );
    const empty = (await call("list_incidents", {})) as { incidents: unknown[] };
    expect(empty.incidents).toEqual([]);
  });

  it("run_command records failures and returns the exit code", async () => {
    const { call } = createMcpTools(storage, DEFAULT_CONFIG);
    const result = (await call("run_command", {
      command: [process.execPath, "-e", "console.error('TypeError: mcp failure'); process.exit(1)"],
    })) as { exitCode: number; incidentId?: string; incident?: { errorType: string } };
    expect(result.exitCode).toBe(1);
    expect(result.incident?.errorType).toBe("TypeError");

    const similar = (await call("find_similar_incidents", { query: "TypeError mcp failure" })) as {
      matches: { incidentId: string; score: number }[];
    };
    expect(similar.matches[0]?.incidentId).toBe(result.incidentId);

    const report = (await call("generate_report", {
      type: "incident",
      incidentId: result.incidentId,
    })) as { markdown: string };
    expect(report.markdown).toContain("TypeError");

    const networkReport = (await call("generate_report", { type: "network" })) as {
      file: string;
      markdown: string;
    };
    expect(networkReport.file).toBe(storage.networkSummaryFile);
    expect(fs.readFileSync(networkReport.file, "utf8")).toBe(networkReport.markdown);
  }, 20_000);

  it("accepts a UTF-8 BOM and negotiates MCP initialization", async () => {
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const cli = path.resolve("src", "cli.ts");
    const child = spawn(process.execPath, [tsxCli, cli, "mcp"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");

    try {
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffered = "";
        const timer = setTimeout(() => reject(new Error("MCP response timed out")), 5_000);
        child.stdout.on("data", (chunk: string) => {
          buffered += chunk;
          const newline = buffered.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      child.stdin.write(
        "\uFEFF" +
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2099-01-01",
              capabilities: {},
              clientInfo: { name: "test-client", version: "1.0.0" },
            },
          }) +
          "\n",
      );

      const message = await response;
      expect(message.result).toMatchObject({ protocolVersion: "2024-11-05" });
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }, 15_000);

  it("answers ping while a long run_command is still running", async () => {
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const cli = path.resolve("src", "cli.ts");
    const child = spawn(process.execPath, [tsxCli, cli, "mcp"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");

    try {
      const messages: Record<string, unknown>[] = [];
      const gotBoth = new Promise<void>((resolve, reject) => {
        let buffered = "";
        const timer = setTimeout(() => reject(new Error("MCP responses timed out")), 10_000);
        child.stdout.on("data", (chunk: string) => {
          buffered += chunk;
          let newline: number;
          while ((newline = buffered.indexOf("\n")) !== -1) {
            messages.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
            buffered = buffered.slice(newline + 1);
          }
          if (messages.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "run_command",
            arguments: {
              command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 1500)"],
            },
          },
        }) +
          "\n" +
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) +
          "\n",
      );

      await gotBoth;
      // The ping must not wait for the slow tool call.
      expect(messages[0]!.id).toBe(2);
      expect(messages[1]!.id).toBe(1);
      const result = messages[1]!.result as { content: { text: string }[] };
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ exitCode: 0 });
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 4_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }, 20_000);

  it("keeps MCP protocol stdin isolated from run_command children", async () => {
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const cli = path.resolve("src", "cli.ts");
    const child = spawn(process.execPath, [tsxCli, cli, "mcp"], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");

    try {
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffered = "";
        const timer = setTimeout(() => reject(new Error("MCP response timed out")), 5_000);
        child.stdout.on("data", (chunk: string) => {
          buffered += chunk;
          const newline = buffered.indexOf("\n");
          if (newline === -1) return;
          clearTimeout(timer);
          resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "run_command",
            arguments: {
              command: [
                process.execPath,
                "-e",
                "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))",
              ],
              timeoutSeconds: 1,
            },
          },
        }) + "\n",
      );

      const message = await response;
      const result = message.result as { content: { text: string }[] };
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ exitCode: 0 });
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }, 15_000);
});

// ------------------------------------------------------------ Claude Code hook
describe("claude-hook decision (spec 3.2 경로 2)", () => {
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

  it("rewrites unwrapped build/test commands instead of blocking them", () => {
    for (const cmd of [
      "npm test",
      "npm run build",
      "./gradlew test",
      "gradlew.bat test",
      "./mvnw -q test",
      "go test ./...",
      "pytest -q",
      "uv run pytest",
      "make",
      "make -j4 test",
    ]) {
      expect(decideClaudeHook(bash(cmd)).command, cmd).toBe(`npx dev-blackbox run -- ${cmd}`);
    }
  });

  it("wraps only the build/test stage of compound commands", () => {
    const cases: [string, string][] = [
      ["cd app && npm test", "cd app && npx dev-blackbox run -- npm test"],
      ["npm test 2>&1 | tail -50", "npx dev-blackbox run -- npm test 2>&1 | tail -50"],
      ["CI=1 npm test", "CI=1 npx dev-blackbox run -- npm test"],
      ["npm run lint; npm test", "npx dev-blackbox run -- npm run lint; npx dev-blackbox run -- npm test"],
      ["git stash || npm test", "git stash || npx dev-blackbox run -- npm test"],
      ['echo "a && npm test"', 'echo "a && npm test"'],
    ];
    for (const [input, expected] of cases) {
      expect(decideClaudeHook(bash(input)).command ?? input, input).toBe(expected);
    }
  });

  it("uses the install-specific command prefix", () => {
    expect(decideClaudeHook(bash("npm test"), "dev-blackbox").command).toBe("dev-blackbox run -- npm test");
  });

  it("leaves wrapped, long-running, and unrelated commands alone", () => {
    for (const cmd of [
      "npx dev-blackbox run -- npm test",
      "dev-blackbox run -- ./gradlew test",
      "npm run dev",
      "npm run dev:api",
      "npm start",
      "./gradlew bootRun",
      "./mvnw spring-boot:run",
      "npx vitest --watch",
      "make install",
      "git status",
      "ls -la",
      "cat <<EOF\nnpm test\nEOF",
      "echo $(npm test)",
    ]) {
      expect(decideClaudeHook(bash(cmd)).command, cmd).toBeUndefined();
    }
    expect(decideClaudeHook({ tool_name: "Read", tool_input: {} }).command).toBeUndefined();
    expect(decideClaudeHook("garbage").command).toBeUndefined();
  });

  it("init --hooks claude-code registers the hook idempotently", () => {
    const r1 = runInit(dir, { hooks: "claude-code", install: "global" });
    expect(r1.hooksConfigured).toBe(true);
    expect(setupClaudeCodeHook(dir, "global")).toBe(false); // second run: already there
    const settings = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain("dev-blackbox claude-hook");
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it("calls a local install directly and migrates the old npx hook in place", () => {
    const claudeDir = path.join(dir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const old = {
      permissions: { allow: ["Bash(git status)"] },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "npx dev-blackbox claude-hook" }] },
        ],
      },
    };
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify(old), "utf8");

    expect(setupClaudeCodeHook(dir, "local")).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    expect(settings.permissions).toEqual(old.permissions);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      'node "${CLAUDE_PROJECT_DIR}/node_modules/dev-blackbox/dist/cli.js" claude-hook',
    );
    expect(setupClaudeCodeHook(dir, "local")).toBe(false);
  });

  it("does not overwrite malformed Claude settings", () => {
    const claudeDir = path.join(dir, ".claude");
    const settingsFile = path.join(claudeDir, "settings.json");
    const original = '{\n  // keep this permission\n  "permissions": {}\n}\n';
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsFile, original, "utf8");

    expect(() => setupClaudeCodeHook(dir)).toThrow(/cannot update invalid Claude settings/);
    expect(fs.readFileSync(settingsFile, "utf8")).toBe(original);
  });
});
