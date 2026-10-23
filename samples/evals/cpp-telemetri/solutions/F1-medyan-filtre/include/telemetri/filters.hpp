#pragma once
#include <cstddef>
#include <deque>

namespace telemetri {

/// Arithmetic mean of the last `window` samples. Before the window is full, the mean of the samples so far.
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

/// Median of the last `window` samples (window must be odd and > 0). Before the window is full, with an even count, the mean of the two middle values.
class MedianFilter {
public:
    explicit MedianFilter(std::size_t window);
    double add(double sample);
    std::size_t count() const { return samples_.size(); }

private:
    std::size_t window_;
    std::deque<double> samples_;
};

/// First-order low-pass filter: y = y + alpha * (x - y); the first sample is taken as is.
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
