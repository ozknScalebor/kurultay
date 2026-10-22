#pragma once
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace telemetri {

enum class MeasureType : std::uint8_t { Sicaklik = 1, Basinc = 2, Nem = 3 };

/// Sensörden gelen tek ölçüm.
struct Packet {
    std::uint16_t sensor_id = 0;
    MeasureType type = MeasureType::Sicaklik;
    std::vector<std::uint8_t> payload;  ///< ölçüm değerleri (tip bağımlı)
};

/// Çerçeve biçimi (küçük-endian):
///   0xAA | len (1 bayt) | sensor_id (2) | type (1) | payload (len-3 bayt) | crc16 (2)
/// len = sensor_id + type + payload uzunluğu; CRC, len baytından payload sonuna kadar hesaplanır.
std::vector<std::uint8_t> encode_packet(const Packet& p);

/// Tampondaki ilk çerçeveyi çözer. Hata durumunda nullopt döner ve (verildiyse) *error doldurulur:
///   "başlangıç baytı yok", "eksik çerçeve", "geçersiz uzunluk", "CRC hatası", "bilinmeyen tip".
std::optional<Packet> parse_packet(const std::vector<std::uint8_t>& buf, std::string* error = nullptr);

/// Sıcaklık yükü: int16 (0.01 °C birimi) → °C
double decode_temperature(const Packet& p);

}  // namespace telemetri
