#include <algorithm>
#include <string>
#include <vector>

#include "mini_test.hpp"
#include "telemetri/frame_decoder.hpp"
#include "telemetri/packet.hpp"

using namespace telemetri;

namespace {
Packet temp(std::uint16_t id, std::int16_t centi) {
    Packet p;
    p.sensor_id = id;
    p.type = MeasureType::Sicaklik;
    p.payload = {static_cast<std::uint8_t>(centi & 0xFF), static_cast<std::uint8_t>((centi >> 8) & 0xFF)};
    return p;
}

void append(std::vector<std::uint8_t>& out, const std::vector<std::uint8_t>& b) { out.insert(out.end(), b.begin(), b.end()); }

bool has_start_after_first(const std::vector<std::uint8_t>& f) {
    for (std::size_t i = 1; i < f.size(); ++i)
        if (f[i] == 0xAA) return true;
    return false;
}
}  // namespace

TEST(gizli_decoder_reassembles_split_frames) {
    FrameDecoder d;
    const auto f = encode_packet(temp(7, 2150));
    auto out = d.feed(f.data(), 5);
    CHECK(out.empty());
    CHECK_EQ(d.buffered(), 5u);
    out = d.feed(f.data() + 5, f.size() - 5);
    CHECK_EQ(out.size(), 1u);
    CHECK_EQ(out[0].sensor_id, 7);
    CHECK_NEAR(decode_temperature(out[0]), 21.50, 1e-9);
    CHECK_EQ(d.buffered(), 0u);
    CHECK_EQ(d.crc_errors(), 0u);
    CHECK_EQ(d.skipped_bytes(), 0u);
}

TEST(gizli_decoder_survives_noise_and_bad_frames) {
    std::vector<std::uint8_t> stream = {0x00, 0x13, 0x55, 0xFF, 0x01};  // line noise
    std::size_t expected_skipped = 5;
    stream.push_back(0xAA);  // a start byte with an impossible length
    stream.push_back(0x01);
    expected_skipped += 2;
    std::vector<Packet> sent;
    for (int i = 0; i < 3; ++i) {
        sent.push_back(temp(static_cast<std::uint16_t>(10 + i), static_cast<std::int16_t>(1000 + i)));
        append(stream, encode_packet(sent.back()));
    }
    auto bad = encode_packet(temp(99, 1234));
    bad[5] ^= 0x01;  // corrupted on the line
    append(stream, bad);
    const bool exact = !has_start_after_first(bad);
    if (exact) expected_skipped += bad.size();
    // a start byte whose length (200) swallows the following frames until the CRC fails
    stream.push_back(0xAA);
    stream.push_back(200);
    expected_skipped += 2;
    for (int i = 0; i < 40; ++i) {
        sent.push_back(temp(static_cast<std::uint16_t>(20 + i), static_cast<std::int16_t>(-500 + 25 * i)));
        append(stream, encode_packet(sent.back()));
    }

    for (std::size_t chunk : {std::size_t(1), std::size_t(3), std::size_t(7), std::size_t(64), stream.size()}) {
        FrameDecoder d;
        std::vector<Packet> got;
        for (std::size_t i = 0; i < stream.size(); i += chunk) {
            const std::size_t n = std::min(chunk, stream.size() - i);
            const auto part = d.feed(stream.data() + i, n);
            got.insert(got.end(), part.begin(), part.end());
        }
        CHECK_EQ(got.size(), sent.size());
        for (std::size_t i = 0; i < got.size() && i < sent.size(); ++i) {
            CHECK_EQ(got[i].sensor_id, sent[i].sensor_id);
            CHECK(got[i].payload == sent[i].payload);
        }
        CHECK_EQ(d.buffered(), 0u);
        if (exact) {
            CHECK_EQ(d.crc_errors(), 2u);
            CHECK_EQ(d.skipped_bytes(), expected_skipped);
        } else {
            CHECK(d.crc_errors() >= 2u);
        }
    }
}

TEST(gizli_decoder_vector_overload_and_unknown_type) {
    FrameDecoder d;
    const auto good = encode_packet(temp(5, 100));
    Packet u = temp(6, 200);
    u.type = static_cast<MeasureType>(9);  // valid frame, unknown measurement type
    const auto unknown = encode_packet(u);
    std::vector<std::uint8_t> stream;
    append(stream, good);
    append(stream, unknown);
    append(stream, good);
    const auto out = d.feed(stream);
    CHECK_EQ(out.size(), 2u);
    CHECK_EQ(out[1].sensor_id, 5);
    CHECK_EQ(d.crc_errors(), 0u);
    if (!has_start_after_first(unknown)) CHECK_EQ(d.skipped_bytes(), unknown.size());
    CHECK(d.feed(std::vector<std::uint8_t>{}).empty());
    CHECK_EQ(d.buffered(), 0u);
}
