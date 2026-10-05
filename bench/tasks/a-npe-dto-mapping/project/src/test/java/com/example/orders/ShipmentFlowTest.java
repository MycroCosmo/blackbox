package com.example.orders;

import static org.assertj.core.api.Assertions.assertThat;

import com.example.orders.service.OrderService;
import com.example.orders.service.Shipment;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class ShipmentFlowTest {

    @Autowired
    OrderService orderService;

    @Test
    void printsShippingLabelForSeoulCustomer() {
        Shipment shipment = orderService.createShipment(1L);

        assertThat(shipment.label()).isEqualTo("Kim Minsu\n12 Teheran-ro\n06234 SEOUL");
    }

    @Test
    void printsShippingLabelForBusanCustomer() {
        Shipment shipment = orderService.createShipment(2L);

        assertThat(shipment.label()).isEqualTo("Lee Jiwoo\n88 Haeundae-ro\n48094 BUSAN");
    }
}
