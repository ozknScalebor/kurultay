package com.ornek.envanter.repo;

import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.Product;
import java.util.List;
import java.util.Optional;

public interface ProductRepository {
    void save(Product product);

    Optional<Product> findBySku(String sku);

    List<Product> findAll();

    List<Product> findByCategory(Category category);
}
