package com.example.pricing;

import java.math.BigDecimal;
import java.math.RoundingMode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

@Service
public class PriceCalculator {

    private static final Logger log = LoggerFactory.getLogger(PriceCalculator.class);

    private final PricingProperties properties;

    public PriceCalculator(PricingProperties properties) {
        this.properties = properties;
    }

    public BigDecimal grossPrice(BigDecimal netPrice) {
        BigDecimal gross = netPrice
                .multiply(BigDecimal.ONE.add(properties.vatRate()))
                .setScale(properties.roundingScale(), RoundingMode.HALF_UP);
        log.info("gross price computed: net={} vat={} gross={} {}",
                netPrice, properties.vatRate(), gross, properties.defaultCurrency());
        return gross;
    }
}
