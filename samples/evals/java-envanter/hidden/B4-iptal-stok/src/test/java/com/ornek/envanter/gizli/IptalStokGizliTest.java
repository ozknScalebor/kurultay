package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.model.Order;
import com.ornek.test.Test;

public class IptalStokGizliTest {
    @Test
    public void cancellingReleasesReservedStock() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 6);
        f.inventory.addStock("KR-200", "IZMIR", 4);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 8));
        assertEquals(2, f.inventory.available("KR-200"));
        f.orders.cancel(o.getId());
        assertEquals(10, f.inventory.available("KR-200"));
    }

    @Test
    public void cancellingAConfirmedOrderToo() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("EL-100", "ANKARA", 3);
        f.inventory.addStock("GD-300", "ANKARA", 3);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("EL-100", 1, "GD-300", 2));
        f.orders.confirm(o.getId());
        f.orders.cancel(o.getId());
        assertEquals(3, f.inventory.available("EL-100"));
        assertEquals(3, f.inventory.available("GD-300"));
        assertThrows(IllegalStateException.class, () -> f.orders.cancel(o.getId()));
        assertEquals(3, f.inventory.available("GD-300"));
    }
}
