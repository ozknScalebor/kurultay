package com.ornek.envanter.io;

import com.ornek.envanter.model.Category;
import com.ornek.envanter.service.StockLevel;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.Map;

/** Plain-text reports for the console. */
public class ReportFormatter {

    public String money(BigDecimal amount) {
        return amount.setScale(2, RoundingMode.HALF_UP).toPlainString() + " TL";
    }

    public String lowStockTable(List<StockLevel> rows) {
        StringBuilder sb = new StringBuilder();
        sb.append(String.format("%-10s %-30s %6s%n", "SKU", "Ürün", "Mevcut"));
        for (StockLevel r : rows) sb.append(String.format("%-10s %-30s %6d%n", r.getSku(), r.getName(), r.getAvailable()));
        return sb.toString();
    }

    /** Low-stock rows as CSV (RFC 4180 quoting, "\\n" line ends) with the header {@code sku,ad,mevcut}. */
    public String lowStockCsv(List<StockLevel> rows) {
        StringBuilder sb = new StringBuilder("sku,ad,mevcut\n");
        for (StockLevel r : rows) sb.append(csv(r.getSku())).append(',').append(csv(r.getName())).append(',').append(r.getAvailable()).append('\n');
        return sb.toString();
    }

    private static String csv(String v) {
        if (v.indexOf(',') < 0 && v.indexOf('"') < 0 && v.indexOf('\n') < 0) return v;
        return '"' + v.replace("\"", "\"\"") + '"';
    }

    public String salesTable(Map<Category, BigDecimal> sales) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<Category, BigDecimal> e : sales.entrySet()) sb.append(String.format("%-12s %14s%n", e.getKey(), money(e.getValue())));
        return sb.toString();
    }
}
