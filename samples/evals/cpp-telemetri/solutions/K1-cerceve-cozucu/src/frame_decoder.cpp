#include "telemetri/frame_decoder.hpp"

#include <string>

namespace telemetri {

std::vector<Packet> FrameDecoder::feed(const std::uint8_t* data, std::size_t len) {
    buf_.insert(buf_.end(), data, data + len);
    std::vector<Packet> out;
    std::size_t pos = 0;
    for (;;) {
        while (pos < buf_.size() && buf_[pos] != 0xAA) {
            ++pos;
            ++skipped_;
        }
        if (buf_.size() - pos < 2) break;
        const std::size_t flen = buf_[pos + 1];
        if (flen < 3) {
            ++pos;
            ++skipped_;
            continue;
        }
        const std::size_t total = 2 + flen + 2;
        if (buf_.size() - pos < total) break;
        const std::vector<std::uint8_t> frame(buf_.begin() + static_cast<std::ptrdiff_t>(pos), buf_.begin() + static_cast<std::ptrdiff_t>(pos + total));
        std::string err;
        auto p = parse_packet(frame, &err);
        if (p) {
            out.push_back(*p);
            pos += total;
        } else if (err == "CRC hatası") {
            ++crc_errors_;
            ++pos;
            ++skipped_;
        } else {
            pos += total;
            skipped_ += total;
        }
    }
    buf_.erase(buf_.begin(), buf_.begin() + static_cast<std::ptrdiff_t>(pos));
    return out;
}

}  // namespace telemetri
