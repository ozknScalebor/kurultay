#pragma once
#include <cstddef>
#include <cstdint>

namespace telemetri {

/// CRC-16/CCITT-FALSE: polinom 0x1021, başlangıç 0xFFFF, yansıtma yok, son XOR yok.
/// Kontrol değeri: "123456789" → 0x29B1.
std::uint16_t crc16_ccitt(const std::uint8_t* data, std::size_t len);

}  // namespace telemetri
