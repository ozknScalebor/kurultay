package com.ornek.envanter;

import com.ornek.envanter.io.CsvProductLoader;
import com.ornek.envanter.io.ReportFormatter;
import com.ornek.envanter.model.Customer;
import com.ornek.envanter.model.CustomerTier;
import com.ornek.envanter.model.Order;
import com.ornek.envanter.model.Product;
import com.ornek.envanter.repo.InMemoryProductRepository;
import com.ornek.envanter.repo.StockRepository;
import com.ornek.envanter.service.InventoryService;
import com.ornek.envanter.service.OrderService;
import com.ornek.envanter.service.PricingService;
import com.ornek.envanter.service.ReportService;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;

/** Demo: load the catalogue, stock it, place an order and print reports. */
public final class App {
    private App() {
    }

    public static void main(String[] args) throws Exception {
        String csv = args.length > 0 ? args[0] : "data/urunler.csv";
        InMemoryProductRepository products = new InMemoryProductRepository();
        try (Reader r = new InputStreamReader(Files.newInputStream(Paths.get(csv)), StandardCharsets.UTF_8)) {
            for (Product p : new CsvProductLoader().load(r)) products.save(p);
        }
        InventoryService inventory = new InventoryService(new StockRepository());
        for (Product p : products.findAll()) {
            inventory.addStock(p.getSku(), "ANKARA", 20);
            inventory.addStock(p.getSku(), "IZMIR", 5);
        }
        OrderService orders = new OrderService(products, inventory, Clock.systemDefaultZone());
        PricingService pricing = new PricingService();
        Map<String, Integer> q = new LinkedHashMap<String, Integer>();
        q.put(products.findAll().get(0).getSku(), 3);
        Order order = orders.create(new Customer("M1", "Ayşe Yılmaz", CustomerTier.GOLD), q);
        orders.confirm(order.getId());
        ReportFormatter fmt = new ReportFormatter();
        System.out.println("Sipariş " + order.getId() + " toplam: " + fmt.money(pricing.total(order)));
        ReportService reports = new ReportService(products, inventory);
        System.out.print(fmt.lowStockTable(reports.lowStock(22)));
        System.out.print(fmt.salesTable(reports.salesByCategory(orders.all())));
    }
}
