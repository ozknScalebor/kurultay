package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.service.InsufficientStockException;
import com.ornek.test.Test;

public class DepoTransferGizliTest {
    @Test
    public void movesUnitsBetweenWarehouses() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        f.inventory.transfer("KR-200", "ANKARA", "IZMIR", 4);
        assertEquals(6, f.inventory.onHand("KR-200", "ANKARA"));
        assertEquals(4, f.inventory.onHand("KR-200", "IZMIR"));
        assertEquals(4, f.inventory.available("KR-200", "IZMIR"));
        assertEquals(10, f.inventory.onHand("KR-200"));
        assertEquals(10, f.inventory.available("KR-200"));
    }

    @Test
    public void reservedUnitsStayWhereTheyAre() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        f.inventory.addStock("KR-200", "IZMIR", 2);
        f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 7)); // ANKARA first (name order): 7 reserved there
        assertEquals(3, f.inventory.available("KR-200", "ANKARA"));
        assertThrows(InsufficientStockException.class, () -> f.inventory.transfer("KR-200", "ANKARA", "IZMIR", 4));
        assertEquals(10, f.inventory.onHand("KR-200", "ANKARA"));
        assertEquals(2, f.inventory.onHand("KR-200", "IZMIR"));
        f.inventory.transfer("KR-200", "ANKARA", "IZMIR", 3);
        assertEquals(7, f.inventory.onHand("KR-200", "ANKARA"));
        assertEquals(0, f.inventory.available("KR-200", "ANKARA"));
        assertEquals(5, f.inventory.onHand("KR-200", "IZMIR"));
        assertEquals(5, f.inventory.available("KR-200"));
    }

    @Test
    public void createsTheTargetWarehouse() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("EL-100", "ANKARA", 5);
        assertEquals(0, f.inventory.onHand("EL-100", "BURSA"));
        f.inventory.transfer("EL-100", "ANKARA", "BURSA", 2);
        assertEquals(2, f.inventory.onHand("EL-100", "BURSA"));
        assertEquals(3, f.inventory.available("EL-100", "ANKARA"));
    }

    @Test
    public void rejectsInvalidTransfers() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 10);
        assertThrows(IllegalArgumentException.class, () -> f.inventory.transfer("KR-200", "ANKARA", "ANKARA", 1));
        assertThrows(IllegalArgumentException.class, () -> f.inventory.transfer("KR-200", "ANKARA", "IZMIR", 0));
        assertThrows(IllegalArgumentException.class, () -> f.inventory.transfer("KR-200", "ANKARA", "IZMIR", -2));
        assertThrows(IllegalArgumentException.class, () -> f.inventory.transfer("KR-200", " ", "IZMIR", 1));
        assertThrows(IllegalArgumentException.class, () -> f.inventory.transfer("KR-200", "ANKARA", "", 1));
        assertThrows(InsufficientStockException.class, () -> f.inventory.transfer("KR-200", "ANKARA", "IZMIR", 11));
        assertThrows(InsufficientStockException.class, () -> f.inventory.transfer("KR-200", "BURSA", "IZMIR", 1));
        assertThrows(InsufficientStockException.class, () -> f.inventory.transfer("YOK-1", "ANKARA", "IZMIR", 1));
        assertEquals(10, f.inventory.onHand("KR-200", "ANKARA"));
        assertEquals(0, f.inventory.onHand("KR-200", "IZMIR"));
        assertEquals(10, f.inventory.onHand("KR-200"));
    }
}
