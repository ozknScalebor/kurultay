package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.model.Order;
import com.ornek.test.Test;

public class KademeIndirimiGizliTest {
    @Test
    public void goldGetsTenPercent() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("EL-100", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.GOLD, Fixtures.qty("EL-100", 2));
        assertMoney("200.00", f.pricing.subtotal(o));
        assertMoney("20.00", f.pricing.discount(o));
        assertMoney("36.00", f.pricing.tax(o));
        assertMoney("216.00", f.pricing.total(o));
    }

    @Test
    public void silverGetsFivePercent() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.SILVER, Fixtures.qty("KR-200", 4));
        assertMoney("2.50", f.pricing.discount(o));
        assertMoney("57.00", f.pricing.total(o));
    }
}
