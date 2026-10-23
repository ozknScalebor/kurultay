#include "mini_test.hpp"
#include <stdexcept>
#include "telemetri/filters.hpp"

using namespace telemetri;

TEST(gizli_median_filter_rejects_spikes) {
    MedianFilter m(3);
    CHECK_NEAR(m.add(10), 10.0, 1e-9);
    CHECK_NEAR(m.add(12), 11.0, 1e-9);  // two samples: mean of the two middle values
    CHECK_NEAR(m.add(500), 12.0, 1e-9); // the spike is suppressed
    CHECK_NEAR(m.add(11), 12.0, 1e-9);
    CHECK_NEAR(m.add(13), 13.0, 1e-9);  // window: 500, 11, 13
    CHECK_NEAR(m.add(9), 11.0, 1e-9);
    CHECK_EQ(m.count(), 3u);
    CHECK_THROWS(MedianFilter(0), std::invalid_argument);
    CHECK_THROWS(MedianFilter(4), std::invalid_argument);
}
