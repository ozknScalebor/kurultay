package com.ornek.envanter.model;

/** Stock of one product in one warehouse. Reserved units are promised to open orders. */
public final class StockItem {
    private final String sku;
    private final String warehouse;
    private int onHand;
    private int reserved;

    public StockItem(String sku, String warehouse, int onHand) {
        this.sku = sku;
        this.warehouse = warehouse;
        this.onHand = onHand;
    }

    public String getSku() {
        return sku;
    }

    public String getWarehouse() {
        return warehouse;
    }

    public int getOnHand() {
        return onHand;
    }

    public int getReserved() {
        return reserved;
    }

    public int available() {
        return onHand - reserved;
    }

    void addOnHand(int qty) {
        onHand += qty;
    }

    void addReserved(int qty) {
        reserved += qty;
    }

    /** Package-private mutators are reached through {@link StockMutator}. */
    public static final class StockMutator {
        private StockMutator() {
        }

        public static void receive(StockItem s, int qty) {
            s.addOnHand(qty);
        }

        public static void reserve(StockItem s, int qty) {
            s.addReserved(qty);
        }

        public static void release(StockItem s, int qty) {
            s.addReserved(-qty);
        }

        public static void ship(StockItem s, int qty) {
            s.addReserved(-qty);
            s.addOnHand(-qty);
        }
    }

    @Override
    public String toString() {
        return sku + "@" + warehouse + " eldeki=" + onHand + " rezerve=" + reserved;
    }
}
