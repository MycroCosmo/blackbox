import { cliCommand, detectInstall } from "./invocation.js";

/** Claude Code PreToolUse hook (spec 3.2, 경로 2).
 *  Registered by `dev-blackbox init --hooks claude-code`. When the agent runs
 *  a build/test command through the Bash tool without dev-blackbox, the hook
 *  rewrites that part of the command to go through `dev-blackbox run`.
 *
 *  It returns only `updatedInput` — never a permission decision — so the
 *  rewritten command still goes through the user's normal permission flow.
 *  Rewriting (rather than denying with instructions, as earlier versions did)
 *  saves the agent a wasted turn on every build and test it forgets to wrap. */

/** Matched against one pipeline stage, after leading `VAR=value` assignments. */
const WRAP_PATTERNS: RegExp[] = [
  // Long-running scripts (dev servers, watchers) are left alone: `dev` is
  // usually already attached via `init --auto`, and the rest never "fail".
  /^npm\s+(?:test|t|run(?:-script)?\s+(?!(?:dev|start|serve|watch|preview|storybook)\b)\S+)(?:\s|$)/,
  /^(?:yarn|pnpm|bun)\s+(?:test|build|lint|typecheck|run\s+(?!(?:dev|start|serve|watch|preview|storybook)\b)\S+)(?:\s|$)/,
  /^npx\s+(?:vitest|jest|tsc|playwright|mocha)\b/,
  /^(?:\.[\\/])?gradlew(?:\.bat)?\s+(?!(?:bootRun|run)\b)\S+/,
  /^gradle\s+(?!(?:bootRun|run)\b)\S+/,
  /^(?:\.[\\/])?mvnw?(?:\.cmd)?\s+(?!\S*spring-boot:run)\S+/,
  /^go\s+(?:test|build|vet|run)\b/,
  /^cargo\s+(?:test|build|check|clippy|run)\b/,
  /^(?:pytest|py\.test)\b/,
  /^python3?\s+-m\s+pytest\b/,
  /^(?:uv|poetry)\s+run\s+pytest\b/,
  /^dotnet\s+(?:test|build|run)\b/,
];

const MAKE_TARGETS = new Set(["test", "check", "build", "all", "lint"]);

/** `make`, `make -j4 test`, `make test 2>&1` — but not `make install` or
 *  `make clean`, which are not builds whose failures are worth recording. */
function isMakeBuild(stage: string): boolean {
  const tokens = stage.trim().split(/\s+/);
  if (tokens[0] !== "make") return false;
  const target = tokens
    .slice(1)
    .find((t) => !t.startsWith("-") && !t.includes("=") && !/^\d*[<>]/.test(t) && !/^\d+$/.test(t));
  return target === undefined || MAKE_TARGETS.has(target);
}

const ENV_PREFIX_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)*/;

export interface HookDecision {
  /** The full rewritten Bash command, when anything was wrapped. */
  command?: string;
}

/** Splits a shell command into top-level pieces, keeping every separator so
 *  that joining the pieces reproduces the input exactly. Separators are
 *  `&&`, `||`, `;`, `|`, `&` and newlines outside quotes. */
function splitTopLevel(command: string): { text: string; sep: string; afterPipe: boolean }[] {
  const pieces: { text: string; sep: string; afterPipe: boolean }[] = [];
  let quote: string | null = null;
  let start = 0;
  let afterPipe = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    const two = command.slice(i, i + 2);
    let sep = "";
    if (two === "&&" || two === "||") sep = two;
    else if (c === ";" || c === "\n" || c === "|" || c === "&") sep = c;
    if (!sep) continue;
    // `2>&1`, `>&2`, `&>` are redirections, not separators.
    if (c === "&" && sep === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) continue;
    pieces.push({ text: command.slice(start, i), sep, afterPipe });
    afterPipe = sep === "|";
    i += sep.length - 1;
    start = i + 1;
  }
  pieces.push({ text: command.slice(start), sep: "", afterPipe });
  return pieces;
}

function wrapPiece(text: string, cli: string): string | undefined {
  const lead = /^\s*/.exec(text)![0];
  const body = text.slice(lead.length);
  const env = ENV_PREFIX_RE.exec(body)![0];
  const rest = body.slice(env.length);
  if (rest.includes("dev-blackbox")) return undefined;
  if (/\s--watch(?:All)?\b/.test(rest)) return undefined;
  if (!WRAP_PATTERNS.some((re) => re.test(rest)) && !isMakeBuild(rest)) return undefined;
  return `${lead}${env}${cli} run -- ${rest}`;
}

/** Returns the command with every build/test stage wrapped, or undefined
 *  when nothing needs wrapping. Heredocs and command substitutions are left
 *  untouched: rewriting inside them is not worth the risk of breaking them. */
export function wrapShellCommand(command: string, cli = "npx dev-blackbox"): string | undefined {
  if (command.includes("<<") || command.includes("$(") || command.includes("`")) return undefined;
  let changed = false;
  const out = splitTopLevel(command).map((p) => {
    // Only the first stage of a pipeline produces the exit status we record
    // meaningfully; `npm test | tail` wraps `npm test`, never `tail`.
    const wrapped = p.afterPipe ? undefined : wrapPiece(p.text, cli);
    if (wrapped !== undefined) changed = true;
    return (wrapped ?? p.text) + p.sep;
  });
  return changed ? out.join("") : undefined;
}

export function decideClaudeHook(hookInput: unknown, cli = "npx dev-blackbox"): HookDecision {
  if (typeof hookInput !== "object" || hookInput === null) return {};
  const data = hookInput as { tool_name?: string; tool_input?: { command?: unknown } };
  if (data.tool_name !== "Bash") return {};
  const command = data.tool_input?.command;
  if (typeof command !== "string") return {};
  const wrapped = wrapShellCommand(command, cli);
  return wrapped === undefined ? {} : { command: wrapped };
}

/** stdin/stdout protocol entry point used by the registered hook command. */
export async function runClaudeHook(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let input: unknown;
  try {
    // Strip a UTF-8 BOM some shells prepend to piped input.
    input = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^﻿/, ""));
  } catch {
    return; // unparseable input — never block the agent
  }
  const data = input as { cwd?: unknown; tool_input?: Record<string, unknown> };
  const projectDir =
    process.env.CLAUDE_PROJECT_DIR || (typeof data.cwd === "string" ? data.cwd : process.cwd());
  let decision: HookDecision;
  try {
    decision = decideClaudeHook(input, cliCommand(detectInstall(projectDir)));
  } catch {
    return; // a hook bug must never block the agent
  }
  if (decision.command === undefined) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...data.tool_input, command: decision.command },
      },
    }) + "\n",
  );
}
