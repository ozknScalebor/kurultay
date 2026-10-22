package com.ornek.envanter.service;

public class InsufficientStockException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public InsufficientStockException(String sku, int requested, int available) {
        super("Yetersiz stok: " + sku + " istenen=" + requested + " mevcut=" + available);
    }
}
