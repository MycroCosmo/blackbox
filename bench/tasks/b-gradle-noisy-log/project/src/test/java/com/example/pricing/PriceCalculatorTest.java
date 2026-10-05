package com.example.pricing;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvFileSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class PriceCalculatorTest {

    @Autowired
    PriceCalculator calculator;

    @ParameterizedTest(name = "[{index}] {0}: net {1} -> gross {2}")
    @CsvFileSource(resources = "/price-cases.csv", numLinesToSkip = 1)
    void addsVatAndRounds(String sku, BigDecimal net, BigDecimal expectedGross) {
        assertThat(calculator.grossPrice(net)).isEqualByComparingTo(expectedGross);
    }
}
