import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** How dev-blackbox is installed for a project, and therefore which command
 *  the agent (and the Claude Code hook) should use to invoke it.
 *
 *  - "local":  in the project's node_modules → `npx dev-blackbox` resolves
 *              it without a download, and the hook can call the file directly.
 *  - "global": `npm i -g dev-blackbox`, the path for non-Node projects
 *              (Gradle, Maven, Go, Python …) that have no package.json.
 *  - "npx":    run from the npx cache (`npx dev-blackbox init` without an
 *              install); keep using npx. */
export type InstallKind = "local" | "global" | "npx";

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
  // A development checkout (tsx src/cli.ts, or a linked dist/) behaves like a
  // global install unless the project depends on it locally.
  if (!normalized.includes("/node_modules/") || !isInside(cliPath, projectDir)) return "global";
  return "local";
}

/** Command prefix to print in agent rules and summaries. */
export function cliCommand(kind: InstallKind): string {
  return kind === "global" ? "dev-blackbox" : "npx dev-blackbox";
}
