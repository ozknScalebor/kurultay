package com.ornek.envanter.model;

import java.math.BigDecimal;

public final class OrderLine {
    private final Product product;
    private final int quantity;

    public OrderLine(Product product, int quantity) {
        if (product == null) throw new IllegalArgumentException("product boş olamaz");
        if (quantity <= 0) throw new IllegalArgumentException("miktar pozitif olmalı: " + quantity);
        this.product = product;
        this.quantity = quantity;
    }

    public Product getProduct() {
        return product;
    }

    public int getQuantity() {
        return quantity;
    }

    public BigDecimal lineTotal() {
        return product.getUnitPrice().multiply(BigDecimal.valueOf(quantity));
    }
}
