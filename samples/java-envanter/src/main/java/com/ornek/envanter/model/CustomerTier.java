package com.ornek.envanter.model;

/** Loyalty tier of a customer and the discount it earns (percent of the subtotal). */
public enum CustomerTier {
    STANDARD(0),
    SILVER(5),
    GOLD(10);

    private final int discountPercent;

    CustomerTier(int discountPercent) {
        this.discountPercent = discountPercent;
    }

    public int getDiscountPercent() {
        return discountPercent;
    }
}
