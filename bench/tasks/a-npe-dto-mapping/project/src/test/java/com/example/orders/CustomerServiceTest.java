package com.example.orders;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.orders.dto.CustomerDto;
import com.example.orders.service.CustomerService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class CustomerServiceTest {

    @Autowired
    CustomerService customerService;

    @Test
    void returnsCustomerContactDetails() {
        CustomerDto customer = customerService.getCustomer(1L);

        assertThat(customer.getName()).isEqualTo("Kim Minsu");
        assertThat(customer.getEmail()).isEqualTo("minsu@example.com");
    }
}
