package com.ornek.envanter;

import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.Customer;
import com.ornek.envanter.model.CustomerTier;
import com.ornek.envanter.model.Product;
import com.ornek.envanter.repo.InMemoryProductRepository;
import com.ornek.envanter.repo.StockRepository;
import com.ornek.envanter.service.InventoryService;
import com.ornek.envanter.service.OrderService;
import com.ornek.envanter.service.PricingService;
import com.ornek.envanter.service.ReportService;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;

/** A small wired-up shop for tests: three products, a fixed clock (2024-03-15). */
public class Fixtures {
    public final InMemoryProductRepository products = new InMemoryProductRepository();
    public final InventoryService inventory = new InventoryService(new StockRepository());
    public Clock clock = Clock.fixed(Instant.parse("2024-03-15T10:00:00Z"), ZoneOffset.UTC);
    public final OrderService orders;
    public final PricingService pricing = new PricingService();
    public final ReportService reports;

    public static final Customer STANDARD = new Customer("M1", "Ali Veli", CustomerTier.STANDARD);
    public static final Customer SILVER = new Customer("M2", "Ayşe Kaya", CustomerTier.SILVER);
    public static final Customer GOLD = new Customer("M3", "Can Demir", CustomerTier.GOLD);

    public Fixtures() {
        products.save(new Product("EL-100", "Kulaklık", Category.ELEKTRONIK, new BigDecimal("100.00")));
        products.save(new Product("KR-200", "Defter", Category.KIRTASIYE, new BigDecimal("12.50")));
        products.save(new Product("GD-300", "Zeytinyağı 1L", Category.GIDA, new BigDecimal("250.00")));
        orders = new OrderService(products, inventory, clock);
        reports = new ReportService(products, inventory);
    }

    public static Map<String, Integer> qty(Object... skuAndQty) {
        Map<String, Integer> m = new LinkedHashMap<String, Integer>();
        for (int i = 0; i < skuAndQty.length; i += 2) m.put((String) skuAndQty[i], (Integer) skuAndQty[i + 1]);
        return m;
    }
}
