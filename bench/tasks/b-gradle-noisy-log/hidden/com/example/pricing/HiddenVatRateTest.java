package com.example.pricing;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/** Verification-only test: the configured VAT rate must be the intended 10%,
 *  bound as a decimal fraction, not dropped or special-cased in code. */
@SpringBootTest
class HiddenVatRateTest {

    @Autowired
    PricingProperties properties;

    @Autowired
    PriceCalculator calculator;

    @Test
    void bindsVatRateAsDecimalFraction() {
        assertThat(properties.vatRate()).isEqualByComparingTo(new BigDecimal("0.10"));
        assertThat(calculator.grossPrice(new BigDecimal("12345"))).isEqualByComparingTo("13580");
    }
}
