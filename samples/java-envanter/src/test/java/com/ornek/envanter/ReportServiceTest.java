package com.ornek.envanter;

import static com.ornek.test.Assert.assertEquals;
import static com.ornek.test.Assert.assertMoney;

import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.Order;
import com.ornek.envanter.service.StockLevel;
import com.ornek.envanter.util.DateRange;
import com.ornek.test.Test;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

public class ReportServiceTest {
    @Test
    public void lowStockLowestFirst() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("EL-100", "ANKARA", 3);
        f.inventory.addStock("KR-200", "ANKARA", 50);
        f.inventory.addStock("GD-300", "ANKARA", 3);
        List<StockLevel> low = f.reports.lowStock(5);
        assertEquals(2, low.size());
        assertEquals("EL-100", low.get(0).getSku());
        assertEquals("GD-300", low.get(1).getSku());
    }

    @Test
    public void salesByCategory() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("EL-100", "ANKARA", 10);
        f.inventory.addStock("KR-200", "ANKARA", 10);
        Order a = f.orders.create(Fixtures.STANDARD, Fixtures.qty("EL-100", 1, "KR-200", 2));
        Order b = f.orders.create(Fixtures.SILVER, Fixtures.qty("KR-200", 1));
        Map<Category, BigDecimal> s = f.reports.salesByCategory(Arrays.asList(a, b));
        assertMoney("100.00", s.get(Category.ELEKTRONIK));
        assertMoney("37.50", s.get(Category.KIRTASIYE));
    }

    @Test
    public void ordersInRange() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 1));
        assertEquals(1, f.reports.ordersIn(Arrays.asList(o), DateRange.ofMonth(2024, 3)).size());
        assertEquals(0, f.reports.ordersIn(Arrays.asList(o), DateRange.ofMonth(2024, 4)).size());
        assertEquals(1, f.reports.ordersIn(Arrays.asList(o), new DateRange(LocalDate.of(2024, 3, 15), LocalDate.of(2024, 3, 20))).size());
    }
}
