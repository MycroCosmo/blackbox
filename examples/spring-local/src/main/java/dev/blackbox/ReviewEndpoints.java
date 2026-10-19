package dev.blackbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Synthetic failures for regression checks; all credentials below are fake. */
@RestController
public class ReviewEndpoints {
    private static final Logger log = LoggerFactory.getLogger(ReviewEndpoints.class);

    @GetMapping("/review-secret") public void secret() {
        log.info("password: review-fake-password");
        log.info("Authorization: Basic cmV2aWV3OmZha2U=");
        log.info("api_key: review-fake-key");
        throw new IllegalArgumentException("secret masking test");
    }

    @GetMapping("/review-logged") public ResponseEntity<String> logged() {
        try {
            throw new IllegalStateException("operation failed", new IllegalArgumentException("hidden SQLState 08001 connection refused"));
        } catch (Exception e) {
            log.error("operation failed", e);
            return ResponseEntity.internalServerError().body("failed");
        }
    }

    @GetMapping("/review-late") public void late() {
        log.error("early diagnostic: connection retry failed");
        for (int i = 0; i < 550; i++) log.info("progress {}", i);
        log.error("diagnostic: database pool exhausted");
        throw new IllegalStateException("request failed");
    }
}
