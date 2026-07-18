# Axios interceptors

```ts
import axios from "axios";

const BLACKBOX = "http://127.0.0.1:4319/events/network";
const bb = axios.create(); // separate instance so reporting is never intercepted

function report(event: unknown): void {
  bb.post(BLACKBOX, event).catch(() => {}); // fire-and-forget
}

axios.interceptors.request.use((config) => {
  const traceId = "TRACE-" + Math.random().toString(36).slice(2, 10);
  config.headers["X-Dev-Blackbox-Trace-Id"] = traceId;
  (config as any).__bb = { traceId, started: Date.now() };
  return config;
});

axios.interceptors.response.use(
  (res) => {
    const meta = (res.config as any).__bb ?? {};
    report({
      traceId: meta.traceId,
      source: { application: "frontend" },
      request: { method: res.config.method?.toUpperCase(), url: res.config.url, body: res.config.data },
      response: { status: res.status, body: res.data },
      durationMs: Date.now() - (meta.started ?? Date.now()),
    });
    return res;
  },
  (error) => {
    const cfg = error.config ?? {};
    const meta = cfg.__bb ?? {};
    report({
      traceId: meta.traceId,
      source: { application: "frontend" },
      request: { method: cfg.method?.toUpperCase(), url: cfg.url, body: cfg.data },
      response: error.response ? { status: error.response.status, body: error.response.data } : undefined,
      durationMs: Date.now() - (meta.started ?? Date.now()),
      error: error.response ? undefined : { type: error.code === "ECONNABORTED" ? "timeout" : "network_error", message: error.message },
    });
    return Promise.reject(error);
  },
);
```
