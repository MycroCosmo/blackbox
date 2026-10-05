import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkout } from "./services/checkout-service.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT ?? 4173);

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function reportBackendFailure(traceId, body) {
  fetch("http://127.0.0.1:4319/events/network", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      traceId,
      source: { application: "checkout-api", action: "reserve-inventory" },
      request: { method: "POST", url: "/api/checkout", body },
      response: { status: 500, body: { code: "CHECKOUT_FAILED" } },
    }),
  }).catch(() => {});
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") return json(res, 200, { ok: true });
  if (req.method === "POST" && req.url === "/api/checkout") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    try {
      return json(res, 201, await checkout(body));
    } catch (error) {
      console.error(error);
      reportBackendFailure(req.headers["x-dev-blackbox-trace-id"], body);
      return json(res, 500, { code: "CHECKOUT_FAILED", message: "Unable to reserve inventory" });
    }
  }

  const requested = req.url === "/" ? "index.html" : req.url?.slice(1);
  const file = path.join(root, "public", requested ?? "index.html");
  if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file)) {
    return json(res, 404, { code: "NOT_FOUND" });
  }
  res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html" });
  fs.createReadStream(file).pipe(res);
});

server.listen(port, "127.0.0.1", () => console.log(`checkout app listening on ${port}`));
