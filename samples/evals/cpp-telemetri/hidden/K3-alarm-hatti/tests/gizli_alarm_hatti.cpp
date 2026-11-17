#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "mini_test.hpp"
#include "telemetri/pipeline.hpp"

using namespace telemetri;

namespace {
// what the field devices send: CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)
std::uint16_t device_crc(const std::uint8_t* d, std::size_t n) {
    std::uint16_t crc = 0xFFFF;
    for (std::size_t i = 0; i < n; ++i) {
        crc ^= static_cast<std::uint16_t>(d[i] << 8);
        for (int b = 0; b < 8; ++b) crc = (crc & 0x8000) ? static_cast<std::uint16_t>((crc << 1) ^ 0x1021) : static_cast<std::uint16_t>(crc << 1);
    }
    return crc;
}

std::vector<std::uint8_t> device_frame(std::uint16_t id, std::uint8_t type, std::vector<std::uint8_t> payload) {
    std::vector<std::uint8_t> f = {0xAA, static_cast<std::uint8_t>(3 + payload.size()), static_cast<std::uint8_t>(id & 0xFF), static_cast<std::uint8_t>(id >> 8), type};
    f.insert(f.end(), payload.begin(), payload.end());
    const auto crc = device_crc(f.data() + 1, f.size() - 1);
    f.push_back(static_cast<std::uint8_t>(crc & 0xFF));
    f.push_back(static_cast<std::uint8_t>(crc >> 8));
    return f;
}

std::vector<std::uint8_t> temp(std::uint16_t id, double celsius) {
    const auto raw = static_cast<std::int16_t>(celsius * 100.0 + (celsius < 0 ? -0.5 : 0.5));
    return device_frame(id, 1, {static_cast<std::uint8_t>(raw & 0xFF), static_cast<std::uint8_t>((raw >> 8) & 0xFF)});
}

const char* kConfig =
    "# Kazan dairesi ve soğuk oda\n"
    "sensor.7.name = Kazan dairesi    # ana kazan\n"
    "sensor.7.unit = C\n"
    "alarm.7.high  = 80\n"
    "alarm.7.hysteresis = 2.5\n"
    "\n"
    "sensor.12.name=Soğuk oda\n"
    "  alarm.12.low = -18   \n"
    "alarm.12.high = 4\n"
    "alarm.12.hysteresis = 1\n"
    "sensor.30.name = Yedek\n";
}  // namespace

TEST(gizli_pipeline_reads_the_field_config) {
    std::istringstream cfg(kConfig);
    Pipeline p(cfg);
    const auto s = p.registry().sensors();
    CHECK_EQ(s.size(), 3u);
    CHECK_EQ(s[0].id, 7);
    CHECK_EQ(s[0].name, std::string("Kazan dairesi"));
    CHECK_EQ(s[0].unit, std::string("C"));
    CHECK_EQ(s[1].name, std::string("Soğuk oda"));
    CHECK_EQ(s[2].unit, std::string(""));
    CHECK(p.events().empty());
    CHECK_EQ(p.rejected(), 0u);
}

TEST(gizli_pipeline_accepts_device_frames_and_alarms_with_hysteresis) {
    std::istringstream cfg(kConfig);
    Pipeline p(cfg);
    const double kazan[] = {79.0, 80.5, 79.0, 78.0, 80.9, 77.4, 81.0};
    for (double v : kazan) CHECK(p.process(temp(7, v)));
    const auto& e = p.events();
    // 80.5 raises; 79.0, 78.0, 80.9 stay (hysteresis 2.5 → clears below 77.5); 77.4 clears; 81.0 raises again
    CHECK_EQ(e.size(), 3u);
    if (e.size() == 3) {
        CHECK_EQ(e[0].sensor_id, 7);
        CHECK_EQ(e[0].kind, std::string("high"));
        CHECK(e[0].active);
        CHECK_NEAR(e[0].value, 80.5, 1e-9);
        CHECK_EQ(e[0].frame, 1u);
        CHECK(!e[1].active);
        CHECK_NEAR(e[1].value, 77.4, 1e-9);
        CHECK_EQ(e[1].frame, 5u);
        CHECK(e[2].active);
        CHECK_EQ(e[2].frame, 6u);
    }
    const auto& st = p.registry().stats(7);
    CHECK_EQ(st.count(), 7u);
    CHECK_NEAR(st.max(), 81.0, 1e-9);
    CHECK_NEAR(st.min(), 77.4, 1e-9);
}

TEST(gizli_pipeline_low_and_high_alarms) {
    std::istringstream cfg(kConfig);
    Pipeline p(cfg);
    const double oda[] = {-15.0, -18.5, -17.5, -16.9, 3.0, 4.2, 3.5, 2.9};
    for (double v : oda) CHECK(p.process(temp(12, v)));
    const auto& e = p.events();
    // -18.5 low on; -17.5 stays (clears above -17); -16.9 low off; 4.2 high on; 3.5 stays; 2.9 high off
    CHECK_EQ(e.size(), 4u);
    if (e.size() == 4) {
        CHECK_EQ(e[0].kind, std::string("low"));
        CHECK(e[0].active);
        CHECK_EQ(e[0].frame, 1u);
        CHECK_EQ(e[1].kind, std::string("low"));
        CHECK(!e[1].active);
        CHECK_EQ(e[1].frame, 3u);
        CHECK_EQ(e[2].kind, std::string("high"));
        CHECK(e[2].active);
        CHECK_EQ(e[3].kind, std::string("high"));
        CHECK(!e[3].active);
        CHECK_EQ(e[3].frame, 7u);
    }
    // a sensor without alarm rules only collects statistics
    CHECK(p.process(temp(30, 25.0)));
    CHECK_EQ(p.events().size(), 4u);
    CHECK_EQ(p.registry().stats(30).count(), 1u);
}

TEST(gizli_pipeline_rejects_bad_frames_without_crashing) {
    std::istringstream cfg(kConfig);
    Pipeline p(cfg);
    auto good = temp(7, 50.0);
    std::size_t rejected = 0;
    for (std::size_t n = 1; n < good.size(); ++n) {  // truncated on the line
        CHECK(!p.process(std::vector<std::uint8_t>(good.begin(), good.begin() + static_cast<std::ptrdiff_t>(n))));
        ++rejected;
    }
    auto bad = good;
    bad[5] ^= 0x40;
    CHECK(!p.process(bad));  // CRC
    CHECK(!p.process(temp(99, 20.0)));  // unknown sensor
    CHECK(!p.process(device_frame(7, 2, {0x10, 0x27, 0, 0})));  // a pressure frame is not a temperature
    CHECK(!p.process({}));
    rejected += 4;
    CHECK_EQ(p.rejected(), rejected);
    CHECK_EQ(p.registry().stats(7).count(), 0u);
    CHECK(p.process(good));
    CHECK_EQ(p.registry().stats(7).count(), 1u);
}

TEST(gizli_pipeline_config_errors) {
    auto bad = [](const char* text) {
        std::istringstream in(text);
        Pipeline p(in);
    };
    CHECK_THROWS(bad("sensor.7.name = A\nalarm.8.high = 10\n"), std::runtime_error);      // alarm for an unknown sensor
    CHECK_THROWS(bad("sensor.7.name = A\nalarm.7.high = sıcak\n"), std::runtime_error);   // not a number
    CHECK_THROWS(bad("sensor.7.name = A\nalarm.7.hysteresis = -1\n"), std::runtime_error);
    CHECK_THROWS(bad("sensor.70000.name = A\n"), std::runtime_error);                     // id out of range
    CHECK_THROWS(bad("sensor.7.renk = mavi\n"), std::runtime_error);                      // unknown key
    CHECK_THROWS(bad("sensor.7.name = A\nbu satir hatali\n"), std::runtime_error);
    std::istringstream ok("sensor.7.name = A\n");
    Pipeline p(ok);
    CHECK_EQ(p.registry().sensors().size(), 1u);
}
