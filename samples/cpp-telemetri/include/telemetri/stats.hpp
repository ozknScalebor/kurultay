#pragma once
#include <cstddef>
#include <limits>

namespace telemetri {

/// Tek geçişte (Welford) istatistik. variance()/stddev() ÖRNEKLEM değerleridir (n-1'e bölünür);
/// 2'den az örnekte 0 döner.
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
