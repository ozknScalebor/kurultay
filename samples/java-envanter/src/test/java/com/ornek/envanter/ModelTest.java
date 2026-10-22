package com.ornek.envanter;

import static com.ornek.test.Assert.assertEquals;
import static com.ornek.test.Assert.assertThrows;

import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.OrderLine;
import com.ornek.envanter.model.Product;
import com.ornek.test.Test;
import java.math.BigDecimal;

public class ModelTest {
    @Test
    public void categoryParsesTurkishSpellings() {
        assertEquals(Category.GIDA, Category.parse("Gıda"));
        assertEquals(Category.KIRTASIYE, Category.parse(" kırtasiye "));
        assertEquals(Category.GIYIM, Category.parse("GİYİM"));
        assertEquals(Category.ELEKTRONIK, Category.parse("elektronik"));
        assertThrows(IllegalArgumentException.class, () -> Category.parse("mobilya"));
    }

    @Test
    public void productValidatesItsFields() {
        assertThrows(IllegalArgumentException.class, () -> new Product(" ", "x", Category.GIDA, BigDecimal.ONE));
        assertThrows(IllegalArgumentException.class, () -> new Product("A", "x", Category.GIDA, new BigDecimal("-1")));
        assertThrows(IllegalArgumentException.class, () -> new Product("A", "x", null, BigDecimal.ONE));
        assertEquals(new Product("A", "x", Category.GIDA, BigDecimal.ONE), new Product("A", "y", Category.GIYIM, BigDecimal.TEN));
    }

    @Test
    public void orderLineTotals() {
        OrderLine l = new OrderLine(new Product("A", "x", Category.GIDA, new BigDecimal("2.25")), 4);
        assertEquals(new BigDecimal("9.00"), l.lineTotal());
        assertThrows(IllegalArgumentException.class, () -> new OrderLine(new Product("A", "x", Category.GIDA, BigDecimal.ONE), 0));
    }
}
