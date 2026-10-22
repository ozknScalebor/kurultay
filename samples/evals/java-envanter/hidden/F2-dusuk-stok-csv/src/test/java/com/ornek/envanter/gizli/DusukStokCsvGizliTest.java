package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.io.ReportFormatter;
import com.ornek.envanter.service.StockLevel;
import com.ornek.test.Test;
import java.util.ArrayList;
import java.util.Arrays;

public class DusukStokCsvGizliTest {
    @Test
    public void lowStockCsv() {
        String csv = new ReportFormatter().lowStockCsv(Arrays.asList(new StockLevel("KR-200", "Defter, A4", 2), new StockLevel("GD-301", "Çay \"Rize\"", 0), new StockLevel("EL-1", "Mouse", 7)));
        assertEquals("sku,ad,mevcut\nKR-200,\"Defter, A4\",2\nGD-301,\"Çay \"\"Rize\"\"\",0\nEL-1,Mouse,7\n", csv);
        assertEquals("sku,ad,mevcut\n", new ReportFormatter().lowStockCsv(new ArrayList<StockLevel>()));
    }
}
