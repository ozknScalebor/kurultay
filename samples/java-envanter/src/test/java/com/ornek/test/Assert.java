package com.ornek.test;

import java.math.BigDecimal;

/** Assertions for the mini test framework. */
public final class Assert {
    private Assert() {
    }

    public interface ThrowingRunnable {
        void run() throws Exception;
    }

    public static void assertTrue(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void assertFalse(boolean condition, String message) {
        assertTrue(!condition, message);
    }

    public static void assertEquals(Object expected, Object actual) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError("beklenen <" + expected + "> ama <" + actual + ">");
        }
    }

    public static void assertEquals(long expected, long actual) {
        if (expected != actual) throw new AssertionError("beklenen <" + expected + "> ama <" + actual + ">");
    }

    /** Numeric comparison of money values: 10.0 equals 10.00. */
    public static void assertMoney(String expected, BigDecimal actual) {
        if (actual == null || new BigDecimal(expected).compareTo(actual) != 0) {
            throw new AssertionError("beklenen tutar <" + expected + "> ama <" + actual + ">");
        }
    }

    public static <T extends Throwable> T assertThrows(Class<T> type, ThrowingRunnable r) {
        try {
            r.run();
        } catch (Throwable t) {
            if (type.isInstance(t)) return type.cast(t);
            throw new AssertionError("beklenen " + type.getSimpleName() + " ama " + t);
        }
        throw new AssertionError("beklenen " + type.getSimpleName() + " fırlatılmadı");
    }
}
