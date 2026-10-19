import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** How dev-blackbox is installed for a project, and therefore which command
 *  the agent (and the Claude Code hook) should use to invoke it.
 *
 *  - "local":  in the project's node_modules → `npx dev-blackbox` resolves
 *              it without a download, and the hook can call the file directly.
 *  - "global": `npm i -g dev-blackbox`, the path for non-Node projects
 *              (Gradle, Maven, Go, Python …) that have no package.json.
 *  - "npx":    run from the npx cache (`npx dev-blackbox init` without an
 *              install); keep using npx.
 *  - "source": invoke the running checkout directly; no global install needed. */
export type InstallKind = "local" | "global" | "npx" | "source";

/** dist/cli.js (or src/cli.ts under tsx) of the running copy. */
export function runningCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, "cli.js");
  return fs.existsSync(js) ? js : path.join(here, "cli.ts");
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function localInstallDir(projectDir: string): string | undefined {
  const dir = path.join(projectDir, "node_modules", "dev-blackbox");
  return fs.existsSync(path.join(dir, "package.json")) ? dir : undefined;
}

export function detectInstall(projectDir: string, cliPath = runningCliPath()): InstallKind {
  if (localInstallDir(projectDir)) return "local";
  const normalized = cliPath.split(path.sep).join("/");
  if (normalized.includes("/_npx/")) return "npx";
  if (!normalized.includes("/node_modules/")) return "source";
  if (!isInside(cliPath, projectDir)) return "global";
  return "local";
}

/** Command prefix to print in agent rules and summaries. */
export function cliCommand(kind: InstallKind, cliPath = runningCliPath()): string {
  if (kind === "source") {
    // Single quotes work in PowerShell and Bash; never interpolate shell metacharacters.
    const quote = (value: string) => "'" + value.replaceAll("'", process.platform === "win32" ? "''" : "'\"'\"'") + "'";
    const loader = pathToFileURL(path.resolve(path.dirname(cliPath), "../node_modules/tsx/dist/loader.mjs")).href;
    return `node ${cliPath.endsWith(".ts") ? `--import ${quote(loader)} ` : ""}${quote(cliPath)}`;
  }
  return kind === "global" ? "dev-blackbox" : "npx dev-blackbox";
}
