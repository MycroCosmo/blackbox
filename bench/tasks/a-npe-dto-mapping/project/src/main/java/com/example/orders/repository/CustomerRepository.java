package com.example.orders.repository;

import com.example.orders.domain.Address;
import com.example.orders.domain.Customer;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Repository;

@Repository
public class CustomerRepository {

    private final Map<Long, Customer> customers = new ConcurrentHashMap<>();

    public CustomerRepository() {
        save(new Customer(1L, "Kim Minsu", "minsu@example.com",
                new Address("12 Teheran-ro", "Seoul", "06234")));
        save(new Customer(2L, "Lee Jiwoo", "jiwoo@example.com",
                new Address("88 Haeundae-ro", "Busan", "48094")));
    }

    public Customer save(Customer customer) {
        customers.put(customer.getId(), customer);
        return customer;
    }

    public Optional<Customer> findById(long id) {
        return Optional.ofNullable(customers.get(id));
    }
}
