# fetch wrapper (browser / Node)

```ts
const BLACKBOX = "http://127.0.0.1:4319/events/network";

function newTraceId(): string {
  return "TRACE-" + Math.random().toString(36).slice(2, 10);
}

function report(event: unknown): void {
  // Fire-and-forget: recording must never break the app.
  try {
    fetch(BLACKBOX, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

export async function bbFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const traceId = newTraceId();
  const started = performance.now();
  const headers = { ...(init.headers as Record<string, string>), "X-Dev-Blackbox-Trace-Id": traceId };
  const base = {
    traceId,
    source: { application: "frontend", page: location.pathname },
    request: { method: init.method ?? "GET", url: input, body: safeJson(init.body) },
  };
  try {
    const res = await fetch(input, { ...init, headers });
    const clone = res.clone();
    const body = await clone.text().catch(() => undefined);
    report({
      ...base,
      response: { status: res.status, body: tryParse(body) },
      durationMs: Math.round(performance.now() - started),
    });
    return res;
  } catch (e) {
    report({
      ...base,
      durationMs: Math.round(performance.now() - started),
      error: { type: "network_error", message: String(e) },
    });
    throw e;
  }
}

function safeJson(b: unknown) {
  if (typeof b !== "string") return undefined;
  return tryParse(b);
}
function tryParse(s: string | undefined) {
  if (s == null) return undefined;
  try { return JSON.parse(s); } catch { return s; }
}
```
