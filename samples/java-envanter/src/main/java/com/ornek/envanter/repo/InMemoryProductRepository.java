package com.ornek.envanter.repo;

import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.Product;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public final class InMemoryProductRepository implements ProductRepository {
    private final Map<String, Product> bySku = new LinkedHashMap<String, Product>();

    @Override
    public void save(Product product) {
        bySku.put(product.getSku(), product);
    }

    @Override
    public Optional<Product> findBySku(String sku) {
        return Optional.ofNullable(bySku.get(sku));
    }

    @Override
    public List<Product> findAll() {
        return new ArrayList<Product>(bySku.values());
    }

    @Override
    public List<Product> findByCategory(Category category) {
        List<Product> out = new ArrayList<Product>();
        for (Product p : bySku.values()) {
            if (p.getCategory() == category) out.add(p);
        }
        return out;
    }
}
