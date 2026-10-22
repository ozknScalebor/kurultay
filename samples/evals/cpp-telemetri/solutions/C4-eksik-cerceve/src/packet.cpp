#include "telemetri/packet.hpp"

#include <stdexcept>

#include "telemetri/crc16.hpp"

namespace telemetri {

namespace {
constexpr std::uint8_t kStart = 0xAA;

void set_error(std::string* error, const char* msg) {
    if (error) *error = msg;
}
}  // namespace

std::vector<std::uint8_t> encode_packet(const Packet& p) {
    if (p.payload.size() > 250) throw std::invalid_argument("yük çok büyük");
    std::vector<std::uint8_t> out;
    const auto len = static_cast<std::uint8_t>(3 + p.payload.size());
    out.push_back(kStart);
    out.push_back(len);
    out.push_back(static_cast<std::uint8_t>(p.sensor_id & 0xFF));
    out.push_back(static_cast<std::uint8_t>(p.sensor_id >> 8));
    out.push_back(static_cast<std::uint8_t>(p.type));
    out.insert(out.end(), p.payload.begin(), p.payload.end());
    const std::uint16_t crc = crc16_ccitt(out.data() + 1, out.size() - 1);
    out.push_back(static_cast<std::uint8_t>(crc & 0xFF));
    out.push_back(static_cast<std::uint8_t>(crc >> 8));
    return out;
}

std::optional<Packet> parse_packet(const std::vector<std::uint8_t>& buf, std::string* error) {
    if (buf.empty() || buf[0] != kStart) {
        set_error(error, "başlangıç baytı yok");
        return std::nullopt;
    }
    if (buf.size() < 2) {
        set_error(error, "eksik çerçeve");
        return std::nullopt;
    }
    const std::size_t len = buf[1];
    if (len < 3) {
        set_error(error, "geçersiz uzunluk");
        return std::nullopt;
    }
    const std::size_t crc_pos = 2 + len;
    if (buf.size() < crc_pos + 2) {
        set_error(error, "eksik çerçeve");
        return std::nullopt;
    }
    const std::uint16_t expected = static_cast<std::uint16_t>(buf[crc_pos] | (buf[crc_pos + 1] << 8));
    if (crc16_ccitt(buf.data() + 1, len + 1) != expected) {
        set_error(error, "CRC hatası");
        return std::nullopt;
    }
    const std::uint8_t type = buf[4];
    if (type < 1 || type > 3) {
        set_error(error, "bilinmeyen tip");
        return std::nullopt;
    }
    Packet p;
    p.sensor_id = static_cast<std::uint16_t>(buf[2] | (buf[3] << 8));
    p.type = static_cast<MeasureType>(type);
    p.payload.assign(buf.begin() + 5, buf.begin() + static_cast<std::ptrdiff_t>(crc_pos));
    return p;
}

double decode_temperature(const Packet& p) {
    if (p.type != MeasureType::Sicaklik || p.payload.size() != 2) throw std::invalid_argument("sıcaklık paketi değil");
    const auto raw = static_cast<std::int16_t>(p.payload[0] | (p.payload[1] << 8));
    return raw / 100.0;
}

}  // namespace telemetri
