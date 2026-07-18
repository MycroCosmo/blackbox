# Dev Blackbox integration snippets

Dev Blackbox does not ship framework SDKs. Instead, your AI coding agent copies
and adapts one of these snippets into the project (spec 5.2). All of them POST
a JSON event to the local collector:

```
POST http://127.0.0.1:4319/events/network
Content-Type: application/json
```

Start the collector first: `npx dev-blackbox collect`

Event shape (only `request.method` and `request.url` are required):

```json
{
  "timestamp": "2026-07-14T10:00:00.000+09:00",
  "traceId": "TRACE-001",
  "source": { "application": "frontend", "page": "/todos", "action": "todo-create" },
  "request": { "method": "POST", "url": "/api/todos", "headers": {}, "body": {} },
  "response": { "status": 500, "headers": {}, "body": {} },
  "durationMs": 84,
  "error": { "type": "timeout", "message": "..." }
}
```

Trace linking: generate a trace id on the frontend, send it to your backend as
the `X-Dev-Blackbox-Trace-Id` header, and report it as `traceId` from both
sides. `dev-blackbox network show REQ-...` then returns every event on the
same trace.

Snippets:

- [fetch-interceptor.md](fetch-interceptor.md) — browser/Node fetch wrapper
- [axios-interceptor.md](axios-interceptor.md) — Axios interceptors
- [spring-filter.md](spring-filter.md) — Spring Boot `OncePerRequestFilter`
- [fastapi-middleware.md](fastapi-middleware.md) — FastAPI middleware

Notes:

- The collector only listens on 127.0.0.1 and must be started explicitly.
- Secrets (Authorization, password, tokens…) are masked by the collector
  before anything is written to disk — but avoid sending what you don't need.
- Reporting must never break the app: always wrap the POST in try/catch and
  fire-and-forget it.
