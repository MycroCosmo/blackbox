import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import type { BlackboxConfig } from "./config.js";
import type { Storage } from "./storage.js";
import { cliCommand, detectInstall } from "./invocation.js";

export async function diagnose(storage: Storage, config: BlackboxConfig) {
  let writable = false;
  const probe = path.join(storage.root, `.doctor-${process.pid}`);
  try { storage.ensureDirs(); fs.writeFileSync(probe, "", { flag: "wx" }); writable = true; }
  catch { /* reported below */ }
  finally { if (writable) fs.unlinkSync(probe); }
  const port = storage.readCollectorLock()?.port ?? config.collector.port;
  let collector: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json() as { sessionId?: string };
    collector = response.ok && health.sessionId ? health : { ok: false, error: "another service answers this port" };
  } catch { collector = { ok: false, error: `collector unavailable; run ${cliCommand(detectInstall(path.dirname(storage.root)))} collect` }; }
  const portAvailable = await new Promise<boolean>(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
  const javaBin = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "java";
  const java = spawnSync(javaBin, ["-version"], { encoding: "utf8", timeout: 2000, windowsHide: true });
  // Windows Maven is a .cmd launcher; only this fixed command is passed to the shell.
  const maven = spawnSync("mvn", ["-version"], { encoding: "utf8", timeout: 5000, windowsHide: true, shell: process.platform === "win32" });
  return { root: storage.root, writable, node: process.version, nodeSupported: Number(process.versions.node.split(".")[0]) >= 20,
    java: java.status === 0 ? (java.stderr || java.stdout).split("\n")[0] : "not found: set JAVA_HOME (optional for Node)",
    maven: maven.status === 0 ? maven.stdout.split("\n")[0] : "not found: install Maven or use your project's Maven wrapper (required to build the Spring example)",
    port, portAvailable, collector, totalBytes: storage.totalSizeBytes(), maxBytes: config.storage.maxTotalSizeMB * 1024 * 1024 };
}
