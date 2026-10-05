# Show HN draft

Do not post until the benchmark has been run and every `<!-- BENCH -->`
placeholder has a real number (or the sentence around it is removed).

## Title (≤ 80 characters)

Primary (68):

> Show HN: Dev-blackbox, a local failure recorder for AI coding agents

Alternatives:

> Show HN: Dev-blackbox – remembers test failures so coding agents stop looping (77)

## URL

https://github.com/MycroCosmo/blackbox

## Text

I kept watching coding agents do the same thing: a test fails, the agent patches
the line in the stack trace, the test fails the same way, it patches a nearby
line, and so on. Each run looks new to the agent. Build output is long, so it
pipes through `tail` and often cuts off the useful part. And when the session
ends, whatever it had worked out is gone.

dev-blackbox is a small npm CLI that sits between the agent and your build/test
commands. `npx dev-blackbox run -- ./gradlew test` streams the output unchanged
and keeps the exit code. On failure it:

- extracts the error type, message, and top application stack frame;
- fingerprints them (volatile values and line numbers removed) and merges
  repeats into one incident with an occurrence count;
- appends a short summary (`Incident`, `Occurrences: 2`, and the command to
  get details) to stderr;
- stores the last 1,000 log lines, redacted and compressed, in `.dev-blackbox/`
  so the next session can query them as JSON.

For Claude Code there is an optional PreToolUse hook that denies unwrapped
build/test commands and tells the agent to re-run them through dev-blackbox.
Other agents get the same rules through AGENTS.md / .cursorrules, and there is
an MCP server. Everything stays local: no telemetry, and the optional network
collector binds to 127.0.0.1.

Benchmark. I didn't want to post "it feels better," so the repo has a small A/B
harness in bench/. Three tasks, each built so the surface error differs from
the cause: an NPE whose cause is a missing DTO mapping (Spring Boot), a Spring
config error printed once at the top of ~4,900 lines of Gradle output, and a
Vitest failure caused by shared mutable defaults that only shows when tests run
together. Each runs as a headless `claude -p` session, without dev-blackbox (A)
and with the 0.3.0 hook (C), 3 times each. A grader restores the original tests
and adds a hidden one that rejects surface fixes. I record input tokens, test
runs, the longest streak of consecutive failures with the same fingerprint,
wall time, and pass/fail.

Results: <!-- BENCH -->

Limits, plainly:

- n = 3 per cell. That is enough to see large effects and not much else.
- I wrote the tasks, knowing what the tool does. They are small and not a
  sample of real bugs.
- Condition C changes several things at once (hook, rules file, summary), and
  hook denials cost the agent an extra turn.
- The Gradle-log task is a case where dev-blackbox 0.3.0 does not help by
  design: it keeps the last 1,000 lines, and the cause is near the top. I kept
  it in and report it as-is.
- The same-fingerprint streak is computed from what the agent saw, so an agent
  that pipes through `tail` can hide a repeat. I also report consecutive
  failures without fingerprints.
- Known bug: on Windows, `run -- ./gradlew` and `run -- gradlew.bat` don't work
  in 0.3.0. The benchmark refuses to run on Git Bash for that reason.

Every run, including the ones where C does worse, is in bench/results/, and
`bash bench/run.sh` reproduces it with your own model and budget.

I'd especially like to hear from people running agents on JVM or large
monorepo builds: which failures does your agent loop on, and is an occurrence
count the right signal, or does it need something stronger?
