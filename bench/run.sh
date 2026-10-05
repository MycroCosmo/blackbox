#!/usr/bin/env bash
# dev-blackbox benchmark runner.
#
# Runs every task x condition x trial as one headless Claude Code session:
#   A = the task project as-is (no dev-blackbox)
#   C = the same project + dev-blackbox 0.3.0 from this checkout
#       (`npm i -D <packed tarball>` + `dev-blackbox init --hooks claude-code`)
#
# COSTS MONEY: each trial is a full `claude -p` session. The defaults run
# 3 tasks x 2 conditions x 3 trials = 18 sessions, each capped by
# MAX_BUDGET_USD. Finished trials are skipped on re-run (FORCE=1 to redo).
#
# Environment knobs:
#   TASKS            space-separated task ids   (default: all three)
#   CONDITIONS       "A C"
#   TRIALS           3
#   MODEL            passed to --model when set (default: CLI default; pin it for comparable runs)
#   MAX_BUDGET_USD   per-session cap via --max-budget-usd (default 5)
#   RUN_TIMEOUT_SEC  wall-clock cap per session (default 1800)
#   BARE             1 = use --bare for strict isolation (needs ANTHROPIC_API_KEY)
#   KEEP_WORKSPACES  1 = keep trial workspaces for inspection
#   WORK_ROOT        where trial workspaces go (default: a fresh temp dir)
#   C_INIT_ARGS      extra args for `dev-blackbox init` in condition C
#   ALLOW_WINDOWS    1 = run on Git Bash anyway (see bench/README.md)
#   FORCE            1 = re-run trials that already have a result file
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$BENCH_DIR/.." && pwd)"
RESULTS_DIR="$BENCH_DIR/results"
RAW_DIR="$RESULTS_DIR/raw"

TASKS="${TASKS:-a-npe-dto-mapping b-gradle-noisy-log c-vitest-shared-state}"
CONDITIONS="${CONDITIONS:-A C}"
TRIALS="${TRIALS:-3}"
MODEL="${MODEL:-}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-5}"
RUN_TIMEOUT_SEC="${RUN_TIMEOUT_SEC:-1800}"
BARE="${BARE:-0}"
KEEP_WORKSPACES="${KEEP_WORKSPACES:-0}"
C_INIT_ARGS="${C_INIT_ARGS:-}"
ALLOW_WINDOWS="${ALLOW_WINDOWS:-0}"
FORCE="${FORCE:-0}"

log() { printf '[bench] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# ------------------------------------------------------------------ preflight
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    if [[ "$ALLOW_WINDOWS" != 1 ]]; then
      die "Git Bash on Windows detected. dev-blackbox 0.3.0 cannot run './gradlew' or '*.bat' through 'run' on Windows,
       so condition C would be measured with a broken wrapper. Run on macOS, Linux, or WSL,
       or set ALLOW_WINDOWS=1 to proceed anyway."
    fi
    ;;
esac

for bin in claude node npm git; do
  command -v "$bin" >/dev/null || die "'$bin' not found on PATH"
done
if [[ "$TASKS" == *a-npe-dto-mapping* || "$TASKS" == *b-gradle-noisy-log* ]]; then
  command -v java >/dev/null || [[ -n "${JAVA_HOME:-}" ]] || die "the Spring Boot tasks need a JDK 17+ (java on PATH or JAVA_HOME)"
fi
if [[ "$BARE" == 1 && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  die "BARE=1 uses --bare, which only authenticates with ANTHROPIC_API_KEY"
fi
for task in $TASKS; do
  [[ -d "$BENCH_DIR/tasks/$task/project" ]] || die "unknown task: $task"
done

WORK_ROOT="${WORK_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/dev-blackbox-bench.XXXXXX")}"
mkdir -p "$WORK_ROOT" "$RESULTS_DIR" "$RAW_DIR"

log "claude: $(claude --version)"
log "workspaces: $WORK_ROOT"

# Build once: dist/ is used by the analyzer, the tarball by condition C.
log "building and packing dev-blackbox from $REPO_DIR"
(cd "$REPO_DIR" && npm run build --silent >/dev/null)
TARBALL_NAME="$(cd "$REPO_DIR" && npm pack --silent --pack-destination "$WORK_ROOT" | tail -n 1)"
TARBALL="$WORK_ROOT/$TARBALL_NAME"
[[ -f "$TARBALL" ]] || die "npm pack did not produce $TARBALL"
DBB_VERSION="$(node -p "require('$REPO_DIR/package.json').version")"
log "condition C installs $TARBALL_NAME (version $DBB_VERSION)"

# ------------------------------------------------------------------ helpers
prepare_workspace() {
  local task="$1" condition="$2" ws="$3"
  cp -R "$BENCH_DIR/tasks/$task/project" "$ws"
  rm -rf "$ws/build" "$ws/.gradle" "$ws/node_modules"
  (
    cd "$ws"
    # Dependency downloads and the first compile are not part of the measurement.
    if [[ -f package.json ]]; then
      npm ci --no-audit --no-fund --loglevel=error >/dev/null
    fi
    if [[ -f gradlew ]]; then
      chmod +x gradlew
      ./gradlew --quiet testClasses >/dev/null
    fi
    if [[ "$condition" == C ]]; then
      if [[ ! -f package.json ]]; then
        printf '{\n  "name": "bench-workspace",\n  "private": true\n}\n' > package.json
        printf 'node_modules/\n' >> .gitignore
      fi
      npm install --no-audit --no-fund --loglevel=error --save-dev "$TARBALL" >/dev/null
      # shellcheck disable=SC2086
      ./node_modules/.bin/dev-blackbox init --hooks claude-code $C_INIT_ARGS >/dev/null
    fi
    git init -q
    git add -A
    git -c user.name=bench -c user.email=bench@localhost commit -qm "task baseline"
  )
}

claude_args() {
  local condition="$1" ws="$2" prompt="$3"
  ARGS=(
    -p "$prompt"
    --output-format stream-json
    --verbose
    --permission-mode dontAsk
    --allowedTools "Bash,Read,Edit,Write,Glob,Grep"
    --max-budget-usd "$MAX_BUDGET_USD"
    --no-session-persistence
    --strict-mcp-config
  )
  [[ -n "$MODEL" ]] && ARGS+=(--model "$MODEL")
  if [[ "$BARE" == 1 ]]; then
    # --bare skips CLAUDE.md discovery and project settings, so condition C
    # passes exactly what `dev-blackbox init` wrote.
    ARGS+=(--bare)
    if [[ "$condition" == C ]]; then
      ARGS+=(--settings "$ws/.claude/settings.json" --append-system-prompt "$(cat "$ws/CLAUDE.md")")
    fi
  else
    # Project settings (where the dev-blackbox hook lives) load; user-level
    # settings, hooks, and plugins do not. ~/.claude/CLAUDE.md still loads.
    ARGS+=(--setting-sources project,local)
  fi
}

run_trial() {
  local task="$1" condition="$2" trial="$3"
  local id="${task}__${condition}__${trial}"
  local out="$RESULTS_DIR/$id.json"
  local raw="$RAW_DIR/$id"
  if [[ -f "$out" && "$FORCE" != 1 ]]; then
    log "skip $id (result exists)"
    return
  fi
  rm -rf "$raw"
  mkdir -p "$raw"

  local ws="$WORK_ROOT/$id"
  rm -rf "$ws"
  log "prepare $id"
  prepare_workspace "$task" "$condition" "$ws"

  local prompt
  prompt="$(cat "$BENCH_DIR/tasks/$task/TASK.md")"
  claude_args "$condition" "$ws" "$prompt"

  log "run $id"
  local start end claude_exit verify_exit
  start="$(now_ms)"
  set +e
  (cd "$ws" && timeout "$RUN_TIMEOUT_SEC" claude "${ARGS[@]}" </dev/null >"$raw/transcript.jsonl" 2>"$raw/claude.stderr.log")
  claude_exit=$?
  set -e
  end="$(now_ms)"

  (cd "$ws" && git add -A && git diff --cached HEAD) >"$raw/diff.patch" 2>/dev/null || true

  set +e
  bash "$BENCH_DIR/tasks/$task/verify.sh" "$ws" >"$raw/verify.log" 2>&1
  verify_exit=$?
  set -e

  node "$BENCH_DIR/lib/analyze.mjs" \
    --transcript "$raw/transcript.jsonl" \
    --task "$task" --condition "$condition" --trial "$trial" \
    --verify-exit "$verify_exit" --claude-exit "$claude_exit" \
    --wall-ms "$((end - start))" \
    --dev-blackbox-version "$([[ "$condition" == C ]] && echo "$DBB_VERSION")" \
    --bare "$BARE" >"$out"

  log "done $id: claude exit $claude_exit, verify exit $verify_exit"
  if [[ "$KEEP_WORKSPACES" != 1 ]]; then
    rm -rf "$ws" 2>/dev/null || log "could not remove $ws (a Gradle daemon may still hold files)"
  fi
}

# ------------------------------------------------------------------ main
# Trials are the outer loop so A and C runs interleave over time instead of
# all A runs happening first (API latency and load drift during a session).
for trial in $(seq 1 "$TRIALS"); do
  for task in $TASKS; do
    for condition in $CONDITIONS; do
      case "$condition" in A | C) ;; *) die "unknown condition: $condition" ;; esac
      run_trial "$task" "$condition" "$trial"
    done
  done
done

log "all trials finished; summarize with: node bench/summarize.mjs"
