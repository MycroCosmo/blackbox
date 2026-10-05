# r/ClaudeAI draft

Do not post until the GIF exists and every `<!-- BENCH -->` placeholder has a
real number (or the sentence around it is removed). Check the subreddit's
self-promotion rules and pick the matching flair (for example "Built with
Claude" or "Productivity") before posting.

## Title

> I built a hook that stops Claude Code from re-fixing the same failing test (open source, local-only)

Alternative:

> Claude Code kept patching the same NPE, so I gave it a memory of failed runs

## Body

<!-- DEMO_GIF: upload the GIF so it is the first thing in the post -->

The GIF: Claude Code hits a NullPointerException, adds a null check, and the
test fails the same way. The run summary says `Occurrences: 2`. It stops
patching the stack-trace line, looks at the mapper, and fixes the actual cause
(a DTO field that `BeanUtils.copyProperties` silently skips).

**What it is:** dev-blackbox, an npm CLI (MIT). Setup:

```bash
npm i -D dev-blackbox
npx dev-blackbox init --hooks claude-code
```

That adds:

- a `PreToolUse` hook that denies bare `npm test` / `./gradlew test` / `pytest`
  / etc. and tells Claude to run them as `npx dev-blackbox run -- <command>`;
- rules in `CLAUDE.md` telling it to check `incident list` before re-analyzing
  a repeated error.

`run` passes output and exit codes through unchanged. When a command fails, it
fingerprints the error (type + normalized message + top app frame, no line
numbers), merges repeats, and prints a short summary with an occurrence count.
Incidents persist in `.dev-blackbox/`, so a new session can see what already
failed.

**Numbers:** I ran a small A/B benchmark with headless `claude -p` (3 tasks ×
with/without × 3 runs). <!-- BENCH -->

It's small (n = 3), I wrote the tasks myself, and one task is designed as a
case where 0.3.0 does *not* help (the cause is printed at the top of a
~4,900-line log, and dev-blackbox keeps the last 1,000 lines). All runs,
including the bad ones, plus the harness to reproduce it:
https://github.com/MycroCosmo/blackbox/tree/main/bench

**Privacy:** local-only, no telemetry. Secrets (tokens, auth headers, cookies,
private keys) are masked before anything is written.

**Known issue:** on Windows, `run -- ./gradlew` doesn't work in 0.3.0 yet.

Repo: https://github.com/MycroCosmo/blackbox

Happy to hear where your Claude Code sessions loop the most. That's what I'd
like to cover next.
