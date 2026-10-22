package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.model.Order;
import com.ornek.test.Test;

public class KuponGizliTest {
    @Test
    public void yaz15TakesFifteenPercentAfterTierDiscount() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("EL-100", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("EL-100", 2));
        f.orders.applyCoupon(o.getId(), "yaz15");
        assertEquals("YAZ15", o.getCouponCode());
        assertMoney("30.00", f.pricing.discount(o));
        assertMoney("34.00", f.pricing.tax(o));
        assertMoney("204.00", f.pricing.total(o));
    }

    @Test
    public void couponRules() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 2));
        assertEquals(null, o.getCouponCode());
        assertThrows(IllegalArgumentException.class, () -> f.orders.applyCoupon(o.getId(), "BEDAVA"));
        f.orders.applyCoupon(o.getId(), "YAZ15");
        assertThrows(IllegalStateException.class, () -> f.orders.applyCoupon(o.getId(), "YAZ15"));
        Order c = f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 1));
        f.orders.cancel(c.getId());
        assertThrows(IllegalStateException.class, () -> f.orders.applyCoupon(c.getId(), "YAZ15"));
    }
}
