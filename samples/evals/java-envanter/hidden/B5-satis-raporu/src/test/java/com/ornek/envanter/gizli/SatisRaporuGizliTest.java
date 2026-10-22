package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.model.Order;
import com.ornek.test.Test;
import com.ornek.envanter.model.Category;
import java.math.BigDecimal;
import java.util.Arrays;
import java.util.Map;

public class SatisRaporuGizliTest {
    @Test
    public void cancelledOrdersAreNotSales() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("EL-100", "ANKARA", 10);
        f.inventory.addStock("KR-200", "ANKARA", 10);
        Order a = f.orders.create(Fixtures.STANDARD, Fixtures.qty("EL-100", 1, "KR-200", 2));
        Order b = f.orders.create(Fixtures.STANDARD, Fixtures.qty("EL-100", 3));
        f.orders.cancel(b.getId());
        Map<Category, BigDecimal> s = f.reports.salesByCategory(Arrays.asList(a, b));
        assertMoney("100.00", s.get(Category.ELEKTRONIK));
        assertMoney("25.00", s.get(Category.KIRTASIYE));
    }

    @Test
    public void onlyCancelledMeansNoCategory() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("GD-300", "ANKARA", 10);
        Order b = f.orders.create(Fixtures.STANDARD, Fixtures.qty("GD-300", 1));
        f.orders.cancel(b.getId());
        assertTrue(f.reports.salesByCategory(Arrays.asList(b)).isEmpty(), "iptal edilen siparişin kategorisi raporda olmamalı");
    }
}
