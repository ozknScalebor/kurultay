#include "mini_test.hpp"
#include "telemetri/stats.hpp"

using namespace telemetri;

TEST(gizli_sample_standard_deviation) {
    RunningStats s;
    for (double x : {2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0}) s.add(x);
    CHECK_NEAR(s.mean(), 5.0, 1e-12);
    CHECK_NEAR(s.variance(), 32.0 / 7.0, 1e-9);
    CHECK_NEAR(s.stddev(), 2.138089935, 1e-6);
    RunningStats two;
    two.add(1);
    two.add(3);
    CHECK_NEAR(two.variance(), 2.0, 1e-12);
}
