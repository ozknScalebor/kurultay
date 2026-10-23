#pragma once
#include <cstddef>
#include <cstdint>

namespace telemetri {

/// CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR.
/// Check value: "123456789" → 0x29B1.
std::uint16_t crc16_ccitt(const std::uint8_t* data, std::size_t len);

}  // namespace telemetri
