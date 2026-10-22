package com.ornek.envanter.service;

import com.ornek.envanter.model.Order;
import com.ornek.envanter.model.OrderLine;
import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Prices are BigDecimal with 2 decimals, rounded HALF_UP (kuruş).
 * total = subtotal - tier discount + VAT, VAT per line on the discounted amount.
 */
public class PricingService {
    public static final int SCALE = 2;

    public BigDecimal subtotal(Order order) {
        BigDecimal sum = BigDecimal.ZERO;
        for (OrderLine l : order.getLines()) sum = sum.add(l.lineTotal());
        return sum.setScale(SCALE, RoundingMode.HALF_UP);
    }

    /** Loyalty discount: the customer's tier percentage of the subtotal. */
    public BigDecimal discount(Order order) {
        int percent = order.getCustomer().getTier().getDiscountPercent();
        BigDecimal rate = BigDecimal.valueOf(percent / 100);
        return subtotal(order).multiply(rate).setScale(SCALE, RoundingMode.HALF_UP);
    }

    /** Share of the discount that belongs to the order (0..1). */
    protected BigDecimal discountFactor(Order order) {
        BigDecimal subtotal = subtotal(order);
        if (subtotal.signum() == 0) return BigDecimal.ONE;
        return BigDecimal.ONE.subtract(discount(order).divide(subtotal, 10, RoundingMode.HALF_UP));
    }

    /** VAT of one line after the order-level discount. */
    public BigDecimal lineTax(Order order, OrderLine line) {
        BigDecimal base = line.lineTotal().multiply(discountFactor(order));
        return base.multiply(line.getProduct().getCategory().getTaxRate()).setScale(SCALE, RoundingMode.HALF_UP);
    }

    public BigDecimal tax(Order order) {
        BigDecimal sum = BigDecimal.ZERO;
        for (OrderLine l : order.getLines()) sum = sum.add(lineTax(order, l));
        return sum;
    }

    public BigDecimal total(Order order) {
        return subtotal(order).subtract(discount(order)).add(tax(order)).setScale(SCALE, RoundingMode.HALF_UP);
    }
}
