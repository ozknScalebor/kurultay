package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.model.Order;
import com.ornek.envanter.model.OrderLine;
import com.ornek.envanter.service.InsufficientStockException;
import com.ornek.test.Test;
import java.util.List;

public class SiparisGuncellemeGizliTest {
    private static String lines(Order o) {
        StringBuilder sb = new StringBuilder();
        for (OrderLine l : o.getLines()) sb.append(l.getProduct().getSku()).append('x').append(l.getQuantity()).append(' ');
        return sb.toString().trim();
    }

    private static Fixtures shop() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        f.inventory.addStock("EL-100", "ANKARA", 5);
        return f;
    }

    @Test
    public void increaseAndDecreaseMoveTheReservation() {
        Fixtures f = shop();
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        f.orders.changeQuantity(o.getId(), "KR-200", 5);
        assertEquals("KR-200x5", lines(f.orders.get(o.getId())));
        assertEquals(5, f.inventory.available("KR-200"));
        assertMoney("62.50", f.pricing.subtotal(f.orders.get(o.getId())));
        f.orders.changeQuantity(o.getId(), "KR-200", 1);
        assertEquals(9, f.inventory.available("KR-200"));
        assertMoney("12.50", f.pricing.subtotal(f.orders.get(o.getId())));
    }

    @Test
    public void notEnoughStockChangesNothing() {
        Fixtures f = shop();
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        assertThrows(InsufficientStockException.class, () -> f.orders.changeQuantity(o.getId(), "KR-200", 20));
        assertEquals("KR-200x2", lines(f.orders.get(o.getId())));
        assertEquals(8, f.inventory.available("KR-200"));
    }

    @Test
    public void addsAndRemovesLines() {
        Fixtures f = shop();
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        f.orders.changeQuantity(o.getId(), "EL-100", 2);
        assertEquals("KR-200x2 EL-100x2", lines(f.orders.get(o.getId())));
        assertEquals(3, f.inventory.available("EL-100"));
        assertMoney("225.00", f.pricing.subtotal(f.orders.get(o.getId())));
        f.orders.changeQuantity(o.getId(), "KR-200", 0);
        assertEquals("EL-100x2", lines(f.orders.get(o.getId())));
        assertEquals(10, f.inventory.available("KR-200"));
        assertThrows(IllegalArgumentException.class, () -> f.orders.changeQuantity(o.getId(), "EL-100", 0));
        assertEquals("EL-100x2", lines(f.orders.get(o.getId())));
        assertEquals(3, f.inventory.available("EL-100"));
        // removing a product that is not in the order is a no-op error, not a crash
        assertThrows(IllegalArgumentException.class, () -> f.orders.changeQuantity(o.getId(), "GD-300", 0));
    }

    @Test
    public void validatesInput() {
        Fixtures f = shop();
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        assertThrows(IllegalArgumentException.class, () -> f.orders.changeQuantity(o.getId(), "KR-200", -1));
        assertThrows(IllegalArgumentException.class, () -> f.orders.changeQuantity(o.getId(), "YOK-9", 1));
        assertThrows(IllegalArgumentException.class, () -> f.orders.changeQuantity("S99999", "KR-200", 1));
        assertEquals("KR-200x2", lines(f.orders.get(o.getId())));
        assertEquals(8, f.inventory.available("KR-200"));
    }

    @Test
    public void onlyOpenOrdersCanChange() {
        Fixtures f = shop();
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        f.orders.confirm(o.getId());
        f.orders.changeQuantity(o.getId(), "KR-200", 3);
        assertEquals(7, f.inventory.available("KR-200"));
        f.orders.ship(o.getId());
        assertEquals(7, f.inventory.onHand("KR-200"));
        assertThrows(IllegalStateException.class, () -> f.orders.changeQuantity(o.getId(), "KR-200", 1));
        assertEquals("KR-200x3", lines(f.orders.get(o.getId())));
        Order c = f.orders.create(Fixtures.STANDARD, Fixtures.qty("EL-100", 1));
        f.orders.cancel(c.getId());
        assertThrows(IllegalStateException.class, () -> f.orders.changeQuantity(c.getId(), "EL-100", 2));
    }

    @Test
    public void linesStayReadOnlyForCallers() {
        Fixtures f = shop();
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        List<OrderLine> l = f.orders.get(o.getId()).getLines();
        assertThrows(UnsupportedOperationException.class, () -> l.clear());
    }
}
