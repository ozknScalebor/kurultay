#include "mini_test.hpp"
#include "telemetri/alarm.hpp"

using namespace telemetri;

TEST(gizli_alarm_needs_hysteresis_to_clear) {
    ThresholdAlarm a(80.0, 2.0);
    CHECK(a.update(80.5));
    CHECK(!a.update(79.0));
    CHECK(a.active());
    CHECK(!a.update(80.3));
    CHECK(a.update(77.9));
    CHECK(!a.active());
    CHECK_EQ(a.transitions(), 2);
}

TEST(gizli_no_chattering_around_the_threshold) {
    ThresholdAlarm a(50.0, 1.0);
    for (double v : {50.2, 49.8, 50.1, 49.9, 50.3, 49.5}) a.update(v);
    CHECK_EQ(a.transitions(), 1);
}
