package com.ornek.envanter;

import static com.ornek.test.Assert.assertEquals;
import static com.ornek.test.Assert.assertFalse;
import static com.ornek.test.Assert.assertThrows;
import static com.ornek.test.Assert.assertTrue;

import com.ornek.envanter.util.DateRange;
import com.ornek.test.Test;
import java.time.LocalDate;

public class DateRangeTest {
    @Test
    public void monthRanges() {
        assertEquals(29, DateRange.ofMonth(2024, 2).days());
        assertEquals(LocalDate.of(2023, 2, 28), DateRange.ofMonth(2023, 2).getEnd());
    }

    @Test
    public void containsStartAndMiddle() {
        DateRange r = new DateRange(LocalDate.of(2024, 1, 10), LocalDate.of(2024, 1, 20));
        assertTrue(r.contains(LocalDate.of(2024, 1, 10)), "başlangıç dahil");
        assertTrue(r.contains(LocalDate.of(2024, 1, 15)), "ortası");
        assertFalse(r.contains(LocalDate.of(2024, 1, 9)), "öncesi");
        assertFalse(r.contains(LocalDate.of(2024, 1, 21)), "sonrası");
        assertThrows(IllegalArgumentException.class, () -> new DateRange(LocalDate.of(2024, 1, 2), LocalDate.of(2024, 1, 1)));
    }
}
