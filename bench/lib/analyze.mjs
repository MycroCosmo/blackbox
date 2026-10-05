#!/usr/bin/env node
// Turns one `claude -p --output-format stream-json --verbose` transcript into
// the metrics record stored in bench/results/<task>__<condition>__<trial>.json.
//
// Every metric is derived from the transcript the same way for condition A
// (no dev-blackbox) and condition C (dev-blackbox hook). In particular the
// failure fingerprint is recomputed here with dev-blackbox's own detector from
// the text the agent actually saw, instead of being read from .dev-blackbox/,
// which only exists in condition C.
//
// Usage:
//   node bench/lib/analyze.mjs --transcript <file> --task <id> --condition <A|C>
//     --trial <n> --verify-exit <code> --claude-exit <code> --wall-ms <ms>
//     [--dev-blackbox-version <v>] [--bare 0|1]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = pathToFileURL(path.join(repoRoot, "dist", "index.js")).href;
const { bestSoftSignal, fingerprintFromError } = await import(dist);

const SCHEMA = 1;

// Exact wording of the denial produced by src/claude-hook.ts.
const HOOK_DENIAL = "run build/test commands through the blackbox";

// A test run that exits 0 through a pipe (`./gradlew test | tail`) hides the
// failure from is_error, so the output text is checked too.
const FAIL_RE =
  /BUILD FAILED|\d+ tests? completed, \d+ failed|Tests?\s+\d+\s+failed|✗ Command failed|^\s*FAIL\s/m;

// Java identity hashes (MergedContextConfiguration@30c1da48) change on every
// JVM start. dev-blackbox's own fingerprint masks them too; the analysis masks
// them explicitly so the comparison does not depend on the packed version.
const IDENTITY_HASH_RE = /@[0-9a-f]{6,8}\b/g;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    out[key.slice(2)] = argv[i + 1];
  }
  for (const required of ["transcript", "task", "condition", "trial"]) {
    if (out[required] === undefined) throw new Error(`missing --${required}`);
  }
  return out;
}

function toInt(value) {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function readEvents(file) {
  const events = [];
  let malformed = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text ?? "" : ""))
      .join("\n");
  }
  return "";
}

/** Strips wrappers that do not change what is being run. */
function unwrapSegment(segment) {
  return segment
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
    .replace(/^(?:npx\s+)?dev-blackbox\s+run\s+(?:--timeout\s+\S+\s+)?(?:--\s+)?/, "")
    .replace(/^cmd(?:\.exe)?\s+\/+c\s+/i, "")
    .trim();
}

function isTestSegment(raw) {
  const s = unwrapSegment(raw);
  if (/--version|--help/.test(s)) return false;
  if (/^(?:\.[\\/])?gradlew(?:\.bat)?\s/.test(s + " ")) return /\b(?:test|build|check)\b/.test(s);
  if (/^gradle\s/.test(s)) return /\b(?:test|build|check)\b/.test(s);
  if (/^(?:\.\/)?mvnw?\s/.test(s)) return /\b(?:test|verify|package|install)\b/.test(s);
  if (/^(?:npx\s+)?vitest(?:\s|$)/.test(s)) return true;
  if (/^(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(s)) return true;
  if (/^(?:npx\s+)?jest(?:\s|$)/.test(s)) return true;
  return false;
}

export function isTestCommand(command) {
  return command.split(/&&|\|\|?|;|\r?\n/).some(isTestSegment);
}

export function fingerprintOf(text) {
  const lines = text.replace(ANSI_RE, "").replace(IDENTITY_HASH_RE, "@<hash>").split(/\r?\n/);
  const signal = bestSoftSignal(lines);
  if (!signal) return "UNCLASSIFIED";
  return fingerprintFromError(signal.errorType, signal.message, signal.location);
}

function analyze(events) {
  const toolUses = new Map(); // id -> { name, command, order }
  const toolResults = new Map(); // tool_use_id -> { text, isError }
  const assistantUsage = new Map(); // message.id -> usage (deduplicated)
  let init;
  let result;
  let order = 0;

  for (const ev of events) {
    if (ev.type === "system" && ev.subtype === "init") init = ev;
    if (ev.type === "result") result = ev;
    // Subagent traffic is excluded: condition runs deny the Agent tool anyway.
    if (ev.parent_tool_use_id) continue;

    if (ev.type === "assistant" && ev.message) {
      if (ev.message.id && ev.message.usage) assistantUsage.set(ev.message.id, ev.message.usage);
      for (const block of ev.message.content ?? []) {
        if (block?.type !== "tool_use") continue;
        toolUses.set(block.id, {
          name: block.name,
          command: typeof block.input?.command === "string" ? block.input.command : undefined,
          order: order++,
        });
      }
    }
    if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type !== "tool_result") continue;
        let text = blockText(block.content);
        const structured = ev.tool_use_result;
        if (text.trim() === "" && structured && typeof structured === "object") {
          text = [structured.stdout, structured.stderr].filter((s) => typeof s === "string").join("\n");
        }
        toolResults.set(block.tool_use_id, { text, isError: block.is_error === true });
      }
    }
  }

  const calls = [...toolUses.entries()].sort((a, b) => a[1].order - b[1].order);
  const testRuns = [];
  let hookDeniedTestCommands = 0;
  let bashCalls = 0;
  for (const [id, call] of calls) {
    if (call.name !== "Bash" || call.command === undefined) continue;
    bashCalls++;
    if (!isTestCommand(call.command)) continue;
    const res = toolResults.get(id) ?? { text: "", isError: false };
    if (res.text.includes(HOOK_DENIAL)) {
      hookDeniedTestCommands++;
      continue;
    }
    const failed = res.isError || FAIL_RE.test(res.text.replace(ANSI_RE, ""));
    testRuns.push({
      command: call.command,
      failed,
      fingerprint: failed ? fingerprintOf(res.text) : null,
      outputChars: res.text.length,
    });
  }

  // Longest run of back-to-back failed test runs sharing one fingerprint, and
  // (independent of what the output revealed) of back-to-back failed runs.
  let maxStreak = 0;
  let repeated = 0;
  let streak = 0;
  let previous = null;
  let maxFailedRun = 0;
  let failedRun = 0;
  for (const run of testRuns) {
    if (!run.failed) {
      streak = 0;
      previous = null;
      failedRun = 0;
      continue;
    }
    failedRun++;
    maxFailedRun = Math.max(maxFailedRun, failedRun);
    if (previous !== null && run.fingerprint === previous) {
      streak++;
      repeated++;
    } else {
      streak = 1;
    }
    previous = run.fingerprint;
    maxStreak = Math.max(maxStreak, streak);
  }

  const summed = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  for (const usage of assistantUsage.values()) {
    for (const key of Object.keys(summed)) summed[key] += Number(usage[key] ?? 0);
  }

  return {
    init,
    result,
    testRuns,
    hookDeniedTestCommands,
    bashCalls,
    toolCalls: calls.length,
    maxStreak,
    repeated,
    maxFailedRun,
    summed,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { events, malformed } = readEvents(args.transcript);
  const a = analyze(events);
  const usage = a.result?.usage ?? {};
  const uncached = Number(usage.input_tokens ?? 0);
  const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
  const verifyExit = toInt(args["verify-exit"]);
  const claudeExit = toInt(args["claude-exit"]);

  const record = {
    schema: SCHEMA,
    task: args.task,
    condition: args.condition,
    trial: Number(args.trial),
    analyzedAt: new Date().toISOString(),
    bare: args.bare === "1",
    model: a.init?.model ?? null,
    claudeCodeVersion: a.init?.claude_code_version ?? null,
    devBlackboxVersion: args["dev-blackbox-version"] || null,

    passed: verifyExit === 0,
    verifyExitCode: verifyExit,

    // "Input tokens" = everything the model read: uncached + cache writes + cache reads.
    inputTokens: {
      total: a.result ? uncached + cacheCreation + cacheRead : null,
      uncached: a.result ? uncached : null,
      cacheCreation: a.result ? cacheCreation : null,
      cacheRead: a.result ? cacheRead : null,
    },
    outputTokens: a.result ? Number(usage.output_tokens ?? 0) : null,
    // Cross-check: per-message usage summed from assistant events (deduplicated by message id).
    assistantUsageSum: a.summed,
    costUsd: a.result?.total_cost_usd ?? null,

    testRuns: a.testRuns.length,
    failedTestRuns: a.testRuns.filter((r) => r.failed).length,
    hookDeniedTestCommands: a.hookDeniedTestCommands,
    maxSameFingerprintStreak: a.maxStreak,
    repeatedSameFingerprintFailures: a.repeated,
    maxConsecutiveFailedTestRuns: a.maxFailedRun,
    testRunLog: a.testRuns,

    wallMs: toInt(args["wall-ms"]),
    durationMs: a.result?.duration_ms ?? null,
    durationApiMs: a.result?.duration_api_ms ?? null,
    numTurns: a.result?.num_turns ?? null,
    bashCalls: a.bashCalls,
    toolCalls: a.toolCalls,

    resultSubtype: a.result?.subtype ?? null,
    resultIsError: a.result?.is_error ?? null,
    permissionDenials: Array.isArray(a.result?.permission_denials) ? a.result.permission_denials.length : null,
    claudeExitCode: claudeExit,
    timedOut: claudeExit === 124,
    transcriptEvents: events.length,
    transcriptMalformedLines: malformed,
  };
  process.stdout.write(JSON.stringify(record, null, 2) + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
