package com.ornek.envanter.model;

import com.ornek.envanter.util.Validation;
import java.math.BigDecimal;

/** Immutable catalogue entry; identity is the SKU. */
public final class Product {
    private final String sku;
    private final String name;
    private final Category category;
    private final BigDecimal unitPrice;

    public Product(String sku, String name, Category category, BigDecimal unitPrice) {
        this.sku = Validation.requireNonBlank(sku, "sku");
        this.name = Validation.requireNonBlank(name, "name");
        if (category == null) throw new IllegalArgumentException("category boş olamaz");
        this.category = category;
        if (unitPrice == null || unitPrice.signum() < 0) throw new IllegalArgumentException("unitPrice negatif olamaz: " + unitPrice);
        this.unitPrice = unitPrice;
    }

    public String getSku() {
        return sku;
    }

    public String getName() {
        return name;
    }

    public Category getCategory() {
        return category;
    }

    public BigDecimal getUnitPrice() {
        return unitPrice;
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof Product && ((Product) o).sku.equals(sku);
    }

    @Override
    public int hashCode() {
        return sku.hashCode();
    }

    @Override
    public String toString() {
        return sku + " " + name + " " + unitPrice;
    }
}
