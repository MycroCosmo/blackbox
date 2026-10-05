const fs = require("node:fs");
const { spawn } = require("node:child_process");

const [mode, marker] = process.argv.slice(2);
if (!marker) throw new Error("marker path is required");

if (mode === "child") {
  setTimeout(() => {
    fs.writeFileSync(marker, "descendant survived", "utf8");
  }, 1_000);
} else {
  spawn(process.execPath, [__filename, "child", marker], { stdio: "inherit" });
  setInterval(() => {}, 1_000);
}
