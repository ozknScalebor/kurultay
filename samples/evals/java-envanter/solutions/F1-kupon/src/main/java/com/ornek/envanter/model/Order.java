package com.ornek.envanter.model;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class Order {
    private final String id;
    private final Customer customer;
    private final List<OrderLine> lines;
    private final LocalDate date;
    private OrderStatus status = OrderStatus.NEW;
    private String couponCode;

    public Order(String id, Customer customer, List<OrderLine> lines, LocalDate date) {
        if (lines == null || lines.isEmpty()) throw new IllegalArgumentException("sipariş en az bir satır içermeli");
        this.id = id;
        this.customer = customer;
        this.lines = Collections.unmodifiableList(new ArrayList<OrderLine>(lines));
        this.date = date;
    }

    public String getId() {
        return id;
    }

    public Customer getCustomer() {
        return customer;
    }

    public List<OrderLine> getLines() {
        return lines;
    }

    public LocalDate getDate() {
        return date;
    }

    public OrderStatus getStatus() {
        return status;
    }

    public void setStatus(OrderStatus status) {
        this.status = status;
    }

    /** Applied coupon code (upper case) or null. */
    public String getCouponCode() {
        return couponCode;
    }

    public void setCouponCode(String couponCode) {
        this.couponCode = couponCode;
    }

    @Override
    public String toString() {
        return id + " " + customer + " " + status + " " + lines.size() + " satır";
    }
}
