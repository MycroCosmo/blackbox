import fs from "node:fs";
import { recordFailure, Storage } from "../../src/index.js";

const [root, barrier, workerId, command] = process.argv.slice(2);
if (!root || !barrier || !workerId || !command) {
  throw new Error("root, barrier, workerId and command are required");
}

fs.writeFileSync(`${barrier}.${workerId}.ready`, "ready", "utf8");
while (!fs.existsSync(barrier)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const storage = new Storage(root);
const t0 = Date.now();
const incident = recordFailure(storage, {
  command,
  cwd: root,
  exitCode: 1,
  signal: null,
  timedOut: false,
  logText: `failure from ${workerId}`,
});
fs.appendFileSync(
  `${root}/trace.log`,
  `W${workerId} ${command} -> ${incident.incidentId}#${incident.occurrenceCount} waited=${Date.now() - t0}ms\n`,
  "utf8",
);
