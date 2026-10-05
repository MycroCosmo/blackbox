package com.example.pricing;

import java.math.BigDecimal;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "pricing")
public record PricingProperties(String defaultCurrency, BigDecimal vatRate, int roundingScale) {
}
