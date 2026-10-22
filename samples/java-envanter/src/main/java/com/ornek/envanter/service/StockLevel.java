package com.ornek.envanter.service;

/** One row of the low-stock report. */
public final class StockLevel {
    private final String sku;
    private final String name;
    private final int available;

    public StockLevel(String sku, String name, int available) {
        this.sku = sku;
        this.name = name;
        this.available = available;
    }

    public String getSku() {
        return sku;
    }

    public String getName() {
        return name;
    }

    public int getAvailable() {
        return available;
    }

    @Override
    public String toString() {
        return sku + " " + name + " " + available;
    }
}
