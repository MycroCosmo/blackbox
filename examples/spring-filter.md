# Spring Boot OncePerRequestFilter

Register only in the `local`/`dev` profile.

```java
@Component
@Profile("local")
public class DevBlackboxFilter extends OncePerRequestFilter {

    private static final String COLLECTOR = "http://127.0.0.1:4319/events/network";
    private final RestClient client = RestClient.create();
    private final ObjectMapper om = new ObjectMapper();

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        ContentCachingRequestWrapper request = new ContentCachingRequestWrapper(req);
        ContentCachingResponseWrapper response = new ContentCachingResponseWrapper(res);
        long started = System.currentTimeMillis();
        try {
            chain.doFilter(request, response);
        } finally {
            report(request, response, System.currentTimeMillis() - started);
            response.copyBodyToResponse();
        }
    }

    private void report(ContentCachingRequestWrapper req, ContentCachingResponseWrapper res, long durationMs) {
        try { // reporting must never break the request
            Map<String, Object> event = Map.of(
                "traceId", Optional.ofNullable(req.getHeader("X-Dev-Blackbox-Trace-Id")).orElse(""),
                "source", Map.of("application", "backend"),
                "request", Map.of(
                    "method", req.getMethod(),
                    "url", req.getRequestURI(),
                    "body", parse(req.getContentAsByteArray())),
                "response", Map.of(
                    "status", res.getStatus(),
                    "body", parse(res.getContentAsByteArray())),
                "durationMs", durationMs);
            client.post().uri(COLLECTOR).contentType(MediaType.APPLICATION_JSON).body(event).retrieve().toBodilessEntity();
        } catch (Exception ignored) { }
    }

    private Object parse(byte[] body) {
        try { return om.readTree(body); } catch (Exception e) { return null; }
    }
}
```
