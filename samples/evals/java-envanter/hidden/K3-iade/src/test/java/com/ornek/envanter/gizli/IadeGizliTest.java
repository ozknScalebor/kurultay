package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.Order;
import com.ornek.envanter.model.OrderStatus;
import com.ornek.test.Test;
import java.math.BigDecimal;
import java.util.Collections;
import java.util.Map;

public class IadeGizliTest {
    private static Fixtures shippedShop(String[] id) {
        Fixtures f = new Fixtures();
        f.inventory.addStock("EL-100", "ANKARA", 10);
        f.inventory.addStock("GD-300", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("EL-100", 3, "GD-300", 2));
        f.orders.confirm(o.getId());
        f.orders.ship(o.getId());
        id[0] = o.getId();
        return f;
    }

    @Test
    public void partialThenFullReturn() {
        String[] id = new String[1];
        Fixtures f = shippedShop(id);
        assertEquals(7, f.inventory.onHand("EL-100"));
        BigDecimal r1 = f.orders.returnItems(id[0], "IZMIR", Fixtures.qty("EL-100", 1));
        assertMoney("120.00", r1); // 100.00 + %20 KDV
        Order o = f.orders.get(id[0]);
        assertEquals(OrderStatus.PARTIALLY_RETURNED, o.getStatus());
        assertEquals(1, o.getReturnedQuantity("EL-100"));
        assertEquals(0, o.getReturnedQuantity("GD-300"));
        assertEquals(8, f.inventory.onHand("EL-100"));
        assertEquals(8, f.inventory.available("EL-100"));
        BigDecimal r2 = f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("EL-100", 2, "GD-300", 2));
        assertMoney("790.00", r2); // 2 x 120.00 + 2 x 275.00
        assertEquals(OrderStatus.RETURNED, f.orders.get(id[0]).getStatus());
        assertEquals(10, f.inventory.onHand("EL-100"));
        assertEquals(10, f.inventory.onHand("GD-300"));
        assertThrows(IllegalStateException.class, () -> f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("EL-100", 1)));
    }

    @Test
    public void refundMatchesPricing() {
        String[] id = new String[1];
        Fixtures f = shippedShop(id);
        Order o = f.orders.get(id[0]);
        assertMoney("395.00", f.pricing.refund(o, Fixtures.qty("EL-100", 1, "GD-300", 1)));
        assertMoney("910.00", f.pricing.refund(o, Fixtures.qty("EL-100", 3, "GD-300", 2)));
        assertMoney(f.pricing.total(o).toPlainString(), f.pricing.refund(o, Fixtures.qty("EL-100", 3, "GD-300", 2)));
        // refund() only calculates
        assertEquals(OrderStatus.SHIPPED, f.orders.get(id[0]).getStatus());
    }

    @Test
    public void invalidReturnsChangeNothing() {
        String[] id = new String[1];
        Fixtures f = shippedShop(id);
        assertThrows(IllegalArgumentException.class, () -> f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("EL-100", 4)));
        assertThrows(IllegalArgumentException.class, () -> f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("EL-100", 1, "GD-300", 3)));
        assertThrows(IllegalArgumentException.class, () -> f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("KR-200", 1)));
        assertThrows(IllegalArgumentException.class, () -> f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("EL-100", 0)));
        assertThrows(IllegalArgumentException.class, () -> f.orders.returnItems(id[0], "", Fixtures.qty("EL-100", 1)));
        assertThrows(IllegalArgumentException.class, () -> f.orders.returnItems(id[0], "ANKARA", Collections.<String, Integer>emptyMap()));
        Order o = f.orders.get(id[0]);
        assertEquals(OrderStatus.SHIPPED, o.getStatus());
        assertEquals(0, o.getReturnedQuantity("EL-100"));
        assertEquals(7, f.inventory.onHand("EL-100"));
        assertEquals(8, f.inventory.onHand("GD-300"));
        // more than shipped in total, over two returns
        f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("EL-100", 2));
        assertThrows(IllegalArgumentException.class, () -> f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("EL-100", 2)));
        assertEquals(2, f.orders.get(id[0]).getReturnedQuantity("EL-100"));
    }

    @Test
    public void onlyShippedOrdersAreReturnedAndReturnedOnesCannotBeCancelled() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        Order open = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        assertThrows(IllegalStateException.class, () -> f.orders.returnItems(open.getId(), "ANKARA", Fixtures.qty("KR-200", 1)));
        f.orders.confirm(open.getId());
        assertThrows(IllegalStateException.class, () -> f.orders.returnItems(open.getId(), "ANKARA", Fixtures.qty("KR-200", 1)));
        f.orders.ship(open.getId());
        f.orders.returnItems(open.getId(), "ANKARA", Fixtures.qty("KR-200", 1));
        assertThrows(IllegalStateException.class, () -> f.orders.cancel(open.getId()));
        assertThrows(IllegalStateException.class, () -> f.orders.ship(open.getId()));
        assertEquals(OrderStatus.PARTIALLY_RETURNED, f.orders.get(open.getId()).getStatus());
    }

    @Test
    public void salesReportSubtractsReturns() {
        String[] id = new String[1];
        Fixtures f = shippedShop(id);
        Map<Category, BigDecimal> before = f.reports.salesByCategory(f.orders.all());
        assertMoney("300.00", before.get(Category.ELEKTRONIK));
        assertMoney("500.00", before.get(Category.GIDA));
        f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("EL-100", 1));
        Map<Category, BigDecimal> mid = f.reports.salesByCategory(f.orders.all());
        assertMoney("200.00", mid.get(Category.ELEKTRONIK));
        assertMoney("500.00", mid.get(Category.GIDA));
        f.orders.returnItems(id[0], "ANKARA", Fixtures.qty("GD-300", 2));
        Map<Category, BigDecimal> after = f.reports.salesByCategory(f.orders.all());
        assertFalse(after.containsKey(Category.GIDA), "a fully returned category is not a sale");
        assertMoney("200.00", after.get(Category.ELEKTRONIK));
    }
}
