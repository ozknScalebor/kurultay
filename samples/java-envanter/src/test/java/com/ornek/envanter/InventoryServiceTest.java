package com.ornek.envanter;

import static com.ornek.test.Assert.assertEquals;
import static com.ornek.test.Assert.assertThrows;

import com.ornek.envanter.model.StockItem;
import com.ornek.envanter.repo.StockRepository;
import com.ornek.envanter.service.InsufficientStockException;
import com.ornek.envanter.service.InventoryService;
import com.ornek.test.Test;
import java.util.List;

public class InventoryServiceTest {
    private final StockRepository repo = new StockRepository();
    private final InventoryService inv = new InventoryService(repo);

    @Test
    public void availableSumsWarehouses() {
        inv.addStock("A", "IZMIR", 4);
        inv.addStock("A", "ANKARA", 3);
        inv.addStock("A", "ANKARA", 2);
        assertEquals(9, inv.available("A"));
        assertEquals(0, inv.available("YOK"));
    }

    @Test
    public void reservesFromWarehousesInNameOrder() {
        inv.addStock("A", "IZMIR", 4);
        inv.addStock("A", "ANKARA", 3);
        inv.reserve("A", 5);
        List<StockItem> items = repo.findBySku("A");
        assertEquals("ANKARA", items.get(0).getWarehouse());
        assertEquals(3, items.get(0).getReserved());
        assertEquals(2, items.get(1).getReserved());
        assertEquals(2, inv.available("A"));
    }

    @Test
    public void refusesToReserveMoreThanAvailable() {
        inv.addStock("A", "ANKARA", 3);
        InsufficientStockException e = assertThrows(InsufficientStockException.class, () -> inv.reserve("A", 4));
        assertEquals("Yetersiz stok: A istenen=4 mevcut=3", e.getMessage());
        assertEquals(3, inv.available("A"));
    }

    @Test
    public void releaseAndShip() {
        inv.addStock("A", "ANKARA", 3);
        inv.addStock("A", "IZMIR", 3);
        inv.reserve("A", 5);
        inv.release("A", 2);
        assertEquals(3, inv.available("A"));
        inv.ship("A", 3);
        assertEquals(3, inv.onHand("A"));
        assertEquals(3, inv.available("A"));
        assertThrows(IllegalStateException.class, () -> inv.release("A", 1));
    }
}
