#include "mini_test.hpp"
#include <string>
#include "telemetri/sensor_registry.hpp"

using namespace telemetri;

TEST(gizli_duplicate_registration_changes_nothing) {
    SensorRegistry r;
    CHECK(r.register_sensor(1, "Kazan", "°C"));
    r.record(1, 70.0);
    CHECK(!r.register_sensor(1, "Pompa", "bar"));
    CHECK_EQ(r.find(1)->name, std::string("Kazan"));
    CHECK_EQ(r.find(1)->unit, std::string("°C"));
    CHECK_EQ(r.stats(1).count(), 1u);
    CHECK_EQ(r.sensors().size(), 1u);
}
