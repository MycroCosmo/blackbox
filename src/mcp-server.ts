import readline from "node:readline";
import type { BlackboxConfig } from "./config.js";
import { renderNetworkReport } from "./network-report.js";
import { renderIncidentReport } from "./report.js";
import { replayRequest } from "./replay.js";
import { runCommand } from "./runner.js";
import type { Storage } from "./storage.js";
import type { IncidentRecord } from "./types.js";

/** MCP server (Phase 3, spec 16). Stdio transport: newline-delimited
 *  JSON-RPC 2.0. Implemented without an SDK dependency — the protocol
 *  surface we need (initialize / tools/list / tools/call / ping) is small.
 *  Agents query structured incidents instead of re-reading whole logs. */

const PROTOCOL_VERSION = "2024-11-05";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

const TOOLS: ToolDef[] = [
  {
    name: "run_command",
    description:
      "Run a shell command through the blackbox. Failures are recorded as incidents; the child's exit code is returned unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "array", items: { type: "string" }, description: "command and args, e.g. [\"npm\",\"test\"]" },
        timeoutSeconds: { type: "number" },
      },
      required: ["command"],
    },
  },
  {
    name: "list_incidents",
    description: "List incidents (deduplicated by fingerprint). Optionally filter by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "resolve_candidate", "resolved"] },
      },
    },
  },
  {
    name: "get_incident",
    description: "Get one incident in full detail, including the tail of its captured log.",
    inputSchema: {
      type: "object",
      properties: {
        incidentId: { type: "string" },
        logLines: { type: "number", description: "trailing log lines to include (default 50)" },
      },
      required: ["incidentId"],
    },
  },
  {
    name: "find_similar_incidents",
    description:
      "Search incidents similar to an error message or description (token overlap on type, message and fingerprint). Use before analyzing an error from scratch.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "list_network_requests",
    description: "List recorded network events. Filter by trace id or failures only.",
    inputSchema: {
      type: "object",
      properties: {
        traceId: { type: "string" },
        failedOnly: { type: "boolean" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_network_request",
    description: "Get one network event in full detail plus every event sharing its trace id.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
    },
  },
  {
    name: "replay_request",
    description:
      "Replay a recorded request and compare responses. Idempotent methods only unless allowUnsafe is true (requires user confirmation). External hosts are blocked.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        allowUnsafe: { type: "boolean" },
        baseUrl: { type: "string", description: "base URL for relative recorded URLs, e.g. http://127.0.0.1:8080" },
      },
      required: ["requestId"],
    },
  },
  {
    name: "generate_report",
    description: "Regenerate a Markdown report (incident report or NETWORK.md) and return its content.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["incident", "network"] },
        incidentId: { type: "string", description: "required when type is 'incident'" },
      },
      required: ["type"],
    },
  },
];

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter((t) => t.length > 2),
  );
}

function similarity(query: Set<string>, inc: IncidentRecord): number {
  const target = tokenize(`${inc.errorType} ${inc.message} ${inc.fingerprint} ${inc.lastCommand}`);
  if (query.size === 0 || target.size === 0) return 0;
  let hit = 0;
  for (const t of query) if (target.has(t)) hit++;
  return hit / query.size;
}

export function createMcpTools(storage: Storage, config: BlackboxConfig) {
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (name) {
      case "run_command": {
        const argv = args.command;
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
          throw new Error("command must be a non-empty string array");
        }
        const outcome = await runCommand(argv, {
          cwd: process.cwd(),
          config,
          storage,
          quiet: true, // stdout belongs to the JSON-RPC channel
          stdin: "ignore", // stdin belongs to the JSON-RPC channel too
          timeoutMs: typeof args.timeoutSeconds === "number" ? args.timeoutSeconds * 1000 : undefined,
        });
        const incident = outcome.incidentId ? storage.findIncident(outcome.incidentId) : undefined;
        return {
          exitCode: outcome.exitCode,
          incidentId: outcome.incidentId,
          incident: incident && {
            errorType: incident.errorType,
            message: incident.message,
            occurrenceCount: incident.occurrenceCount,
            lastLocation: incident.lastLocation,
            facts: incident.facts,
          },
        };
      }
      case "list_incidents": {
        let incidents = storage.readIncidents();
        if (typeof args.status === "string") incidents = incidents.filter((i) => i.status === args.status);
        return {
          incidents: incidents.map((i) => ({
            incidentId: i.incidentId,
            kind: i.kind,
            errorType: i.errorType,
            message: i.message,
            status: i.status,
            occurrenceCount: i.occurrenceCount,
            lastSeenAt: i.lastSeenAt,
            lastCommand: i.lastCommand,
          })),
        };
      }
      case "get_incident": {
        const inc = storage.findIncident(String(args.incidentId ?? ""));
        if (!inc) throw new Error(`incident not found: ${args.incidentId}`);
        const n = typeof args.logLines === "number" ? args.logLines : 50;
        const log = inc.logBlob ? storage.readLogBlob(inc.logBlob) : undefined;
        return { incident: inc, logTail: log ? log.split("\n").slice(-n) : [] };
      }
      case "find_similar_incidents": {
        const query = tokenize(String(args.query ?? ""));
        const scored = storage
          .readIncidents()
          .map((inc) => ({ score: Math.round(similarity(query, inc) * 100) / 100, incident: inc }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        return {
          matches: scored.map((s) => ({
            score: s.score,
            incidentId: s.incident.incidentId,
            errorType: s.incident.errorType,
            message: s.incident.message,
            status: s.incident.status,
            occurrenceCount: s.incident.occurrenceCount,
          })),
        };
      }
      case "list_network_requests": {
        let events = storage.readNetwork();
        if (typeof args.traceId === "string") events = events.filter((e) => e.traceId === args.traceId);
        if (args.failedOnly === true) {
          events = events.filter((e) => e.classification !== "success" && e.classification !== "slow_response");
        }
        const limit = typeof args.limit === "number" ? args.limit : 50;
        return {
          events: events.slice(-limit).map((e) => ({
            requestId: e.requestId,
            timestamp: e.timestamp,
            traceId: e.traceId,
            method: e.method,
            url: e.url,
            status: e.status,
            durationMs: e.durationMs,
            classification: e.classification,
            incidentId: e.incidentId,
          })),
        };
      }
      case "get_network_request": {
        const event = storage.findNetwork(String(args.requestId ?? ""));
        if (!event) throw new Error(`network event not found: ${args.requestId}`);
        const trace = event.traceId
          ? storage.readNetwork().filter((e) => e.traceId === event.traceId && e.requestId !== event.requestId)
          : [];
        return { event, trace };
      }
      case "replay_request": {
        return replayRequest(storage, String(args.requestId ?? ""), {
          allowUnsafe: args.allowUnsafe === true,
          baseUrl: typeof args.baseUrl === "string" ? args.baseUrl : undefined,
        });
      }
      case "generate_report": {
        if (args.type === "incident") {
          const inc = storage.findIncident(String(args.incidentId ?? ""));
          if (!inc) throw new Error(`incident not found: ${args.incidentId}`);
          const markdown = renderIncidentReport(inc, config.reportLanguage);
          const file = storage.writeReport(inc.incidentId, markdown);
          return { file, markdown };
        }
        if (args.type === "network") {
          return { markdown: renderNetworkReport(storage.readNetwork(), { lang: config.reportLanguage }) };
        }
        throw new Error("type must be 'incident' or 'network'");
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  };
  return { tools: TOOLS, call };
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Serves MCP over stdio until stdin closes. */
export async function runMcpServer(storage: Storage, config: BlackboxConfig): Promise<void> {
  const { tools, call } = createMcpTools(storage, config);
  const write = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const inFlight = new Set<Promise<unknown>>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: JsonRpcRequest;
    try {
      // Strip a UTF-8 BOM some shells prepend to the first piped line.
      req = JSON.parse(line.replace(/^\uFEFF/, ""));
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (req.method?.startsWith("notifications/")) continue; // no response
    const reply = (result: unknown) => write({ jsonrpc: "2.0", id: req.id ?? null, result });
    const fail = (code: number, message: string) =>
      write({ jsonrpc: "2.0", id: req.id ?? null, error: { code, message } });

    try {
      switch (req.method) {
        case "initialize":
          reply({
            // Only advertise the protocol revision this implementation
            // actually supports. Echoing an unknown client version would
            // falsely complete negotiation and can cause later incompatibility.
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "dev-blackbox", version: "0.1.0" },
          });
          break;
        case "ping":
          reply({});
          break;
        case "tools/list":
          reply({ tools });
          break;
        case "tools/call": {
          const name = String(req.params?.name ?? "");
          const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
          // A slow tool (run_command has no mandatory timeout) must not block
          // the read loop, or ping/other requests stall until it finishes.
          // Dispatch async; the JSON-RPC id captured in reply() matches the
          // response to its request regardless of completion order.
          const task = call(name, args).then(
            (result) => reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }),
            (e) =>
              reply({
                content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
                isError: true,
              }),
          );
          inFlight.add(task);
          void task.finally(() => inFlight.delete(task));
          break;
        }
        default:
          fail(-32601, `method not found: ${req.method}`);
      }
    } catch (e) {
      fail(-32603, e instanceof Error ? e.message : String(e));
    }
  }
  // stdin closed — drain in-flight tool calls so their children and storage
  // writes finish before the process exits.
  await Promise.allSettled(inFlight);
}
