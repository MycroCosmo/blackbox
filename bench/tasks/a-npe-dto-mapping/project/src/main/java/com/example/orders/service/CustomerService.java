package com.example.orders.service;

import com.example.orders.dto.CustomerDto;
import com.example.orders.mapper.CustomerMapper;
import com.example.orders.repository.CustomerRepository;
import java.util.NoSuchElementException;
import org.springframework.stereotype.Service;

@Service
public class CustomerService {

    private final CustomerRepository repository;
    private final CustomerMapper mapper;

    public CustomerService(CustomerRepository repository, CustomerMapper mapper) {
        this.repository = repository;
        this.mapper = mapper;
    }

    public CustomerDto getCustomer(long id) {
        return repository.findById(id)
                .map(mapper::toDto)
                .orElseThrow(() -> new NoSuchElementException("customer " + id));
    }
}
