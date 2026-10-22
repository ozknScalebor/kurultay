package com.ornek.envanter.util;

public final class Validation {
    private Validation() {
    }

    public static String requireNonBlank(String value, String field) {
        if (value == null || value.trim().isEmpty()) throw new IllegalArgumentException(field + " boş olamaz");
        return value.trim();
    }

    public static int requirePositive(int value, String field) {
        if (value <= 0) throw new IllegalArgumentException(field + " pozitif olmalı: " + value);
        return value;
    }
}
