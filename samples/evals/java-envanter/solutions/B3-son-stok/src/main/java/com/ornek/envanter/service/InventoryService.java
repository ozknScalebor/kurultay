package com.ornek.envanter.service;

import com.ornek.envanter.model.StockItem;
import com.ornek.envanter.model.StockItem.StockMutator;
import com.ornek.envanter.repo.StockRepository;
import com.ornek.envanter.util.Validation;
import java.util.List;

/**
 * Stock across warehouses. Reservations are taken from warehouses in name
 * order and released in reverse order.
 */
public class InventoryService {
    private final StockRepository stock;

    public InventoryService(StockRepository stock) {
        this.stock = stock;
    }

    /** Goods received into a warehouse. */
    public void addStock(String sku, String warehouse, int quantity) {
        Validation.requireNonBlank(sku, "sku");
        Validation.requireNonBlank(warehouse, "warehouse");
        StockMutator.receive(stock.getOrCreate(sku, warehouse), quantity);
    }

    /** Units that can still be promised to new orders, over all warehouses. */
    public int available(String sku) {
        int total = 0;
        for (StockItem s : stock.findBySku(sku)) total += s.available();
        return total;
    }

    public int onHand(String sku) {
        int total = 0;
        for (StockItem s : stock.findBySku(sku)) total += s.getOnHand();
        return total;
    }

    /** Reserve units for an order; all or nothing. */
    public void reserve(String sku, int quantity) {
        Validation.requirePositive(quantity, "quantity");
        int total = available(sku);
        if (total < quantity) throw new InsufficientStockException(sku, quantity, total);
        int left = quantity;
        for (StockItem s : stock.findBySku(sku)) {
            if (left == 0) break;
            int take = Math.min(left, s.available());
            if (take > 0) {
                StockMutator.reserve(s, take);
                left -= take;
            }
        }
    }

    /** Give back reserved units (order cancelled). */
    public void release(String sku, int quantity) {
        Validation.requirePositive(quantity, "quantity");
        List<StockItem> items = stock.findBySku(sku);
        int left = quantity;
        for (int i = items.size() - 1; i >= 0 && left > 0; i--) {
            StockItem s = items.get(i);
            int give = Math.min(left, s.getReserved());
            if (give > 0) {
                StockMutator.release(s, give);
                left -= give;
            }
        }
        if (left > 0) throw new IllegalStateException("Serbest bırakılacak rezervasyon yok: " + sku + " (" + left + ")");
    }

    /** Reserved units leave the warehouse. */
    public void ship(String sku, int quantity) {
        Validation.requirePositive(quantity, "quantity");
        int left = quantity;
        for (StockItem s : stock.findBySku(sku)) {
            int out = Math.min(left, s.getReserved());
            if (out > 0) {
                StockMutator.ship(s, out);
                left -= out;
            }
        }
        if (left > 0) throw new IllegalStateException("Sevk edilecek rezervasyon yok: " + sku + " (" + left + ")");
    }

    public List<String> skus() {
        return stock.skus();
    }
}
