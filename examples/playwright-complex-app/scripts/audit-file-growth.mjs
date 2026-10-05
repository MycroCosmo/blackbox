import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, Storage, runCommand } from "dev-blackbox";

const runs = Number(process.argv[2] ?? 105);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-blackbox-growth-"));
const storage = new Storage(path.join(root, ".dev-blackbox"));

try {
  for (let i = 0; i < runs; i++) {
    await runCommand(
      [process.execPath, "-e", "console.error('TypeError: repeatable checkout failure'); process.exit(1)"],
      { cwd: root, config: DEFAULT_CONFIG, storage, quiet: true },
    );
  }
  const count = (directory) => fs.existsSync(directory) ? fs.readdirSync(directory).length : 0;
  const [incident] = storage.readIncidents();
  const result = {
    runs,
    incidents: storage.readIncidents().length,
    occurrences: incident?.occurrenceCount,
    sessionFiles: count(storage.sessionsDir),
    logBlobFiles: count(storage.blobsDir),
    incidentReportFiles: count(storage.reportsDir),
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    result.incidents !== 1 ||
    result.occurrences !== runs ||
    result.sessionFiles > DEFAULT_CONFIG.storage.maxSessionFiles ||
    result.logBlobFiles !== 1 ||
    result.incidentReportFiles !== 1
  ) {
    throw new Error("file-growth limits regressed");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
