package com.ornek.envanter.service;

import com.ornek.envanter.model.Order;
import com.ornek.envanter.model.OrderLine;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Map;

/**
 * Prices are BigDecimal with 2 decimals, rounded HALF_UP (to the kuruş).
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
        double tax = base.doubleValue() * line.getProduct().getCategory().getTaxRate().doubleValue();
        return BigDecimal.valueOf(tax).setScale(SCALE, RoundingMode.DOWN);
    }

    public BigDecimal tax(Order order) {
        BigDecimal sum = BigDecimal.ZERO;
        for (OrderLine l : order.getLines()) sum = sum.add(lineTax(order, l));
        return sum;
    }

    /**
     * What the customer paid for these units: price x quantity with the order's discount
     * share, plus the category VAT, rounded to the kuruş (HALF_UP).
     */
    public BigDecimal refund(Order order, Map<String, Integer> quantities) {
        BigDecimal factor = discountFactor(order);
        BigDecimal sum = BigDecimal.ZERO;
        for (Map.Entry<String, Integer> e : quantities.entrySet()) {
            OrderLine line = null;
            for (OrderLine l : order.getLines()) {
                if (l.getProduct().getSku().equals(e.getKey())) line = l;
            }
            if (line == null) throw new IllegalArgumentException(e.getKey() + " siparişte yok");
            BigDecimal base = line.getProduct().getUnitPrice().multiply(BigDecimal.valueOf(e.getValue())).multiply(factor);
            sum = sum.add(base.multiply(BigDecimal.ONE.add(line.getProduct().getCategory().getTaxRate())));
        }
        return sum.setScale(SCALE, RoundingMode.HALF_UP);
    }

    public BigDecimal total(Order order) {
        return subtotal(order).subtract(discount(order)).add(tax(order)).setScale(SCALE, RoundingMode.HALF_UP);
    }
}
