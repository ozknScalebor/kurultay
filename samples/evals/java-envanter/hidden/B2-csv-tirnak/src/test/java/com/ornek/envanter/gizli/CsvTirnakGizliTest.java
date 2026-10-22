package com.ornek.envanter.gizli;

import static com.ornek.test.Assert.*;

import com.ornek.envanter.io.CsvProductLoader;
import com.ornek.envanter.model.Product;
import com.ornek.test.Test;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.List;

public class CsvTirnakGizliTest {
    @Test
    public void quotedFieldsWithCommasAndQuotes() throws Exception {
        List<Product> p = new CsvProductLoader().load(new StringReader("sku,ad,kategori,fiyat\nKR-200,\"Defter, A4 kareli\",Kırtasiye,42.50\nGD-301,\"Çay \"\"Rize\"\" 1kg\",Gıda,215.00\nEL-1,Mouse,Elektronik,\"10.50\"\n"));
        assertEquals(3, p.size());
        assertEquals("Defter, A4 kareli", p.get(0).getName());
        assertEquals("Çay \"Rize\" 1kg", p.get(1).getName());
        assertMoney("10.50", p.get(2).getUnitPrice());
    }

    @Test
    public void sampleDataLoads() throws Exception {
        try (Reader r = new InputStreamReader(new FileInputStream("data/urunler.csv"), StandardCharsets.UTF_8)) {
            assertEquals(7, new CsvProductLoader().load(r).size());
        }
    }

    @Test
    public void unterminatedQuoteIsAnError() {
        assertThrows(IOException.class, () -> new CsvProductLoader().load(new StringReader("h\nA,\"açık tırnak,Gıda,1\n")));
    }
}
