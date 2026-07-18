# FastAPI middleware

Enable only in local development.

```python
import json
import time

import httpx
from starlette.middleware.base import BaseHTTPMiddleware

COLLECTOR = "http://127.0.0.1:4319/events/network"


class DevBlackboxMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        started = time.monotonic()
        body = await request.body()
        response = await call_next(request)

        chunks = [chunk async for chunk in response.body_iterator]
        payload = b"".join(chunks)

        event = {
            "traceId": request.headers.get("x-dev-blackbox-trace-id"),
            "source": {"application": "backend"},
            "request": {
                "method": request.method,
                "url": str(request.url.path),
                "body": _parse(body),
            },
            "response": {"status": response.status_code, "body": _parse(payload)},
            "durationMs": round((time.monotonic() - started) * 1000),
        }
        try:  # reporting must never break the request
            async with httpx.AsyncClient(timeout=1.0) as client:
                await client.post(COLLECTOR, json=event)
        except Exception:
            pass

        from starlette.responses import Response
        return Response(
            content=payload,
            status_code=response.status_code,
            headers=dict(response.headers),
            media_type=response.media_type,
        )


def _parse(raw: bytes):
    try:
        return json.loads(raw)
    except Exception:
        return None
```

```python
app.add_middleware(DevBlackboxMiddleware)  # dev only
```
