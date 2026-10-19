package dev.blackbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import jakarta.annotation.PreDestroy;

@SpringBootApplication
@RestController
public class DemoApplication {
    private static final Logger log = LoggerFactory.getLogger(DemoApplication.class);
    private final ExecutorService workers = Executors.newFixedThreadPool(4);
    private final BlackboxAdapter adapter;
    public DemoApplication(BlackboxAdapter adapter) { this.adapter = adapter; }
    public static void main(String[] args) { SpringApplication.run(DemoApplication.class, args); }

    @GetMapping("/ok") public Map<String, String> ok() {
        log.info("normal request");
        return Map.of("result", "ok");
    }
    @GetMapping("/fail") public void fail(@RequestParam(defaultValue="one") String marker,
                                        @RequestParam(defaultValue="false") boolean alternate) {
        log.info("marker={} password=demo-password cookie=demo-cookie", marker);
        throw new IllegalStateException("checkout failed", alternate
            ? new IllegalArgumentException("currency unsupported")
            : new IllegalArgumentException("inventory unavailable"));
    }
    @GetMapping("/async") public void async(@RequestParam String marker) {
        CompletableFuture.runAsync(BlackboxAdapter.wrap(() -> log.info("async marker={}", marker)), workers).join();
        throw new IllegalStateException("async failed", new IllegalArgumentException("inventory unavailable"));
    }
    @GetMapping("/large") public void large() {
        for (int i = 0; i < 1500; i++) log.info("bulk line {} token=demo-token padding={}", i, "x".repeat(100));
        recurse(300);
    }
    private void recurse(int depth) {
        if (depth > 0) recurse(depth - 1);
        else throw new IllegalStateException("deep failure password=demo-password", new IllegalArgumentException("deep root"));
    }
    @GetMapping("/blackbox-status") public Map<String, Object> status() { return adapter.status(); }
    @PreDestroy public void close() { workers.shutdownNow(); }
}
