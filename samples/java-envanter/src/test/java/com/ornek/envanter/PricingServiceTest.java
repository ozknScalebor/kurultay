package com.ornek.envanter;

import static com.ornek.test.Assert.assertMoney;

import com.ornek.envanter.model.Order;
import com.ornek.test.Test;

public class PricingServiceTest {
    @Test
    public void standardCustomerPaysSubtotalPlusVat() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("EL-100", "ANKARA", 10);
        f.inventory.addStock("GD-300", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("EL-100", 2, "GD-300", 1));
        assertMoney("450.00", f.pricing.subtotal(o));
        assertMoney("0", f.pricing.discount(o));
        assertMoney("65.00", f.pricing.tax(o)); // 200 × %20 + 250 × %10
        assertMoney("515.00", f.pricing.total(o));
    }
}
