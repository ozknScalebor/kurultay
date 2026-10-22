package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.repo.StockRepository;
import com.ornek.envanter.service.InventoryService;
import com.ornek.test.Test;

public class NegatifStokGizliTest {
    @Test
    public void addStockRejectsZeroAndNegative() {
        InventoryService inv = new InventoryService(new StockRepository());
        inv.addStock("A", "ANKARA", 5);
        assertThrows(IllegalArgumentException.class, () -> inv.addStock("A", "ANKARA", -3));
        assertThrows(IllegalArgumentException.class, () -> inv.addStock("A", "ANKARA", 0));
        assertEquals(5, inv.available("A"));
        assertEquals(5, inv.onHand("A"));
    }
}
