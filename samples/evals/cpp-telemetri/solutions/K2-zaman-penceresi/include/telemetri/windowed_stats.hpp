#pragma once
#include <cstddef>
#include <cstdint>
#include <deque>

namespace telemetri {

/// Statistics of the samples of the last `window_ms` milliseconds: a sample at time t is in
/// the window while t > now - window_ms (now = newest time seen). Amortised O(1) per call.
class WindowedStats {
public:
    explicit WindowedStats(std::uint64_t window_ms);
    void add(std::uint64_t t_ms, double value);
    void advance(std::uint64_t now_ms);
    std::size_t count() const { return samples_.size(); }
    double mean() const;
    double min() const;
    double max() const;

private:
    struct S {
        std::uint64_t t;
        double v;
        std::uint64_t seq;
    };
    void expire();
    void check_time(std::uint64_t t) const;
    std::uint64_t window_;
    std::uint64_t now_ = 0;
    bool started_ = false;
    std::uint64_t seq_ = 0;
    std::deque<S> samples_;
    std::deque<S> mins_;
    std::deque<S> maxs_;
    long double sum_ = 0;
};

}  // namespace telemetri
