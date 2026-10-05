package com.example.orders.service;

import com.example.orders.dto.AddressDto;
import com.example.orders.dto.CustomerDto;
import java.util.Locale;
import org.springframework.stereotype.Service;

@Service
public class ShippingLabelService {

    public String labelFor(CustomerDto customer) {
        AddressDto address = customer.getShippingAddress();
        return customer.getName() + "\n"
                + address.getStreet() + "\n"
                + cityLine(address);
    }

    private String cityLine(AddressDto address) {
        return address.getZipCode() + " " + address.getCity().toUpperCase(Locale.ROOT);
    }
}
