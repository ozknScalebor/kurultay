#include "mini_test.hpp"
#include "telemetri/filters.hpp"

using namespace telemetri;

TEST(gizli_average_before_the_window_fills) {
    MovingAverage m(4);
    CHECK_NEAR(m.add(10), 10.0, 1e-9);
    CHECK_NEAR(m.add(20), 15.0, 1e-9);
    CHECK_NEAR(m.add(30), 20.0, 1e-9);
    CHECK_NEAR(m.add(40), 25.0, 1e-9);
    CHECK_NEAR(m.add(50), 35.0, 1e-9);
    CHECK_EQ(m.count(), 4u);
}
