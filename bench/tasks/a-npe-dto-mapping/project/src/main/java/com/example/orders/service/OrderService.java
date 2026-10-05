package com.example.orders.service;

import com.example.orders.dto.CustomerDto;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private final CustomerService customerService;
    private final ShippingLabelService labelService;

    public OrderService(CustomerService customerService, ShippingLabelService labelService) {
        this.customerService = customerService;
        this.labelService = labelService;
    }

    public Shipment createShipment(long customerId) {
        CustomerDto customer = customerService.getCustomer(customerId);
        return new Shipment(customerId, customer.getEmail(), labelService.labelFor(customer));
    }
}
