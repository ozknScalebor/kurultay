package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.Fixtures;
import com.ornek.envanter.repo.StockRepository;
import com.ornek.envanter.service.InsufficientStockException;
import com.ornek.envanter.service.InventoryService;
import com.ornek.test.Test;

public class SonStokGizliTest {
    @Test
    public void lastUnitsCanBeReserved() {
        InventoryService inv = new InventoryService(new StockRepository());
        inv.addStock("A", "ANKARA", 2);
        inv.addStock("A", "IZMIR", 3);
        inv.reserve("A", 5);
        assertEquals(0, inv.available("A"));
        assertThrows(InsufficientStockException.class, () -> inv.reserve("A", 1));
    }

    @Test
    public void orderForTheWholeStock() {
        Fixtures f = new Fixtures();
        f.inventory.addStock("KR-200", "ANKARA", 4);
        f.orders.create(Fixtures.STANDARD, Fixtures.qty("KR-200", 4));
        assertEquals(0, f.inventory.available("KR-200"));
    }
}
