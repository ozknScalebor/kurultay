package com.ornek.envanter.service;

import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.Order;
import com.ornek.envanter.model.OrderLine;
import com.ornek.envanter.model.Product;
import com.ornek.envanter.repo.ProductRepository;
import com.ornek.envanter.util.DateRange;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

public class ReportService {
    private final ProductRepository products;
    private final InventoryService inventory;

    public ReportService(ProductRepository products, InventoryService inventory) {
        this.products = products;
        this.inventory = inventory;
    }

    /** Products whose available stock is at or below {@code threshold}, lowest first, then by SKU. */
    public List<StockLevel> lowStock(int threshold) {
        List<StockLevel> out = new ArrayList<StockLevel>();
        for (Product p : products.findAll()) {
            int available = inventory.available(p.getSku());
            if (available <= threshold) out.add(new StockLevel(p.getSku(), p.getName(), available));
        }
        Collections.sort(out, new Comparator<StockLevel>() {
            @Override
            public int compare(StockLevel a, StockLevel b) {
                int c = Integer.compare(a.getAvailable(), b.getAvailable());
                return c != 0 ? c : a.getSku().compareTo(b.getSku());
            }
        });
        return out;
    }

    /** Revenue (line totals before discount and VAT) per category; cancelled orders are not sales. */
    public Map<Category, BigDecimal> salesByCategory(List<Order> orders) {
        Map<Category, BigDecimal> out = new EnumMap<Category, BigDecimal>(Category.class);
        for (Order o : orders) {
            for (OrderLine l : o.getLines()) {
                Category c = l.getProduct().getCategory();
                BigDecimal prev = out.containsKey(c) ? out.get(c) : BigDecimal.ZERO;
                out.put(c, prev.add(l.lineTotal()));
            }
        }
        return out;
    }

    /** Orders placed within the range (both ends included). */
    public List<Order> ordersIn(List<Order> orders, DateRange range) {
        List<Order> out = new ArrayList<Order>();
        for (Order o : orders) {
            if (range.contains(o.getDate())) out.add(o);
        }
        return out;
    }
}
