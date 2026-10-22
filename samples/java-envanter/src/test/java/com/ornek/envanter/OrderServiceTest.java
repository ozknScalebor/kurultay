package com.ornek.envanter;

import static com.ornek.test.Assert.assertEquals;
import static com.ornek.test.Assert.assertThrows;

import com.ornek.envanter.model.Order;
import com.ornek.envanter.model.OrderStatus;
import com.ornek.envanter.service.InsufficientStockException;
import com.ornek.test.Test;
import java.time.LocalDate;

public class OrderServiceTest {
    @Test
    public void createReservesStock() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 4));
        assertEquals("S00001", o.getId());
        assertEquals(LocalDate.of(2024, 3, 15), o.getDate());
        assertEquals(OrderStatus.NEW, o.getStatus());
        assertEquals(6, f.inventory.available("KR-200"));
    }

    @Test
    public void failedLineReleasesEarlierReservations() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        f.inventory.addStock("EL-100", "ANKARA", 1);
        assertThrows(InsufficientStockException.class, () -> f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 4, "EL-100", 3)));
        assertEquals(10, f.inventory.available("KR-200"));
        assertThrows(IllegalArgumentException.class, () -> f.orders.create(Fixtures.STANDARD, Fixtures.qty("YOK", 1)));
    }

    @Test
    public void lifeCycle() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        assertThrows(IllegalStateException.class, () -> f.orders.ship(o.getId()));
        f.orders.confirm(o.getId());
        f.orders.ship(o.getId());
        assertEquals(OrderStatus.SHIPPED, o.getStatus());
        assertEquals(8, f.inventory.onHand("KR-200"));
        assertThrows(IllegalStateException.class, () -> f.orders.cancel(o.getId()));
        assertThrows(IllegalArgumentException.class, () -> f.orders.get("S99999"));
    }

    @Test
    public void cancelMarksTheOrder() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        f.orders.cancel(o.getId());
        assertEquals(OrderStatus.CANCELLED, o.getStatus());
    }
}
