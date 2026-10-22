package com.ornek.envanter;

import static com.ornek.test.Assert.assertEquals;
import static com.ornek.test.Assert.assertMoney;
import static com.ornek.test.Assert.assertThrows;
import static com.ornek.test.Assert.assertTrue;

import com.ornek.envanter.io.CsvProductLoader;
import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.Product;
import com.ornek.test.Test;
import java.io.IOException;
import java.io.StringReader;
import java.util.List;

public class CsvProductLoaderTest {
    @Test
    public void readsSimpleLines() throws Exception {
        List<Product> p = new CsvProductLoader().load(new StringReader("sku,ad,kategori,fiyat\nEL-1,Mouse,Elektronik,199.90\n\n# yorum\nGD-2,Çay,Gıda, 45\n"));
        assertEquals(2, p.size());
        assertEquals("Mouse", p.get(0).getName());
        assertEquals(Category.GIDA, p.get(1).getCategory());
        assertMoney("45", p.get(1).getUnitPrice());
    }

    @Test
    public void reportsBadLines() {
        IOException e = assertThrows(IOException.class, () -> new CsvProductLoader().load(new StringReader("baslik\nEL-1,Mouse,Elektronik\n")));
        assertTrue(e.getMessage().startsWith("Satır 2: 4 alan"), e.getMessage());
        assertThrows(IOException.class, () -> new CsvProductLoader().load(new StringReader("baslik\nEL-1,Mouse,Mobilya,10\n")));
        assertThrows(IOException.class, () -> new CsvProductLoader().load(new StringReader("baslik\nEL-1,Mouse,Gıda,on\n")));
    }
}
