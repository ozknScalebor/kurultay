package com.ornek.envanter.io;

import com.ornek.envanter.model.Category;
import com.ornek.envanter.model.Product;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads products from CSV: {@code sku,ad,kategori,fiyat} with a header line.
 * Fields may be quoted ("Kalem, mavi"); a quote inside a quoted field is written twice ("").
 */
public class CsvProductLoader {

    public List<Product> load(Reader in) throws IOException {
        List<Product> out = new ArrayList<Product>();
        BufferedReader r = new BufferedReader(in);
        String line;
        int no = 0;
        while ((line = r.readLine()) != null) {
            no++;
            if (no == 1 || line.trim().isEmpty() || line.startsWith("#")) continue;
            List<String> f = parseLine(line);
            if (f.size() != 4) throw new IOException("Satır " + no + ": 4 alan bekleniyordu, " + f.size() + " bulundu: " + line);
            try {
                out.add(new Product(f.get(0), f.get(1), Category.parse(f.get(2)), new BigDecimal(f.get(3).trim())));
            } catch (IllegalArgumentException e) {
                throw new IOException("Satır " + no + ": " + e.getMessage(), e);
            }
        }
        return out;
    }

    /** Splits one CSV line into fields. */
    List<String> parseLine(String line) {
        List<String> out = new ArrayList<String>();
        for (String part : line.split(",", -1)) out.add(part.trim());
        return out;
    }
}
