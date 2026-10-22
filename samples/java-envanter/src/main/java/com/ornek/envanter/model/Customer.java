package com.ornek.envanter.model;

import com.ornek.envanter.util.Validation;

public final class Customer {
    private final String id;
    private final String name;
    private final CustomerTier tier;

    public Customer(String id, String name, CustomerTier tier) {
        this.id = Validation.requireNonBlank(id, "id");
        this.name = Validation.requireNonBlank(name, "name");
        this.tier = tier == null ? CustomerTier.STANDARD : tier;
    }

    public String getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public CustomerTier getTier() {
        return tier;
    }

    @Override
    public String toString() {
        return name + " (" + tier + ")";
    }
}
