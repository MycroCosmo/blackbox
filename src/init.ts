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
    "- At the start of a bug-fix task, inspect existing evidence with `npx dev-blackbox incident list --format json` and `npx dev-blackbox network list --failed --format json`.",
    "- Always run build, test, and execution commands through `npx dev-blackbox run -- <command>`.",
    "- When a command fails, an Incident ID is printed. Inspect it with `npx dev-blackbox incident show <ID> --format json` instead of re-reading raw logs.",
    "- If the same error repeats, check the existing incident's occurrence history first (`npx dev-blackbox incident list --format json`) instead of re-analyzing from scratch.",
    "- After fixing an error, re-run the same command; a success marks the incident as a resolve candidate. Confirm with `npx dev-blackbox incident resolve <ID>`.",
    "- When `init --auto` wrapped the project dev script, use the normal `npm run dev`; it starts the recorder and collector together.",
    "- Node.js `fetch` calls are auto-instrumented in attached dev sessions. Browser traffic still needs the fetch/Axios interceptor from the dev-blackbox examples.",
    "- If recorded evidence is insufficient, inspect source code, raw logs, and reproduce the failure; do not guess from a report alone.",
    "- Long-running detached services can still use `npx dev-blackbox start --name <name> -- <command>` and `process list/logs/stop`.",
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
  scriptWrap?: ScriptWrapResult;
}

export interface ScriptWrapResult {
  script: string;
  originalScript: string;
  status: "wrapped" | "already_wrapped" | "skipped";
  message: string;
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
  opts: { agentFiles?: boolean; hooks?: string; auto?: boolean; script?: string } = {},
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
  if (opts.auto && !fs.existsSync(path.join(projectDir, "AGENTS.md"))) {
    fs.writeFileSync(path.join(projectDir, "AGENTS.md"), block + "\n", "utf8");
    result.detectedAgentFiles.push("AGENTS.md");
    result.updatedInstructionFiles.push("AGENTS.md");
  }
  for (const name of [".cursorrules", "AGENTS.md", ".windsurfrules"]) {
    const file = path.join(projectDir, name);
    if (!fs.existsSync(file)) continue;
    if (!result.detectedAgentFiles.includes(name)) result.detectedAgentFiles.push(name);
    if ((opts.agentFiles || opts.auto) && !result.updatedInstructionFiles.includes(name)) {
      fs.writeFileSync(file, upsertBlock(fs.readFileSync(file, "utf8"), block), "utf8");
      result.updatedInstructionFiles.push(name);
    }
  }

  // 5. Claude Code hooks (spec 3.2, 경로 2 — opt-in because it is invasive).
  if (opts.hooks === "claude-code") {
    result.hooksConfigured = setupClaudeCodeHook(projectDir);
  }

  if (opts.auto) {
    result.scriptWrap = wrapPackageScript(projectDir, opts.script ?? "dev");
  }

  return result;
}

/** Rewrites one package.json script through the attached `dev` runner while
 * preserving the original command under `<script>:original`. Never overwrites
 * an existing backup with different content. */
export function wrapPackageScript(projectDir: string, script = "dev"): ScriptWrapResult {
  if (!/^[A-Za-z0-9:_-]+$/.test(script)) {
    return { script, originalScript: `${script}:original`, status: "skipped", message: "invalid script name" };
  }
  const packageFile = path.join(projectDir, "package.json");
  let parsed: { scripts?: Record<string, unknown>; [key: string]: unknown };
  let raw: string;
  try {
    raw = fs.readFileSync(packageFile, "utf8");
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { script, originalScript: `${script}:original`, status: "skipped", message: "package.json not found or invalid" };
  }
  const scripts = (parsed.scripts ??= {});
  const originalScript = `${script}:original`;
  const wrapper = `dev-blackbox dev -- npm run ${originalScript}`;
  if (scripts[script] === wrapper && typeof scripts[originalScript] === "string") {
    return { script, originalScript, status: "already_wrapped", message: `${script} is already wrapped` };
  }
  if (typeof scripts[script] !== "string" || scripts[script].trim() === "") {
    return { script, originalScript, status: "skipped", message: `script '${script}' does not exist` };
  }
  if (originalScript in scripts) {
    return {
      script,
      originalScript,
      status: "skipped",
      message: `backup script '${originalScript}' already exists; no changes made`,
    };
  }
  scripts[originalScript] = scripts[script];
  scripts[script] = wrapper;
  const indent = /^([ \t]+)"/.exec(raw.split(/\r?\n/)[1] ?? "")?.[1] ?? "  ";
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(packageFile, JSON.stringify(parsed, null, indent) + trailingNewline, "utf8");
  return { script, originalScript, status: "wrapped", message: `${script} now starts Dev Blackbox automatically` };
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
