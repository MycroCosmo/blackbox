import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, defaultConfigYaml } from "./config.js";
import { BLACKBOX_DIR } from "./storage.js";

/** `dev-blackbox init` (spec 3.2): the agent adoption path.
 *  Creates .dev-blackbox/config.yml, adds the directory to .gitignore, and
 *  inserts an idempotent instruction block into CLAUDE.md (and, when opted
 *  in, other detected agent instruction files). Re-running replaces the
 *  existing block in place — never duplicates it. */

export const BLOCK_START = "<!-- dev-blackbox:start -->";
export const BLOCK_END = "<!-- dev-blackbox:end -->";

export function instructionBlock(): string {
  return [
    BLOCK_START,
    "## Dev Blackbox usage rules",
    "",
    "- Always run build, test, and execution commands through `npx dev-blackbox run -- <command>`.",
    "- When a command fails, an Incident ID is printed. Inspect it with `npx dev-blackbox incident show <ID> --format json` instead of re-reading raw logs.",
    "- If the same error repeats, check the existing incident's occurrence history first (`npx dev-blackbox incident list --format json`) instead of re-analyzing from scratch.",
    "- After fixing an error, re-run the same command; a success marks the incident as a resolve candidate. Confirm with `npx dev-blackbox incident resolve <ID>`.",
    "- Long-running dev servers: start them with `npx dev-blackbox start --name <name> -- <command>` and inspect with `npx dev-blackbox process list/logs/stop`.",
    "- To record frontend/backend HTTP traffic, run `npx dev-blackbox collect` and add a small interceptor that POSTs events to `http://127.0.0.1:4319/events/network` (see the snippets in the dev-blackbox `examples/` docs). Propagate the `X-Dev-Blackbox-Trace-Id` header to link frontend and backend events.",
    "- Never replay non-idempotent requests without explicit user confirmation.",
    BLOCK_END,
  ].join("\n");
}

export interface InitResult {
  createdDir: boolean;
  createdConfig: boolean;
  gitignoreUpdated: boolean;
  updatedInstructionFiles: string[];
  detectedAgentFiles: string[];
  hooksConfigured: boolean;
}

/** Inserts or replaces the instruction block; returns the new content. */
export function upsertBlock(content: string, block: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + block + content.slice(end + BLOCK_END.length);
  }
  const sep = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + block + "\n";
}

export function runInit(
  projectDir: string,
  opts: { agentFiles?: boolean; hooks?: string } = {},
): InitResult {
  const result: InitResult = {
    createdDir: false,
    createdConfig: false,
    gitignoreUpdated: false,
    updatedInstructionFiles: [],
    detectedAgentFiles: [],
    hooksConfigured: false,
  };

  // 1. .dev-blackbox/ + config.yml
  const root = path.join(projectDir, BLACKBOX_DIR);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
    result.createdDir = true;
  }
  const configFile = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, defaultConfigYaml(), "utf8");
    result.createdConfig = true;
  }

  // 2. .gitignore
  const gitignore = path.join(projectDir, ".gitignore");
  const existing = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  const hasEntry = existing
    .split(/\r?\n/)
    .some((l) => l.trim() === `${BLACKBOX_DIR}/` || l.trim() === BLACKBOX_DIR);
  if (!hasEntry) {
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(gitignore, `${existing}${sep}${BLACKBOX_DIR}/\n`, "utf8");
    result.gitignoreUpdated = true;
  }

  // 3. CLAUDE.md instruction block (created if missing)
  const block = instructionBlock();
  const claudeMd = path.join(projectDir, "CLAUDE.md");
  const claudeContent = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, "utf8") : "";
  fs.writeFileSync(claudeMd, upsertBlock(claudeContent, block), "utf8");
  result.updatedInstructionFiles.push("CLAUDE.md");

  // 4. Other agent instruction files — detected always, modified only on opt-in
  //    (spec: 사용자 확인 후 → CLI flag --agent-files).
  for (const name of [".cursorrules", "AGENTS.md", ".windsurfrules"]) {
    const file = path.join(projectDir, name);
    if (!fs.existsSync(file)) continue;
    result.detectedAgentFiles.push(name);
    if (opts.agentFiles) {
      fs.writeFileSync(file, upsertBlock(fs.readFileSync(file, "utf8"), block), "utf8");
      result.updatedInstructionFiles.push(name);
    }
  }

  // 5. Claude Code hooks (spec 3.2, 경로 2 — opt-in because it is invasive).
  if (opts.hooks === "claude-code") {
    result.hooksConfigured = setupClaudeCodeHook(projectDir);
  }

  return result;
}

const HOOK_COMMAND = "npx dev-blackbox claude-hook";

/** Registers a PreToolUse hook in the project's .claude/settings.json that
 *  denies unwrapped build/test Bash commands with guidance to use
 *  `dev-blackbox run`. Idempotent. Returns true when newly added. */
export function setupClaudeCodeHook(projectDir: string): boolean {
  const claudeDir = path.join(projectDir, ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch {
    /* missing or invalid → start fresh */
  }
  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  const preToolUse = (hooks.PreToolUse ??= []) as unknown[];
  if (JSON.stringify(preToolUse).includes(HOOK_COMMAND)) return false;
  preToolUse.push({
    matcher: "Bash",
    hooks: [{ type: "command", command: HOOK_COMMAND }],
  });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return true;
}
