#include "telemetri/crc16.hpp"

namespace telemetri {

std::uint16_t crc16_ccitt(const std::uint8_t* data, std::size_t len) {
    std::uint16_t crc = 0x0000;
    for (std::size_t i = 0; i < len; ++i) {
        crc ^= static_cast<std::uint16_t>(data[i]) << 8;
        for (int b = 0; b < 8; ++b) {
            crc = (crc & 0x8000) ? static_cast<std::uint16_t>((crc << 1) ^ 0x1021) : static_cast<std::uint16_t>(crc << 1);
        }
    }
    return crc;
}

}  // namespace telemetri
