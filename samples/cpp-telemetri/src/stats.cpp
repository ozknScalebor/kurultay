#include "telemetri/stats.hpp"

#include <cmath>

namespace telemetri {

void RunningStats::add(double x) {
    ++n_;
    const double delta = x - mean_;
    mean_ += delta / static_cast<double>(n_);
    m2_ += delta * (x - mean_);
    if (x < min_) min_ = x;
    if (x > max_) max_ = x;
}

double RunningStats::variance() const {
    if (n_ < 2) return 0.0;
    return m2_ / static_cast<double>(n_);
}

double RunningStats::stddev() const { return std::sqrt(variance()); }

}  // namespace telemetri
