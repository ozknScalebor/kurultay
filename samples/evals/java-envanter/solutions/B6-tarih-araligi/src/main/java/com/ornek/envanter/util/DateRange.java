package com.ornek.envanter.util;

import java.time.LocalDate;

/** A closed date interval: both {@code start} and {@code end} belong to the range. */
public final class DateRange {
    private final LocalDate start;
    private final LocalDate end;

    public DateRange(LocalDate start, LocalDate end) {
        if (start == null || end == null) throw new IllegalArgumentException("tarih boş olamaz");
        if (end.isBefore(start)) throw new IllegalArgumentException("bitiş başlangıçtan önce: " + start + " > " + end);
        this.start = start;
        this.end = end;
    }

    public static DateRange ofMonth(int year, int month) {
        LocalDate first = LocalDate.of(year, month, 1);
        return new DateRange(first, first.withDayOfMonth(first.lengthOfMonth()));
    }

    public LocalDate getStart() {
        return start;
    }

    public LocalDate getEnd() {
        return end;
    }

    /** True when {@code date} is within the range, both ends included. */
    public boolean contains(LocalDate date) {
        return !date.isBefore(start) && !date.isAfter(end);
    }

    public long days() {
        return end.toEpochDay() - start.toEpochDay() + 1;
    }

    @Override
    public String toString() {
        return "[" + start + " .. " + end + "]";
    }
}
