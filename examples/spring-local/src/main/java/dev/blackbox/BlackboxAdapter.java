package dev.blackbox;

import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxy;
import ch.qos.logback.classic.Level;
import ch.qos.logback.core.AppenderBase;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerExceptionResolver;
import org.springframework.web.servlet.ModelAndView;

import java.io.IOException;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/** Optional local Servlet/Logback adapter. No bytecode instrumentation or Scouter dependency. */
@Component
@Profile("local")
public class BlackboxAdapter extends OncePerRequestFilter implements HandlerExceptionResolver, Ordered {
    private static final ThreadLocal<Context> current = new ThreadLocal<>();
    private final ObjectMapper json;
    private final URI endpoint;
    private final String service;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(300)).build();
    private final ThreadPoolExecutor sender = new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(64), r -> { Thread t = new Thread(r, "blackbox-sender"); t.setDaemon(true); return t; },
        new ThreadPoolExecutor.AbortPolicy());
    private final AtomicLong sent = new AtomicLong(), dropped = new AtomicLong(), failures = new AtomicLong();
    private volatile String lastSentAt = "";
    private final AppenderBase<ILoggingEvent> appender;

    private static final class Context {
        final String trace;
        record Log(String message, boolean error, int bytes) {}
        final List<Log> logs = new ArrayList<>();
        int droppedLogs, bytes;
        boolean closed, truncated;
        Throwable error;
        IThrowableProxy loggedError;
        Context(String trace) { this.trace = trace; }
        synchronized void log(String message, boolean important, IThrowableProxy throwable) {
            if (closed) return;
            if (important && throwable != null) loggedError = throwable;
            // Do not cut a secret mid-value: collector masks complete messages before truncation.
            int size = message.getBytes(StandardCharsets.UTF_8).length;
            if (size > 8192) { droppedLogs++; return; }
            while (logs.size() >= 500 || bytes + size > 65536) {
                int remove = -1;
                for (int i = 0; i < logs.size(); i++) if (!logs.get(i).error()) { remove = i; break; }
                if (remove < 0) {
                    if (!important) { droppedLogs++; return; }
                    remove = 0;
                }
                bytes -= logs.remove(remove).bytes(); droppedLogs++;
            }
            logs.add(new Log(message, important, size)); bytes += size;
        }
        synchronized void error(Throwable t) { if (!closed && error == null) error = t; }
    }

    public BlackboxAdapter(ObjectMapper json,
        @Value("${dev.blackbox.collector:http://127.0.0.1:4319/events/network}") String endpoint,
        @Value("${spring.application.name:backend}") String service) {
        this.json = json; this.endpoint = URI.create(endpoint); this.service = service;
        if (!"http".equals(this.endpoint.getScheme()) || !Set.of("127.0.0.1", "localhost", "[::1]").contains(this.endpoint.getHost()))
            throw new IllegalArgumentException("Blackbox collector must be local HTTP");
        appender = new AppenderBase<>() {
            @Override protected void append(ILoggingEvent event) {
                Context c = current.get();
                if (c == null) return;
                c.log(Instant.ofEpochMilli(event.getTimeStamp()) + " " + event.getLevel() + " " + event.getLoggerName() + " " + event.getFormattedMessage(),
                    event.getLevel().isGreaterOrEqual(Level.ERROR), event.getThrowableProxy());
            }
        };
        LoggerContext logging = (LoggerContext) LoggerFactory.getILoggerFactory();
        appender.setContext(logging); appender.setName("DEV_BLACKBOX"); appender.start();
        logging.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME).addAppender(appender);
    }

    /** Submit wrapped work AND join it before the servlet request returns. */
    public static Runnable wrap(Runnable task) {
        Context captured = current.get();
        return () -> {
            Context previous = current.get(); String previousMdc = MDC.get("blackboxTraceId");
            set(captured);
            try { task.run(); }
            finally { restore(previous, previousMdc); }
        };
    }
    private static void set(Context c) {
        if (c == null) { current.remove(); MDC.remove("blackboxTraceId"); }
        else { current.set(c); MDC.put("blackboxTraceId", c.trace); }
    }
    private static void restore(Context c, String mdc) {
        set(c); if (mdc == null) MDC.remove("blackboxTraceId"); else MDC.put("blackboxTraceId", mdc);
    }
    @Override public int getOrder() { return Ordered.HIGHEST_PRECEDENCE; }
    @Override public ModelAndView resolveException(HttpServletRequest request, HttpServletResponse response, Object handler, Exception error) {
        Context c = current.get(); if (c != null) c.error(error);
        return null; // Observe handled MVC exceptions without changing the application's resolution.
    }
    @Override protected boolean shouldNotFilter(HttpServletRequest req) { return req.getRequestURI().equals("/blackbox-status"); }
    @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String trace = req.getHeader("X-Dev-Blackbox-Trace-Id");
        if (trace == null || !trace.matches("[A-Za-z0-9_-]{1,128}")) trace = UUID.randomUUID().toString();
        Context c = new Context(trace); Context previous = current.get(); String previousMdc = MDC.get("blackboxTraceId");
        set(c); res.setHeader("X-Dev-Blackbox-Trace-Id", trace);
        Instant started = Instant.now(); long tick = System.nanoTime(); boolean escaped = false;
        try { chain.doFilter(req, res); }
        catch (IOException | ServletException | RuntimeException | Error e) { escaped = true; c.error(e); throw e; }
        finally {
            try {
                Map<String, Object> event = new LinkedHashMap<>();
                event.put("timestamp", started.toString()); event.put("traceId", c.trace);
                event.put("source", Map.of("application", service));
                event.put("request", Map.of("method", req.getMethod(), "url", req.getRequestURI()));
                event.put("response", Map.of("status", escaped ? 500 : res.getStatus()));
                event.put("durationMs", (System.nanoTime() - tick) / 1_000_000.0);
                synchronized (c) {
                    c.closed = true;
                    Map<String, Object> profile = new LinkedHashMap<>();
                    IThrowableProxy error = c.error != null ? new ThrowableProxy(c.error) : c.loggedError;
                    if (error != null) profile.put("exception", exception(error, c));
                    profile.put("logs", c.logs.stream().map(Context.Log::message).toList()); profile.put("droppedLogs", c.droppedLogs);
                    profile.put("truncated", c.truncated || c.droppedLogs > 0);
                    profile.put("incomplete", req.isAsyncStarted());
                    event.put("profile", profile);
                }
                // Serialization and HTTP happen on a bounded background queue; never wait in a request.
                try { sender.execute(() -> send(event)); } catch (RejectedExecutionException e) { dropped.incrementAndGet(); }
            } catch (Exception e) { dropped.incrementAndGet(); }
            finally { restore(previous, previousMdc); }
        }
    }
    private Map<String, Object> exception(IThrowableProxy error, Context c) {
        List<Map<String, Object>> chain = new ArrayList<>();
        Set<IThrowableProxy> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        IThrowableProxy t = error;
        while (t != null && seen.add(t)) {
            var stack = t.getStackTraceElementProxyArray();
            if (stack == null) stack = new ch.qos.logback.classic.spi.StackTraceElementProxy[0];
            if (stack.length > 256) c.truncated = true;
            List<String> frames = Arrays.stream(stack).limit(256).map(x -> "at " + x.getStackTraceElement()).toList();
            String message = Objects.toString(t.getMessage(), "");
            if (message.length() > 8192) { message = "[message omitted: exceeds adapter limit]"; c.truncated = true; }
            chain.add(new LinkedHashMap<>(Map.of("type", t.getClassName(), "message", message, "stack", frames)));
            if (chain.size() == 17) { if (t.getCause() != null) c.truncated = true; break; }
            t = t.getCause();
        }
        Map<String, Object> first = chain.remove(0); first.put("causes", chain); return first;
    }
    private void send(Map<String, Object> event) {
        try {
            byte[] bytes = json.writeValueAsBytes(event);
            if (bytes.length > 900000) { dropped.incrementAndGet(); return; }
            HttpRequest request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(1))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofByteArray(bytes)).build();
            int code = client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
            if (code < 200 || code >= 300) { failures.incrementAndGet(); return; }
            sent.incrementAndGet(); lastSentAt = Instant.now().toString();
        } catch (InterruptedException e) { failures.incrementAndGet(); Thread.currentThread().interrupt(); }
        catch (Exception e) { failures.incrementAndGet(); }
    }
    public Map<String, Object> status() {
        return Map.of("queued", sender.getQueue().size(), "sent", sent.get(), "dropped", dropped.get(),
            "sendFailures", failures.get(), "lastSentAt", lastSentAt, "active", sender.getActiveCount());
    }
    @PreDestroy public void close() {
        ((LoggerContext) LoggerFactory.getILoggerFactory()).getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME).detachAppender(appender);
        appender.stop(); sender.shutdown();
        try { if (!sender.awaitTermination(2, TimeUnit.SECONDS)) dropped.addAndGet(sender.shutdownNow().size()); }
        catch (InterruptedException e) { dropped.addAndGet(sender.shutdownNow().size()); Thread.currentThread().interrupt(); }
    }
}
