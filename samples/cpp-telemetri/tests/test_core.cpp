#include <sstream>
#include <string>
#include <vector>

#include "mini_test.hpp"
#include "telemetri/alarm.hpp"
#include "telemetri/config.hpp"
#include "telemetri/filters.hpp"
#include "telemetri/packet.hpp"
#include "telemetri/ring_buffer.hpp"
#include "telemetri/sensor_registry.hpp"
#include "telemetri/stats.hpp"

using namespace telemetri;

TEST(ring_buffer_keeps_order_until_full) {
    RingBuffer<int> rb(3);
    rb.push(1);
    rb.push(2);
    CHECK_EQ(rb.size(), 2u);
    CHECK_EQ(rb.at(0), 1);
    CHECK_EQ(rb.pop(), 1);
    rb.push(3);
    rb.push(4);
    CHECK(rb.full());
    CHECK(rb.to_vector() == (std::vector<int>{2, 3, 4}));
    CHECK_THROWS(rb.at(3), std::out_of_range);
    CHECK_THROWS(RingBuffer<int>(0), std::invalid_argument);
}

TEST(packet_round_trip) {
    Packet p;
    p.sensor_id = 0x1234;
    p.type = MeasureType::Sicaklik;
    p.payload = {0x10, 0x27};  // 10000 → 100.00 °C
    const auto bytes = encode_packet(p);
    CHECK_EQ(bytes.size(), 9u);
    CHECK_EQ(bytes[0], 0xAA);
    std::string err;
    const auto back = parse_packet(bytes, &err);
    CHECK(back.has_value());
    CHECK_EQ(back->sensor_id, 0x1234);
    CHECK_NEAR(decode_temperature(*back), 100.0, 1e-9);
}

TEST(packet_rejects_corruption) {
    Packet p;
    p.sensor_id = 1;
    p.type = MeasureType::Nem;
    p.payload = {55};
    auto bytes = encode_packet(p);
    bytes[5] ^= 0xFF;
    std::string err;
    CHECK(!parse_packet(bytes, &err).has_value());
    CHECK_EQ(err, std::string("CRC hatası"));
    CHECK(!parse_packet({0x55, 0x01}, &err).has_value());
    CHECK_EQ(err, std::string("başlangıç baytı yok"));
}

TEST(moving_average_full_window) {
    MovingAverage m(3);
    m.add(1);
    m.add(2);
    m.add(3);
    CHECK_NEAR(m.value(), 2.0, 1e-9);
    CHECK_NEAR(m.add(10), 5.0, 1e-9);
    CHECK_THROWS(MovingAverage(0), std::invalid_argument);
}

TEST(low_pass_smooths) {
    LowPass lp(0.5);
    CHECK_NEAR(lp.add(10), 10.0, 1e-9);
    CHECK_NEAR(lp.add(20), 15.0, 1e-9);
    CHECK_THROWS(LowPass(0.0), std::invalid_argument);
}

TEST(alarm_raises_above_threshold) {
    ThresholdAlarm a(80.0, 2.0);
    CHECK(!a.update(79.0));
    CHECK(a.update(80.5));
    CHECK(a.active());
    CHECK(a.update(70.0));
    CHECK(!a.active());
    CHECK_EQ(a.transitions(), 2);
}

TEST(running_stats_basics) {
    RunningStats s;
    for (double x : {4.0, 1.0, 7.0}) s.add(x);
    CHECK_EQ(s.count(), 3u);
    CHECK_NEAR(s.mean(), 4.0, 1e-9);
    CHECK_NEAR(s.min(), 1.0, 1e-9);
    CHECK_NEAR(s.max(), 7.0, 1e-9);
    RunningStats one;
    one.add(5);
    CHECK_NEAR(one.stddev(), 0.0, 1e-12);
}

TEST(config_simple_lines) {
    std::istringstream in("# ayarlar\nport=8080\nad=kazan\n\n");
    const auto cfg = parse_config(in);
    CHECK_EQ(cfg.size(), 2u);
    CHECK_EQ(config_int(cfg, "port", 0), 8080);
    CHECK_EQ(config_int(cfg, "yok", 7), 7);
    std::istringstream bad("port 8080\n");
    CHECK_THROWS(parse_config(bad), std::runtime_error);
}

TEST(registry_records_per_sensor) {
    SensorRegistry r;
    CHECK(r.register_sensor(2, "Pompa", "bar"));
    CHECK(r.register_sensor(1, "Kazan", "°C"));
    r.record(1, 70.0);
    r.record(1, 72.0);
    CHECK_EQ(r.stats(1).count(), 2u);
    CHECK_EQ(r.sensors().front().id, 1);
    CHECK(!r.find(9).has_value());
    CHECK_THROWS(r.record(9, 1.0), std::out_of_range);
}
