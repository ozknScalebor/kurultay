#include "mini_test.hpp"
#include <string>
#include "telemetri/report.hpp"
#include "telemetri/sensor_registry.hpp"

using namespace telemetri;

TEST(gizli_stats_csv) {
    SensorRegistry r;
    r.register_sensor(2, "Pompa, ana hat", "bar");
    r.register_sensor(1, "Kazan \"A\"", "°C");
    r.register_sensor(5, "Yedek", "%");
    r.record(1, 70.0);
    r.record(1, 72.5);
    r.record(2, 3.25);
    const std::string expected =
        "id,ad,birim,adet,ortalama,min,maks\n"
        "1,\"Kazan \"\"A\"\"\",°C,2,71.250,70.000,72.500\n"
        "2,\"Pompa, ana hat\",bar,1,3.250,3.250,3.250\n"
        "5,Yedek,%,0,,,\n";
    CHECK_EQ(stats_csv(r), expected);
    CHECK_EQ(stats_csv(SensorRegistry{}), std::string("id,ad,birim,adet,ortalama,min,maks\n"));
}
