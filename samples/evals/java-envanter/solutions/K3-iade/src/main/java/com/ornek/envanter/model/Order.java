package com.ornek.envanter.model;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class Order {
    private final String id;
    private final Customer customer;
    private final List<OrderLine> lines;
    private final LocalDate date;
    private OrderStatus status = OrderStatus.NEW;
    private final Map<String, Integer> returned = new HashMap<String, Integer>();

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

    /** Units of {@code sku} returned so far. */
    public int getReturnedQuantity(String sku) {
        Integer q = returned.get(sku);
        return q == null ? 0 : q;
    }

    public void addReturned(String sku, int quantity) {
        returned.put(sku, getReturnedQuantity(sku) + quantity);
    }

    public void setStatus(OrderStatus status) {
        this.status = status;
    }

    @Override
    public String toString() {
        return id + " " + customer + " " + status + " " + lines.size() + " satır";
    }
}
