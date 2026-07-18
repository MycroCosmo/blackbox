/** Node.js fetch auto-instrumentation loaded through NODE_OPTIONS by
 * `dev-blackbox dev`. It intentionally captures metadata only; response
 * streams and request bodies are never consumed or altered. */

const collectorUrl = process.env.DEV_BLACKBOX_COLLECTOR_URL?.replace(/\/$/, "");
const PATCHED = Symbol.for("dev-blackbox.fetch.patched");
const state = globalThis as typeof globalThis & { [PATCHED]?: boolean };

if (collectorUrl && typeof globalThis.fetch === "function" && !state[PATCHED]) {
  state[PATCHED] = true;
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = requestUrlOf(input);
    if (requestUrl.startsWith(collectorUrl)) return originalFetch(input, init);

    const started = Date.now();
    const traceId = requestHeader(input, init, "x-dev-blackbox-trace-id") ?? randomTraceId();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = mergedHeaders(input, init);
    if (!headers.has("x-dev-blackbox-trace-id")) headers.set("x-dev-blackbox-trace-id", traceId);
    const nextInit = { ...init, headers };

    try {
      const response = await originalFetch(input, nextInit);
      void report({
        timestamp: new Date().toISOString(),
        traceId,
        source: { application: process.env.npm_package_name ?? "node" },
        request: { method, url: requestUrl, headers: Object.fromEntries(headers.entries()) },
        response: { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
        durationMs: Date.now() - started,
      });
      return response;
    } catch (error) {
      void report({
        timestamp: new Date().toISOString(),
        traceId,
        source: { application: process.env.npm_package_name ?? "node" },
        request: { method, url: requestUrl, headers: Object.fromEntries(headers.entries()) },
        durationMs: Date.now() - started,
        error: {
          type: error instanceof Error && error.name === "AbortError" ? "aborted" : "network_error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  };

  async function report(event: unknown): Promise<void> {
    try {
      await originalFetch(`${collectorUrl}/events/network`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(500),
      });
    } catch {
      /* application traffic must never fail because recording is unavailable */
    }
  }
}

function requestUrlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mergedHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function requestHeader(
  input: string | URL | Request,
  init: RequestInit | undefined,
  name: string,
): string | undefined {
  return new Headers(init?.headers).get(name) ??
    (input instanceof Request ? input.headers.get(name) ?? undefined : undefined);
}

function randomTraceId(): string {
  return `TRACE-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
