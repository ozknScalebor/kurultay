#pragma once
#include <cstddef>
#include <deque>

namespace telemetri {

/// Son `window` örneğin aritmetik ortalaması. Pencere dolmadan önce o ana kadarki örneklerin ortalaması döner.
class MovingAverage {
public:
    explicit MovingAverage(std::size_t window);
    double add(double sample);
    double value() const;
    std::size_t count() const { return samples_.size(); }

private:
    std::size_t window_;
    std::deque<double> samples_;
    double sum_ = 0.0;
};

/// Birinci dereceden alçak geçiren filtre: y = y + alpha * (x - y); ilk örnek doğrudan alınır.
class LowPass {
public:
    explicit LowPass(double alpha);
    double add(double sample);
    double value() const { return y_; }

private:
    double alpha_;
    double y_ = 0.0;
    bool started_ = false;
};

}  // namespace telemetri
