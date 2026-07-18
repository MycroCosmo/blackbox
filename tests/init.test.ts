import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCK_END, BLOCK_START, runInit, upsertBlock } from "../src/init.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbb-init-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runInit", () => {
  it("creates .dev-blackbox, config.yml, .gitignore entry and CLAUDE.md block", () => {
    const result = runInit(dir);
    expect(result.createdDir).toBe(true);
    expect(result.createdConfig).toBe(true);
    expect(result.gitignoreUpdated).toBe(true);
    expect(fs.existsSync(path.join(dir, ".dev-blackbox", "config.yml"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(".dev-blackbox/");
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain(BLOCK_START);
    expect(claude).toContain("npx dev-blackbox run --");
  });

  it("is idempotent: re-running never duplicates the block (spec 15)", () => {
    runInit(dir);
    runInit(dir);
    runInit(dir);
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude.split(BLOCK_START)).toHaveLength(2);
    expect(claude.split(BLOCK_END)).toHaveLength(2);
    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    expect(gitignore.match(/\.dev-blackbox/g)).toHaveLength(1);
  });

  it("preserves existing CLAUDE.md content around the block", () => {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# My project\n\nSome rules.\n", "utf8");
    runInit(dir);
    const claude = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("# My project");
    expect(claude).toContain("Some rules.");
    expect(claude.indexOf(BLOCK_START)).toBeGreaterThan(claude.indexOf("Some rules."));
  });

  it("does not overwrite an existing config.yml", () => {
    runInit(dir);
    const cfg = path.join(dir, ".dev-blackbox", "config.yml");
    fs.writeFileSync(cfg, "reportLanguage: ko\n", "utf8");
    const result = runInit(dir);
    expect(result.createdConfig).toBe(false);
    expect(fs.readFileSync(cfg, "utf8")).toBe("reportLanguage: ko\n");
  });

  it("only touches detected agent files when opted in", () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agents\n", "utf8");
    const withoutOptIn = runInit(dir);
    expect(withoutOptIn.detectedAgentFiles).toEqual(["AGENTS.md"]);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).not.toContain(BLOCK_START);

    const withOptIn = runInit(dir, { agentFiles: true });
    expect(withOptIn.updatedInstructionFiles).toContain("AGENTS.md");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain(BLOCK_START);
  });
});

describe("upsertBlock", () => {
  it("replaces an existing block in place", () => {
    const oldDoc = `before\n${BLOCK_START}\nold content\n${BLOCK_END}\nafter`;
    const out = upsertBlock(oldDoc, `${BLOCK_START}\nnew content\n${BLOCK_END}`);
    expect(out).toContain("new content");
    expect(out).not.toContain("old content");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });
});
