package com.ornek.envanter.model;

import java.math.BigDecimal;

/** Product category with its VAT (KDV) rate. */
public enum Category {
    ELEKTRONIK("0.20"),
    GIDA("0.10"),
    KIRTASIYE("0.20"),
    GIYIM("0.10");

    private final BigDecimal taxRate;

    Category(String taxRate) {
        this.taxRate = new BigDecimal(taxRate);
    }

    public BigDecimal getTaxRate() {
        return taxRate;
    }

    /** Case-insensitive lookup that also accepts Turkish spellings ("Gıda", "Kırtasiye"). */
    public static Category parse(String text) {
        // Locale.ROOT: "Gıda" → "GIDA", "giyim" → "GIYIM"; a dotted capital İ is normalised too
        String t = text.trim().toUpperCase(java.util.Locale.ROOT).replace('İ', 'I');
        for (Category c : values()) {
            if (c.name().equals(t)) return c;
        }
        throw new IllegalArgumentException("Bilinmeyen kategori: " + text);
    }
}
