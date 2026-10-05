import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Workspace snapshots: which files differ between two failing runs.
 *
 *  A repeated incident is only useful to the agent if it can tell "I changed
 *  X and the same failure came back" apart from "I re-ran without changing
 *  anything". Each occurrence stores a compact snapshot (HEAD + the git blob
 *  id of every dirty/untracked file); comparing the previous snapshot with
 *  the current one yields the files edited in between.
 *
 *  Best effort only: outside a git repository, or when git is missing or
 *  slow, no snapshot is taken and nothing is reported. */

export interface WorkspaceSnapshot {
  head: string | null;
  /** Repo-relative path → short git blob id ("-" when the file is deleted). */
  files: Record<string, string>;
  /** True when the dirty-file list was cut at MAX_FILES. */
  truncated?: boolean;
}

const MAX_FILES = 300;
const MAX_HASH_BYTES = 20 * 1024 * 1024;
const GIT_TIMEOUT_MS = 3000;
const SHORT = 12;

function git(cwd: string, args: string[], input?: string): string | undefined {
  try {
    const r = spawnSync("git", args, {
      cwd,
      input,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) return undefined;
    return r.stdout;
  } catch {
    return undefined;
  }
}

/** Fallback when `git hash-object` fails: the raw-content blob id (no
 *  autocrlf/clean filters applied). */
function blobId(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return "-";
    if (stat.size > MAX_HASH_BYTES) return `size:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    const content = fs.readFileSync(file);
    return crypto
      .createHash("sha1")
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex")
      .slice(0, SHORT);
  } catch {
    return "-";
  }
}

function repoRoot(cwd: string): string | undefined {
  return git(cwd, ["rev-parse", "--show-toplevel"])?.trim() || undefined;
}

export function takeWorkspaceSnapshot(cwd: string): WorkspaceSnapshot | undefined {
  const top = repoRoot(cwd);
  if (!top) return undefined;
  const head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === undefined) return undefined;

  const paths: string[] = [];
  let truncated = false;
  const entries = status.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    // Renames/copies carry the original path as the next NUL-separated field.
    if (code[0] === "R" || code[0] === "C") i++;
    if (rel.startsWith(".dev-blackbox/")) continue;
    if (paths.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    paths.push(rel);
  }
  const files = hashWorkingFiles(top, paths);
  return truncated ? { head, files, truncated } : { head, files };
}

/** Blob ids as git would store the files (autocrlf and clean filters
 *  applied), so an unchanged file compares equal to its committed blob. */
function hashWorkingFiles(top: string, paths: string[]): Record<string, string> {
  const present = paths.filter((rel) => {
    try {
      const stat = fs.statSync(path.join(top, rel));
      return stat.isFile() && stat.size <= MAX_HASH_BYTES;
    } catch {
      return false;
    }
  });
  const ids =
    present.length > 0
      ? git(top, ["hash-object", "--stdin-paths"], present.join("\n") + "\n")?.trim().split(/\r?\n/)
      : [];
  const fromGit = ids && ids.length === present.length ? ids : undefined;
  const files: Record<string, string> = {};
  present.forEach((rel, i) => {
    files[rel] = fromGit ? fromGit[i]!.slice(0, SHORT) : blobId(path.join(top, rel));
  });
  for (const rel of paths) files[rel] ??= blobId(path.join(top, rel));
  return files;
}

/** Short blob ids of `paths` at `commit`; missing paths are absent. */
function blobsAt(cwd: string, commit: string | null, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!commit) return out;
  for (let i = 0; i < paths.length; i += 100) {
    const listing = git(cwd, ["ls-tree", "-z", "--full-tree", commit, "--", ...paths.slice(i, i + 100)]);
    for (const row of listing?.split("\0") ?? []) {
      // "<mode> <type> <object>\t<path>"
      const tab = row.indexOf("\t");
      if (tab === -1) continue;
      const [, type, object] = row.slice(0, tab).split(" ");
      if (type === "blob" && object) out.set(row.slice(tab + 1), object.slice(0, SHORT));
    }
  }
  return out;
}

/** Files whose content differs between two snapshots, repo-relative. A file
 *  absent from a snapshot was clean then, i.e. equal to that snapshot's HEAD. */
export function changedFiles(
  cwd: string,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): string[] {
  const candidates = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  if (before.head && after.head && before.head !== after.head) {
    const diff = git(cwd, ["diff", "--name-only", "-z", before.head, after.head]);
    for (const f of diff?.split("\0") ?? []) if (f) candidates.add(f);
  }
  const list = [...candidates].filter((f) => !f.startsWith(".dev-blackbox/"));
  const needBefore = list.filter((f) => before.files[f] === undefined);
  const needAfter = list.filter((f) => after.files[f] === undefined);
  const beforeBlobs = blobsAt(cwd, before.head, needBefore);
  const afterBlobs =
    after.head === before.head ? beforeBlobs : blobsAt(cwd, after.head, needAfter);

  const changed: string[] = [];
  for (const f of list) {
    const a = before.files[f] ?? beforeBlobs.get(f) ?? "-";
    const b = after.files[f] ?? afterBlobs.get(f) ?? "-";
    if (a !== b) changed.push(f);
  }
  return changed.sort();
}
