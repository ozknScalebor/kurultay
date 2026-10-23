#include "mini_test.hpp"
#include <string>
#include <vector>
#include "telemetri/crc16.hpp"
#include "telemetri/packet.hpp"

using namespace telemetri;

TEST(gizli_crc_check_value) {
    const std::string s = "123456789";
    CHECK_EQ(crc16_ccitt(reinterpret_cast<const std::uint8_t*>(s.data()), s.size()), 0x29B1);
}

TEST(gizli_frame_from_a_real_device) {
    // sensor 0x0007, temperature 21.50 °C — the bytes sent by a device in the field
    const std::vector<std::uint8_t> frame{0xAA, 0x05, 0x07, 0x00, 0x01, 0x66, 0x08, 0x71, 0x3D};
    std::string err;
    const auto p = parse_packet(frame, &err);
    CHECK(p.has_value());
    CHECK_NEAR(decode_temperature(*p), 21.5, 1e-9);
}
