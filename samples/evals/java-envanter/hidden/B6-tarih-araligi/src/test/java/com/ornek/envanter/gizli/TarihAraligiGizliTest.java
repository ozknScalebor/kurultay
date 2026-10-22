package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.model.Order;
import com.ornek.test.Test;
import com.ornek.envanter.service.OrderService;
import com.ornek.envanter.util.DateRange;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Arrays;

public class TarihAraligiGizliTest {
    @Test
    public void endDateIsIncluded() {
        DateRange r = new DateRange(LocalDate.of(2024, 1, 10), LocalDate.of(2024, 1, 20));
        assertTrue(r.contains(LocalDate.of(2024, 1, 20)), "bitiş günü dahil olmalı");
        DateRange oneDay = new DateRange(LocalDate.of(2024, 5, 1), LocalDate.of(2024, 5, 1));
        assertTrue(oneDay.contains(LocalDate.of(2024, 5, 1)), "tek günlük aralık");
        assertEquals(1, oneDay.days());
    }

    @Test
    public void monthlyReportIncludesTheLastDay() {
        Fixtures f = new Fixtures();
        f.clock = Clock.fixed(Instant.parse("2024-03-31T12:00:00Z"), ZoneOffset.UTC);
        f.inventory.addStock("KR-200", "ANKARA", 5);
        OrderService orders = new OrderService(f.products, f.inventory, f.clock);
        Order o = orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 1));
        assertEquals(1, f.reports.ordersIn(Arrays.asList(o), DateRange.ofMonth(2024, 3)).size());
    }
}
