/** Claude Code PreToolUse hook (spec 3.2, 경로 2).
 *  Registered by `dev-blackbox init --hooks claude-code`. When the agent
 *  tries to run a build/test command directly through the Bash tool, the
 *  hook denies it with guidance to go through `dev-blackbox run` instead.
 *  Deliberately deny-with-reason rather than silent rewriting — the agent
 *  stays in control of the exact command it runs. */

const WRAP_PATTERNS: RegExp[] = [
  /^\s*npm\s+(test|run\s+\S+)/,
  /^\s*npx\s+(vitest|jest|tsc|playwright|mocha)\b/,
  /^\s*(yarn|pnpm|bun)\s+(test|run\s+\S+)/,
  /^\s*\.?\/?gradlew(\.bat)?\s+\S+/,
  /^\s*(mvn|mvnw)\s+\S+/,
  /^\s*go\s+(test|build|run)\b/,
  /^\s*cargo\s+(test|build|run|check)\b/,
  /^\s*(pytest|python\s+-m\s+pytest)\b/,
  /^\s*dotnet\s+(test|build|run)\b/,
  /^\s*make\b/,
];

export interface HookDecision {
  deny: boolean;
  reason?: string;
}

export function decideClaudeHook(hookInput: unknown): HookDecision {
  if (typeof hookInput !== "object" || hookInput === null) return { deny: false };
  const data = hookInput as { tool_name?: string; tool_input?: { command?: string } };
  if (data.tool_name !== "Bash") return { deny: false };
  const command = data.tool_input?.command;
  if (typeof command !== "string") return { deny: false };
  if (command.includes("dev-blackbox")) return { deny: false }; // already wrapped
  if (!WRAP_PATTERNS.some((re) => re.test(command))) return { deny: false };
  return {
    deny: true,
    reason:
      "Dev Blackbox: run build/test commands through the blackbox so failures are " +
      `recorded as queryable incidents. Re-run as: npx dev-blackbox run -- ${command}`,
  };
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
  const decision = decideClaudeHook(input);
  if (decision.deny) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason,
        },
      }) + "\n",
    );
  }
}
