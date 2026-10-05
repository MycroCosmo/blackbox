import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, defaultConfigYaml } from "./config.js";
import { cliCommand, detectInstall, type InstallKind } from "./invocation.js";
import { BLACKBOX_DIR } from "./storage.js";

/** `dev-blackbox init` (spec 3.2): the agent adoption path.
 *  Creates .dev-blackbox/config.yml, adds the directory to .gitignore, and
 *  inserts an idempotent instruction block into CLAUDE.md (and, when opted
 *  in, other detected agent instruction files). Re-running replaces the
 *  existing block in place — never duplicates it. */

export const BLOCK_START = "<!-- dev-blackbox:start -->";
export const BLOCK_END = "<!-- dev-blackbox:end -->";

/** `cli` is how the agent invokes dev-blackbox in this project:
 *  `npx dev-blackbox` for a local install, `dev-blackbox` for a global one. */
export function instructionBlock(cli = "npx dev-blackbox"): string {
  return [
    BLOCK_START,
    "## Dev Blackbox usage rules",
    "",
    `- Run build, test, and execution commands through \`${cli} run -- <command>\`.`,
    "- When a command fails, read the summary printed at the end of its output before anything else. `Error`/`At` locate the failure at the end of the log; `Earliest cause` is the deepest cause of the first exception printed, even when it scrolled far above the end. It is usually, but not always, the real cause.",
    "- `Occurrences: N ... this failure happened before` means your previous fix did not work. The indented lines list the files you changed between failing runs; do not repeat an approach that already failed, and re-check your assumptions about the cause.",
    `- For the full record, use \`${cli} incident show <ID> --format json\` instead of re-running the command or re-reading raw logs.`,
    `- At the start of a bug-fix task, check existing evidence: \`${cli} incident list --format json\` (and \`${cli} network list --failed --format json\` for HTTP failures).`,
    `- After a fix, re-run the same command; a success marks the incident as a resolve candidate. Confirm with \`${cli} incident resolve <ID>\`.`,
    "- When `init --auto` wrapped the project dev script, use the normal `npm run dev`; it starts the recorder and collector together.",
    "- If recorded evidence is insufficient, inspect source code and reproduce the failure; do not guess from a report alone.",
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
  /** How dev-blackbox was found; decides the command written into the rules. */
  install: InstallKind;
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
  opts: {
    agentFiles?: boolean;
    hooks?: string;
    auto?: boolean;
    script?: string;
    /** Overrides install detection (tests, unusual layouts). */
    install?: InstallKind;
  } = {},
): InitResult {
  const install = opts.install ?? detectInstall(projectDir);
  const result: InitResult = {
    createdDir: false,
    createdConfig: false,
    gitignoreUpdated: false,
    updatedInstructionFiles: [],
    detectedAgentFiles: [],
    hooksConfigured: false,
    install,
  };

  // 0. Pre-flight. Hook registration is the only step that can reject the
  //    project outright, and it runs last — so validate it before the first
  //    write, or a bad settings.json leaves init half-applied.
  if (opts.hooks === "claude-code") {
    readClaudeSettings(path.join(projectDir, ".claude", "settings.json"));
  }

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
  const block = instructionBlock(cliCommand(install));
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
    result.hooksConfigured = setupClaudeCodeHook(projectDir, install);
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
  const localBinary = path.join(projectDir, "node_modules", ".bin", "dev-blackbox");
  const installedLocally = [localBinary, `${localBinary}.cmd`, `${localBinary}.ps1`].some(
    (candidate) => fs.existsSync(candidate),
  );
  if (!installedLocally) {
    return {
      script,
      originalScript,
      status: "skipped",
      message: "dev-blackbox is not installed locally; run `npm install -D dev-blackbox` and retry",
    };
  }
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

/** The hook runs before EVERY Bash call, so avoid npx's startup cost when
 *  the package is installed: call the local file directly (Claude Code
 *  substitutes ${CLAUDE_PROJECT_DIR}), or the global binary. */
export function hookCommand(install: InstallKind): string {
  if (install === "local")
    return 'node "${CLAUDE_PROJECT_DIR}/node_modules/dev-blackbox/dist/cli.js" claude-hook';
  if (install === "global") return "dev-blackbox claude-hook";
  return "npx -y dev-blackbox claude-hook";
}

/** Matches any command this package ever registered, across versions. */
function isOurHook(command: unknown): boolean {
  return typeof command === "string" && /dev-blackbox\b.*\bclaude-hook\b/.test(command);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads .claude/settings.json, rejecting any shape this hook cannot safely
 *  extend. Validation covers the nested `hooks` / `hooks.PreToolUse` slots too:
 *  writing into a non-object `hooks` or pushing onto a non-array `PreToolUse`
 *  would otherwise fail deep inside with an opaque TypeError. */
export function readClaudeSettings(settingsFile: string): Record<string, unknown> {
  if (!fs.existsSync(settingsFile)) return {};
  const reject = (detail: string): never => {
    throw new Error(`cannot update invalid Claude settings at ${settingsFile}: ${detail}`);
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch (error) {
    return reject(error instanceof Error ? error.message : String(error));
  }
  if (!isPlainObject(parsed)) reject("top-level value must be an object");
  const settings = parsed as Record<string, unknown>;

  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    reject("'hooks' must be an object");
  }
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (hooks?.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse)) {
    reject("'hooks.PreToolUse' must be an array");
  }
  return settings;
}

/** Registers a PreToolUse hook in the project's .claude/settings.json that
 *  routes unwrapped build/test Bash commands through `dev-blackbox run`.
 *  Idempotent; an entry from an earlier version (or install kind) is updated
 *  in place. Returns true when the settings file changed. */
export function setupClaudeCodeHook(
  projectDir: string,
  install: InstallKind = detectInstall(projectDir),
): boolean {
  const claudeDir = path.join(projectDir, ".claude");
  const settingsFile = path.join(claudeDir, "settings.json");
  const settings = readClaudeSettings(settingsFile);
  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  const preToolUse = (hooks.PreToolUse ??= []) as unknown[];
  const command = hookCommand(install);
  const ours = preToolUse
    .flatMap((group) =>
      isPlainObject(group) && Array.isArray(group.hooks) ? (group.hooks as unknown[]) : [],
    )
    .filter((h): h is Record<string, unknown> => isPlainObject(h) && isOurHook(h.command));
  if (ours.length > 0) {
    if (ours.every((h) => h.command === command)) return false;
    for (const h of ours) h.command = command;
  } else {
    preToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command }],
    });
  }
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return true;
}
