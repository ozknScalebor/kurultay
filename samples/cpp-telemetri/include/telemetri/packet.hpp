#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace telemetri {

enum class MeasureType : std::uint8_t { Sicaklik = 1, Basinc = 2, Nem = 3 };

/// One measurement received from a sensor.
struct Packet {
    std::uint16_t sensor_id = 0;
    MeasureType type = MeasureType::Sicaklik;
    std::vector<std::uint8_t> payload;  ///< measurement values (type dependent)
};

/// Frame format (little endian):
///   0xAA | len (1 bayt) | sensor_id (2) | type (1) | payload (len-3 bayt) | crc16 (2)
/// len = length of sensor_id + type + payload; the CRC covers the len byte through the end of the payload.
std::vector<std::uint8_t> encode_packet(const Packet& p);

/// Parses the first frame in the buffer. On error returns nullopt and fills *error (when given) with:
///   "başlangıç baytı yok", "eksik çerçeve", "geçersiz uzunluk", "CRC hatası", "bilinmeyen tip".
std::optional<Packet> parse_packet(const std::vector<std::uint8_t>& buf, std::string* error = nullptr);

/// Temperature payload: int16 (units of 0.01 °C) → °C
double decode_temperature(const Packet& p);

}  // namespace telemetri
