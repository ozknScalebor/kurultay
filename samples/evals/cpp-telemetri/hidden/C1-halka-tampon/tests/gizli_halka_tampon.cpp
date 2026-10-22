#include "mini_test.hpp"
#include <vector>
#include "telemetri/ring_buffer.hpp"

using namespace telemetri;

TEST(gizli_ring_buffer_overwrites_oldest) {
    RingBuffer<int> rb(3);
    for (int i = 1; i <= 5; ++i) rb.push(i);
    CHECK_EQ(rb.size(), 3u);
    CHECK(rb.to_vector() == (std::vector<int>{3, 4, 5}));
    CHECK_EQ(rb.at(0), 3);
    CHECK_EQ(rb.pop(), 3);
    rb.push(6);
    rb.push(7);
    CHECK(rb.to_vector() == (std::vector<int>{5, 6, 7}));
}
