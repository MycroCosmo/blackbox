# dev-blackbox benchmark

A small, reproducible A/B check of whether dev-blackbox changes how a coding
agent behaves on failing tests. It is not a general benchmark of agents or
models. Three tasks, two conditions, three trials each; every number in the
summary is a median of three runs, and every individual run is listed too.

## Tasks

Each task is a standalone project under `tasks/<id>/project/`, plus
`TASK.md` (the one-line prompt), `verify.sh` (the grader), and `hidden/`
(grader-only tests the agent never sees).

| Task | Stack | What the agent sees | Actual cause |
|---|---|---|---|
| `a-npe-dto-mapping` | Spring Boot 3.3, JUnit 5, Gradle | `NullPointerException` in `ShippingLabelService.labelFor` | `BeanUtils.copyProperties` silently skips `Customer.address` → `CustomerDto.shippingAddress` (different name and type), so the DTO field is never mapped |
| `b-gradle-noisy-log` | Spring Boot 3.3, JUnit 5, Gradle | ~4,900 lines of output; the last ~4,400 are repeated `ApplicationContext failure threshold (1) exceeded` traces | `application.yml` has `pricing.vat-rate: 10%`, which cannot bind to `BigDecimal`. The cause is printed once, in the first ~480 lines |
| `c-vitest-shared-state` | TypeScript, Vitest 2 | `expected '$1,999' to be '$19.99'` (and two similar) in formatter tests; each failing test passes when run alone | `resolveOptions` uses `Object.assign(DEFAULT_OPTIONS, overrides)`, so an earlier test's overrides mutate the shared defaults |

`verify.sh <workspace>` restores the original test files (so editing or
deleting tests cannot pass), adds the hidden test, and runs the suite. The
hidden tests reject the obvious surface fixes: a null guard in task a, a
changed property type or hard-coded rate in task b, and patching single call
sites in task c. Each grader was checked locally against the unfixed project
(fails), a surface fix (fails), and the intended fix (passes).

## Conditions

| | Setup in the trial workspace |
|---|---|
| **A** | The task project as-is. No dev-blackbox. |
| **C** | Same project, plus dev-blackbox 0.3.0 packed from this checkout: `npm i -D <tarball>` and `dev-blackbox init --hooks claude-code`. This adds the `PreToolUse` hook (rewrites unwrapped build/test commands to go through `dev-blackbox run`), the agent rules block in `CLAUDE.md`, and the failure summary that `run` prints at the end of stderr (error, location, earliest cause, and the files changed between repeated failures). |

For the Java tasks, condition C also gets a minimal `package.json`, because
that is how dev-blackbox is installed. Condition C changes several things at
once (hook, rules, summary), so the benchmark measures the package as shipped,
not any single feature.

## Running it

Every trial is a full, paid `claude -p` session. The default matrix is
3 tasks × 2 conditions × 3 trials = **18 sessions**, each capped by
`--max-budget-usd` (default 5 USD, so the hard ceiling is 90 USD). Finished
trials are skipped on re-run.

Requirements: Claude Code CLI (logged in, or `ANTHROPIC_API_KEY` with
`BARE=1`), Node.js 20+, npm, git, and JDK 17+ for the Spring Boot tasks.
**Run on macOS, Linux, or WSL**; see "Known issues" for Windows.

```bash
MODEL=sonnet bash bench/run.sh
node bench/summarize.mjs
```

Useful knobs (all environment variables; see the header of `run.sh`):

```bash
TASKS=c-vitest-shared-state TRIALS=1 bash bench/run.sh   # one cheap smoke run first
MODEL=opus MAX_BUDGET_USD=3 bash bench/run.sh
BARE=1 bash bench/run.sh                                  # strict isolation, API key auth
FORCE=1 bash bench/run.sh                                 # redo existing trials
```

What `run.sh` does per trial:

1. Copies the task project to a fresh temp workspace **outside this
   repository**, so the agent cannot read `hidden/` or `verify.sh`.
2. Installs dependencies and compiles once (not timed), applies the
   condition's setup, and commits a baseline with `git`.
3. Runs, from the workspace:
   `claude -p "<TASK.md>" --output-format stream-json --verbose --permission-mode dontAsk --allowedTools "Bash,Read,Edit,Write,Glob,Grep" --max-budget-usd <n> --no-session-persistence --strict-mcp-config --setting-sources project,local [--model <m>]`
4. Saves the transcript, the agent's diff, and the grader log to
   `results/raw/<task>__<condition>__<trial>/`, runs `verify.sh`, and writes
   `results/<task>__<condition>__<trial>.json`.

Trials are interleaved (trial 1 of every task and condition, then trial 2, …)
so API load drift does not line up with one condition.

`stream-json` is used instead of `json` because the tool calls and tool
results are needed to count test runs. The last line of the stream is the
same `result` object that `--output-format json` prints (`usage`,
`total_cost_usd`, `duration_ms`, `num_turns`, `subtype`, `is_error`).

## Metrics

All metrics are computed by `lib/analyze.mjs` from the transcript, the same
way for both conditions.

| Metric | Definition |
|---|---|
| Passed | `verify.sh` exit code 0 |
| Input tokens | `usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens` from the final `result` message, i.e. every input token the model read. The three parts are stored separately in the JSON |
| Test runs | Executed Bash calls that run the test/build command (`gradlew test/build/check`, `vitest`, `npm test`, …, with or without `dev-blackbox run --`). Calls denied by the dev-blackbox hook are **not** counted here; they are reported as `hookDeniedTestCommands` |
| Max same-fingerprint streak | Longest run of consecutive failed test runs whose output yields the same fingerprint, using dev-blackbox's own detector (`bestSoftSignal` + `fingerprintFromError`) on the text the agent actually received. Java identity hashes (`@30c1da48`) are masked first |
| Max consecutive failed runs | Same, ignoring fingerprints |
| Wall time | Wall clock around the `claude` process, including hook overhead |
| Cost | `total_cost_usd` from the `result` message (a client-side estimate) |

A test run counts as failed if the tool result is an error or the output
contains a failure marker (`BUILD FAILED`, `N tests completed, M failed`,
Vitest's `Tests  N failed`, dev-blackbox's `✗ Command failed`). The marker
check catches `./gradlew test | tail` pipelines that exit 0.

## Threats to validity

Please read these before quoting any number from this benchmark.

- **Tiny sample.** Three trials per cell. Agent runs are nondeterministic, so
  a median of three can move a lot between re-runs. Treat differences smaller
  than the spread between individual runs as noise.
- **Author-designed tasks.** The tasks were written by the dev-blackbox author
  to contain the failure patterns dev-blackbox targets. They are small (a few
  files each) and not a sample of real-world bugs.
- **The fingerprint streak depends on what the agent saw.** If an agent runs
  `./gradlew test | tail -30`, the exception is often not in its output, so
  that run gets a weaker fingerprint (for example the test-count summary) and
  the streak breaks. That undercounts repeats for whichever condition pipes
  more; "max consecutive failed runs" is reported alongside for that reason.
- **Condition C bundles several changes** (hook, `CLAUDE.md` rules, run
  summary) and also costs something: each hook denial is an extra turn.
- **Isolation is partial by default.** Without `BARE=1`, user-level settings,
  hooks, plugins and MCP servers are excluded, but `~/.claude/CLAUDE.md` is
  still loaded in both conditions. Use `BARE=1` for published numbers.
- **Expected unfavorable result on task b.** dev-blackbox 0.3.0 keeps the last
  1,000 log lines per incident. In task b the only lines that name the cause
  are near the top of a ~4,900-line log, so the recorded incident (and
  `incident show`) contains the repeated threshold exception, not the cause.
  This was confirmed locally before any agent run. The task stays in the
  benchmark because this failure mode is common.

## Known issues (dev-blackbox 0.3.0)

Found while building this benchmark; both affect condition C on Windows only:

- `dev-blackbox run -- ./gradlew test` fails on Windows: the POSIX `gradlew`
  script is handed to `cmd.exe`, which cannot run it.
- `dev-blackbox run -- gradlew.bat test` fails with `spawn EINVAL` (Node.js
  refuses to spawn `.bat` files without a shell). `run -- cmd /c .\gradlew.bat test`
  works.

`run.sh` refuses to start under Git Bash unless `ALLOW_WINDOWS=1` is set.

Also found: the incident fingerprint keeps Java identity hashes such as
`MergedContextConfiguration@30c1da48`, so repeats of one Spring context
failure are recorded as new incidents instead of raising `Occurrences`. The
analysis masks these hashes; dev-blackbox itself does not yet.

## Publishing results

`results/*.json` and `results/SUMMARY.md` are meant to be committed as they
are, including runs where condition C did worse. `results/raw/` (full
transcripts, diffs, grader logs) is git-ignored because transcripts contain
local paths; review it before publishing it.
