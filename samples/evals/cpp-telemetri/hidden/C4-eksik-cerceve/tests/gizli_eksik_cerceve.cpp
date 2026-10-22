#include "mini_test.hpp"
#include <string>
#include <vector>
#include "telemetri/packet.hpp"

using namespace telemetri;

TEST(gizli_truncated_frames_are_rejected) {
    Packet p;
    p.sensor_id = 3;
    p.type = MeasureType::Basinc;
    p.payload = {1, 2, 3, 4};
    const auto full = encode_packet(p);
    for (std::size_t n = 2; n < full.size(); ++n) {
        const std::vector<std::uint8_t> part(full.begin(), full.begin() + static_cast<std::ptrdiff_t>(n));
        std::string err;
        CHECK(!parse_packet(part, &err).has_value());
        CHECK_EQ(err, std::string("eksik çerçeve"));
    }
    std::string err;
    CHECK(parse_packet(full, &err).has_value());
}

TEST(gizli_trailing_bytes_are_ignored) {
    Packet p;
    p.sensor_id = 9;
    p.type = MeasureType::Nem;
    p.payload = {40};
    auto bytes = encode_packet(p);
    bytes.push_back(0xAA);
    bytes.push_back(0x05);
    CHECK(parse_packet(bytes).has_value());
}
