#pragma once
#include <cstddef>
#include <limits>

namespace telemetri {

/// Single-pass (Welford) statistics. variance()/stddev() are SAMPLE values (divided by n-1);
/// 0 with fewer than 2 samples.
class RunningStats {
public:
    void add(double x);
    std::size_t count() const { return n_; }
    double mean() const { return mean_; }
    double min() const { return min_; }
    double max() const { return max_; }
    double variance() const;
    double stddev() const;

private:
    std::size_t n_ = 0;
    double mean_ = 0.0;
    double m2_ = 0.0;
    double min_ = std::numeric_limits<double>::infinity();
    double max_ = -std::numeric_limits<double>::infinity();
};

}  // namespace telemetri
