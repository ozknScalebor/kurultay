package com.ornek.envanter.repo;

import com.ornek.envanter.model.StockItem;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Stock per SKU and warehouse; warehouses are kept in name order. */
public final class StockRepository {
    private final Map<String, Map<String, StockItem>> stock = new TreeMap<String, Map<String, StockItem>>();

    public StockItem getOrCreate(String sku, String warehouse) {
        Map<String, StockItem> byWarehouse = stock.get(sku);
        if (byWarehouse == null) {
            byWarehouse = new TreeMap<String, StockItem>();
            stock.put(sku, byWarehouse);
        }
        StockItem item = byWarehouse.get(warehouse);
        if (item == null) {
            item = new StockItem(sku, warehouse, 0);
            byWarehouse.put(warehouse, item);
        }
        return item;
    }

    public List<StockItem> findBySku(String sku) {
        Map<String, StockItem> byWarehouse = stock.get(sku);
        return byWarehouse == null ? new ArrayList<StockItem>() : new ArrayList<StockItem>(byWarehouse.values());
    }

    public List<String> skus() {
        return new ArrayList<String>(stock.keySet());
    }
}
