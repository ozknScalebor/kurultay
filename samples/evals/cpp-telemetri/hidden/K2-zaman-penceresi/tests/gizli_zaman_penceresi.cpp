#include <chrono>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>

#include "mini_test.hpp"
#include "telemetri/windowed_stats.hpp"

using namespace telemetri;

namespace {
struct Sample {
    std::uint64_t t;
    double v;
};

// reference: everything with t > newest - window (newest included)
void brute(const std::vector<Sample>& all, std::uint64_t now, std::uint64_t window, std::size_t& n, double& mean, double& mn, double& mx) {
    n = 0;
    double sum = 0;
    mn = std::numeric_limits<double>::infinity();
    mx = -mn;
    for (const auto& s : all) {
        if (s.t + window > now && s.t <= now) {
            ++n;
            sum += s.v;
            mn = std::min(mn, s.v);
            mx = std::max(mx, s.v);
        }
    }
    mean = n ? sum / static_cast<double>(n) : 0.0;
}
}  // namespace

TEST(gizli_window_basic) {
    WindowedStats w(1000);
    CHECK_EQ(w.count(), 0u);
    CHECK_THROWS(w.mean(), std::logic_error);
    CHECK_THROWS(w.min(), std::logic_error);
    w.add(0, 10.0);
    w.add(500, 20.0);
    w.add(999, 30.0);
    CHECK_EQ(w.count(), 3u);
    CHECK_NEAR(w.mean(), 20.0, 1e-12);
    w.add(1000, 40.0);  // the sample at t=0 is now exactly one window old: it leaves
    CHECK_EQ(w.count(), 3u);
    CHECK_NEAR(w.mean(), 30.0, 1e-12);
    CHECK_NEAR(w.min(), 20.0, 1e-12);
    CHECK_NEAR(w.max(), 40.0, 1e-12);
    w.add(1000, 5.0);  // equal timestamps are allowed
    CHECK_NEAR(w.min(), 5.0, 1e-12);
    w.advance(1999);  // time passes without samples
    CHECK_EQ(w.count(), 2u);
    CHECK_NEAR(w.max(), 40.0, 1e-12);
    w.advance(2000);
    CHECK_EQ(w.count(), 0u);
    CHECK_THROWS(w.max(), std::logic_error);
    CHECK_THROWS(w.add(1500, 1.0), std::invalid_argument);   // time goes backwards
    CHECK_THROWS(w.advance(10), std::invalid_argument);
    CHECK_THROWS(w.add(3000, std::nan("")), std::invalid_argument);
    CHECK_THROWS(WindowedStats(0), std::invalid_argument);
    w.add(3000, -2.5);
    CHECK_EQ(w.count(), 1u);
    CHECK_NEAR(w.mean(), -2.5, 1e-12);
}

TEST(gizli_window_matches_brute_force) {
    std::uint32_t seed = 12345;
    auto rnd = [&seed]() {
        seed = seed * 1664525u + 1013904223u;
        return seed;
    };
    for (std::uint64_t window : {std::uint64_t(1), std::uint64_t(7), std::uint64_t(50), std::uint64_t(400)}) {
        WindowedStats w(window);
        std::vector<Sample> all;
        std::uint64_t t = 0;
        for (int i = 0; i < 3000; ++i) {
            t += rnd() % 4;  // often equal, sometimes jumps
            const double v = (static_cast<double>(rnd() % 200001) - 100000.0) / 100.0;
            if (rnd() % 10 == 0) {
                t += rnd() % (2 * window + 1);
                w.advance(t);
            }
            w.add(t, v);
            all.push_back({t, v});
            std::size_t n;
            double mean, mn, mx;
            brute(all, t, window, n, mean, mn, mx);
            CHECK_EQ(w.count(), n);
            CHECK_NEAR(w.mean(), mean, 1e-6);
            CHECK_EQ(w.min(), mn);
            CHECK_EQ(w.max(), mx);
        }
    }
}

TEST(gizli_window_is_fast) {
    // 300k samples, ~5000 in the window: an O(window) recomputation per sample is far too slow
    WindowedStats w(5000);
    const auto t0 = std::chrono::steady_clock::now();
    double acc = 0;
    for (std::uint64_t i = 0; i < 300000; ++i) {
        w.add(i, static_cast<double>((i * 7919) % 1000));
        acc += w.max() - w.min() + w.mean();
    }
    const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    CHECK(acc > 0);
    CHECK_EQ(w.count(), 5000u);
    CHECK(secs < 6.0);
}
