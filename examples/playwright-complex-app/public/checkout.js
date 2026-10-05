const collector = "http://127.0.0.1:4319/events/network";

function report(event) {
  return fetch(collector, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
    keepalive: true,
  }).catch(() => undefined);
}

async function recordedFetch(url, init) {
  const traceId = `TRACE-${crypto.randomUUID()}`;
  const started = performance.now();
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, "X-Dev-Blackbox-Trace-Id": traceId },
  });
  const responseBody = await response.clone().json();
  window.__blackboxReport = report({
    traceId,
    source: { application: "checkout-web", page: location.pathname, action: "place-order" },
    request: { method: init.method, url, body: JSON.parse(init.body) },
    response: { status: response.status, body: responseBody },
    durationMs: Math.round(performance.now() - started),
  });
  return { response, responseBody };
}

document.querySelector("#checkout").addEventListener("click", async () => {
  const result = document.querySelector("#result");
  result.textContent = "Submitting…";
  const { response, responseBody } = await recordedFetch("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "VIP-4281",
      lines: [
        { sku: "LAPTOP-PRO", quantity: 1 },
        { sku: "USB-C-DOCK", quantity: 1 },
      ],
    }),
  });
  result.textContent = response.ok ? `Order confirmed: ${responseBody.orderId}` : responseBody.message;
});
