package com.example.orders;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.orders.domain.Address;
import com.example.orders.domain.Customer;
import com.example.orders.dto.CustomerDto;
import com.example.orders.mapper.CustomerMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/** Verification-only test: the fix must live in the mapping, not in a null guard downstream. */
@SpringBootTest
class HiddenMappingTest {

    @Autowired
    CustomerMapper mapper;

    @Test
    void mapperCopiesAddressIntoShippingAddress() {
        Customer customer = new Customer(9L, "Park Seoyeon", "seoyeon@example.com",
                new Address("1 Jongno", "Seoul", "03154"));

        CustomerDto dto = mapper.toDto(customer);

        assertThat(dto.getShippingAddress()).isNotNull();
        assertThat(dto.getShippingAddress().getStreet()).isEqualTo("1 Jongno");
        assertThat(dto.getShippingAddress().getCity()).isEqualTo("Seoul");
        assertThat(dto.getShippingAddress().getZipCode()).isEqualTo("03154");
    }
}
