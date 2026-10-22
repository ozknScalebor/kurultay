package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.model.Order;
import com.ornek.test.Test;
import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.Product;
import java.math.BigDecimal;

public class KdvYuvarlamaGizliTest {
    @Test
    public void vatIsRoundedHalfUpToKurus() {
        Fixtures f = new Fixtures();
        f.products.save(new Product("GD-9", "Peynir", Category.GIDA, new BigDecimal("10.05")));
        f.inventory.addStock("GD-9", "ANKARA", 10);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("GD-9", 1));
        assertMoney("1.01", f.pricing.tax(o));
        assertMoney("11.06", f.pricing.total(o));
    }

    @Test
    public void exactDecimalArithmetic() {
        Fixtures f = new Fixtures();
        f.products.save(new Product("EL-9", "Kablo", Category.ELEKTRONIK, new BigDecimal("0.35")));
        f.inventory.addStock("EL-9", "ANKARA", 100);
        Order o = f.orders.create(Fixtures.STANDARD, Fixtures.qty("EL-9", 9));
        assertMoney("0.63", f.pricing.tax(o)); // 3.15 × 0.20 = 0.630
        assertMoney("3.78", f.pricing.total(o));
    }
}
