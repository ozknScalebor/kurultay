package com.ornek.envanter.model;

public enum OrderStatus {
    NEW,
    CONFIRMED,
    SHIPPED,
    CANCELLED,
    /** some shipped units came back */
    PARTIALLY_RETURNED,
    /** every shipped unit came back */
    RETURNED
}
