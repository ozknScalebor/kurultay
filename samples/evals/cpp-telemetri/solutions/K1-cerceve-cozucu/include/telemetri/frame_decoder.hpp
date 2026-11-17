#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

#include "telemetri/packet.hpp"

namespace telemetri {

/// Splits a serial byte stream (arbitrary chunks, line noise) into packets.
class FrameDecoder {
public:
    std::vector<Packet> feed(const std::uint8_t* data, std::size_t len);
    std::vector<Packet> feed(const std::vector<std::uint8_t>& bytes) { return feed(bytes.data(), bytes.size()); }
    std::size_t buffered() const { return buf_.size(); }
    std::size_t crc_errors() const { return crc_errors_; }
    std::size_t skipped_bytes() const { return skipped_; }

private:
    std::vector<std::uint8_t> buf_;
    std::size_t crc_errors_ = 0;
    std::size_t skipped_ = 0;
};

}  // namespace telemetri
