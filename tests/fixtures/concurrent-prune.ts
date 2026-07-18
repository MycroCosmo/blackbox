import fs from "node:fs";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { prune } from "../../src/retention.js";
import { Storage } from "../../src/storage.js";

const [root, barrier, workerId] = process.argv.slice(2);
if (!root || !barrier || !workerId) process.exit(2);

fs.writeFileSync(`${barrier}.${workerId}.ready`, "ready", "utf8");
while (!fs.existsSync(barrier)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
prune(new Storage(root), DEFAULT_CONFIG);
