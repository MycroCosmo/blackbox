#!/usr/bin/env node
// Summarizes bench/results/*.json into Markdown tables (medians per
// task x condition, then every individual run). Nothing is filtered out:
// failed, timed-out, and budget-capped runs are counted exactly like the rest.
//
// Usage: node bench/summarize.mjs [--results <dir>] [--out <file>]
//   default --out: bench/results/SUMMARY.md (also printed to stdout)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { results: path.join(benchDir, "results"), out: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--results") out.results = path.resolve(argv[i + 1]);
    else if (argv[i] === "--out") out.out = path.resolve(argv[i + 1]);
    else throw new Error(`unexpected argument: ${argv[i]}`);
  }
  out.out ??= path.join(out.results, "SUMMARY.md");
  return out;
}

function median(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const int = (v) => (v === null ? "n/a" : Math.round(v).toLocaleString("en-US"));
const secs = (ms) => (ms === null ? "n/a" : (ms / 1000).toFixed(0));
const usd = (v) => (v === null ? "n/a" : v.toFixed(2));
const one = (v) => (v === null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(1));

function change(a, c) {
  if (a === null || c === null || a === 0) return "n/a";
  const pct = ((c - a) / a) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function load(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }))
    .sort((x, y) => x.task.localeCompare(y.task) || x.condition.localeCompare(y.condition) || x.trial - y.trial);
}

function cell(runs) {
  return {
    n: runs.length,
    passed: runs.filter((r) => r.passed).length,
    input: median(runs.map((r) => r.inputTokens?.total ?? null)),
    output: median(runs.map((r) => r.outputTokens)),
    testRuns: median(runs.map((r) => r.testRuns)),
    streak: median(runs.map((r) => r.maxSameFingerprintStreak)),
    failedRun: median(runs.map((r) => r.maxConsecutiveFailedTestRuns)),
    wall: median(runs.map((r) => r.wallMs)),
    cost: median(runs.map((r) => r.costUsd)),
  };
}

function render(records) {
  const out = [];
  if (records.length === 0) return "No results yet. Run `bash bench/run.sh` first.\n";

  const tasks = [...new Set(records.map((r) => r.task))];
  const models = [...new Set(records.map((r) => r.model ?? "unknown"))];
  const versions = [...new Set(records.map((r) => r.claudeCodeVersion ?? "unknown"))];
  const dates = records.map((r) => r.analyzedAt).filter(Boolean).sort();

  out.push("## Results (median per cell)");
  out.push("");
  out.push(
    "| Task | Condition | Runs | Passed | Input tokens | Output tokens | Test runs | Max same-fingerprint streak | Max consecutive failed runs | Wall time (s) | Cost (USD) |",
  );
  out.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const cells = {};
  for (const task of tasks) {
    for (const condition of ["A", "C"]) {
      const runs = records.filter((r) => r.task === task && r.condition === condition);
      if (runs.length === 0) continue;
      const c = (cells[`${task}/${condition}`] = cell(runs));
      out.push(
        `| ${task} | ${condition} | ${c.n} | ${c.passed}/${c.n} | ${int(c.input)} | ${int(c.output)} | ${one(c.testRuns)} | ${one(c.streak)} | ${one(c.failedRun)} | ${secs(c.wall)} | ${usd(c.cost)} |`,
      );
    }
  }

  out.push("");
  out.push("## Change from A to C (median vs median)");
  out.push("");
  out.push("Negative means condition C used less. Pass counts are shown as-is.");
  out.push("");
  out.push("| Task | Passed A → C | Input tokens | Test runs | Max same-fingerprint streak | Wall time | Cost |");
  out.push("|---|---|---:|---:|---:|---:|---:|");
  for (const task of tasks) {
    const a = cells[`${task}/A`];
    const c = cells[`${task}/C`];
    if (!a || !c) continue;
    out.push(
      `| ${task} | ${a.passed}/${a.n} → ${c.passed}/${c.n} | ${change(a.input, c.input)} | ${change(a.testRuns, c.testRuns)} | ${change(a.streak, c.streak)} | ${change(a.wall, c.wall)} | ${change(a.cost, c.cost)} |`,
    );
  }

  out.push("");
  out.push("## Every run");
  out.push("");
  out.push(
    "| Run | Passed | Input tokens | Test runs (failed) | Hook denials | Max streak | Wall (s) | Cost (USD) | Result | Notes |",
  );
  out.push("|---|---|---:|---:|---:|---:|---:|---:|---|---|");
  for (const r of records) {
    const notes = [];
    if (r.timedOut) notes.push("timed out");
    if (r.claudeExitCode !== 0 && !r.timedOut) notes.push(`claude exit ${r.claudeExitCode}`);
    if (r.transcriptMalformedLines) notes.push(`${r.transcriptMalformedLines} malformed lines`);
    if (r.permissionDenials) notes.push(`${r.permissionDenials} permission denials`);
    out.push(
      `| ${r.task} ${r.condition} #${r.trial} | ${r.passed ? "yes" : "no"} | ${int(r.inputTokens?.total ?? null)} | ${r.testRuns} (${r.failedTestRuns}) | ${r.hookDeniedTestCommands} | ${r.maxSameFingerprintStreak} | ${secs(r.wallMs)} | ${usd(r.costUsd)} | ${r.resultSubtype ?? "no result"} | ${notes.join(", ")} |`,
    );
  }

  out.push("");
  out.push("## Setup");
  out.push("");
  out.push(`- Models: ${models.join(", ")}`);
  out.push(`- Claude Code: ${versions.join(", ")}`);
  out.push(`- Isolation: ${[...new Set(records.map((r) => (r.bare ? "--bare" : "--setting-sources project,local")))].join(", ")}`);
  out.push(`- Analyzed: ${dates[0]} … ${dates[dates.length - 1]}`);
  out.push(`- Runs: ${records.length}`);
  const counts = new Set(Object.values(cells).map((c) => c.n));
  if (counts.size > 1) out.push("- **Warning:** cells have different run counts.");
  if (models.length > 1) out.push("- **Warning:** runs used more than one model.");
  out.push("");
  out.push(
    "Input tokens = uncached input + cache writes + cache reads, from the `result` message's `usage`. " +
      "Test runs count executed test/build commands; commands denied by the dev-blackbox hook are listed separately. " +
      "Max same-fingerprint streak = longest run of consecutive failed test runs whose output produced the same fingerprint " +
      "(dev-blackbox's detector, applied identically to A and C, to the output the agent saw — so it undercounts when the agent " +
      "hid the exception with `| tail`). Max consecutive failed runs ignores fingerprints. Methodology: bench/README.md.",
  );
  return out.join("\n") + "\n";
}

const args = parseArgs(process.argv.slice(2));
const markdown = render(load(args.results));
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, markdown, "utf8");
process.stdout.write(markdown);
