package com.ornek.envanter.service;

import com.ornek.envanter.model.Customer;
import com.ornek.envanter.model.Order;
import com.ornek.envanter.model.OrderLine;
import com.ornek.envanter.model.OrderStatus;
import com.ornek.envanter.model.Product;
import com.ornek.envanter.repo.ProductRepository;
import java.time.Clock;
import com.ornek.envanter.util.Validation;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Order life cycle: NEW → CONFIRMED → SHIPPED, or NEW/CONFIRMED → CANCELLED. */
public class OrderService {
    private final ProductRepository products;
    private final InventoryService inventory;
    private final Clock clock;
    private final Map<String, Order> orders = new LinkedHashMap<String, Order>();
    private int sequence;

    public OrderService(ProductRepository products, InventoryService inventory, Clock clock) {
        this.products = products;
        this.inventory = inventory;
        this.clock = clock;
    }

    /** Creates the order and reserves its stock. If any line cannot be reserved nothing is reserved. */
    public Order create(Customer customer, Map<String, Integer> quantities) {
        if (quantities == null || quantities.isEmpty()) throw new IllegalArgumentException("sipariş boş");
        List<OrderLine> lines = new ArrayList<OrderLine>();
        for (Map.Entry<String, Integer> e : quantities.entrySet()) {
            Product p = products.findBySku(e.getKey()).orElseThrow(() -> new IllegalArgumentException("Ürün yok: " + e.getKey()));
            lines.add(new OrderLine(p, e.getValue()));
        }
        List<OrderLine> reserved = new ArrayList<OrderLine>();
        try {
            for (OrderLine l : lines) {
                inventory.reserve(l.getProduct().getSku(), l.getQuantity());
                reserved.add(l);
            }
        } catch (RuntimeException ex) {
            for (OrderLine l : reserved) inventory.release(l.getProduct().getSku(), l.getQuantity());
            throw ex;
        }
        String id = String.format("S%05d", ++sequence);
        Order order = new Order(id, customer, lines, LocalDate.now(clock));
        orders.put(id, order);
        return order;
    }

    public Order get(String id) {
        Order o = orders.get(id);
        if (o == null) throw new IllegalArgumentException("Sipariş yok: " + id);
        return o;
    }

    public List<Order> all() {
        return new ArrayList<Order>(orders.values());
    }

    public void confirm(String id) {
        Order o = get(id);
        requireStatus(o, OrderStatus.NEW);
        o.setStatus(OrderStatus.CONFIRMED);
    }

    public void ship(String id) {
        Order o = get(id);
        requireStatus(o, OrderStatus.CONFIRMED);
        for (OrderLine l : o.getLines()) inventory.ship(l.getProduct().getSku(), l.getQuantity());
        o.setStatus(OrderStatus.SHIPPED);
    }

    /** Cancel a NEW or CONFIRMED order; its reserved stock becomes available again. */
    public void cancel(String id) {
        Order o = get(id);
        if (o.getStatus() != OrderStatus.NEW && o.getStatus() != OrderStatus.CONFIRMED) {
            throw new IllegalStateException(id + " iptal edilemez: " + o.getStatus());
        }
        o.setStatus(OrderStatus.CANCELLED);
    }

    /**
     * Shipped units come back into {@code warehouse}. All or nothing; returns the refund.
     */
    public BigDecimal returnItems(String id, String warehouse, Map<String, Integer> quantities) {
        Order o = get(id);
        if (o.getStatus() != OrderStatus.SHIPPED && o.getStatus() != OrderStatus.PARTIALLY_RETURNED) {
            throw new IllegalStateException(id + " iade edilemez: " + o.getStatus());
        }
        Validation.requireNonBlank(warehouse, "warehouse");
        if (quantities == null || quantities.isEmpty()) throw new IllegalArgumentException("iade boş");
        for (Map.Entry<String, Integer> e : quantities.entrySet()) {
            int shipped = 0;
            for (OrderLine l : o.getLines()) {
                if (l.getProduct().getSku().equals(e.getKey())) shipped = l.getQuantity();
            }
            if (shipped == 0) throw new IllegalArgumentException(e.getKey() + " siparişte yok");
            int q = e.getValue() == null ? 0 : e.getValue();
            if (q <= 0) throw new IllegalArgumentException("iade miktarı pozitif olmalı: " + q);
            if (o.getReturnedQuantity(e.getKey()) + q > shipped) throw new IllegalArgumentException(e.getKey() + ": sevk edilenden fazla iade");
        }
        BigDecimal refund = new PricingService().refund(o, quantities);
        for (Map.Entry<String, Integer> e : quantities.entrySet()) {
            inventory.addStock(e.getKey(), warehouse, e.getValue());
            o.addReturned(e.getKey(), e.getValue());
        }
        boolean all = true;
        for (OrderLine l : o.getLines()) all &= o.getReturnedQuantity(l.getProduct().getSku()) == l.getQuantity();
        o.setStatus(all ? OrderStatus.RETURNED : OrderStatus.PARTIALLY_RETURNED);
        return refund;
    }

    private static void requireStatus(Order o, OrderStatus expected) {
        if (o.getStatus() != expected) throw new IllegalStateException(o.getId() + " durumu " + o.getStatus() + ", beklenen " + expected);
    }
}
