#include "telemetri/filters.hpp"

#include <stdexcept>

namespace telemetri {

MovingAverage::MovingAverage(std::size_t window) : window_(window) {
    if (window == 0) throw std::invalid_argument("pencere 0 olamaz");
}

double MovingAverage::add(double sample) {
    samples_.push_back(sample);
    sum_ += sample;
    if (samples_.size() > window_) {
        sum_ -= samples_.front();
        samples_.pop_front();
    }
    return value();
}

double MovingAverage::value() const {
    if (samples_.empty()) return 0.0;
    return sum_ / static_cast<double>(window_);
}

LowPass::LowPass(double alpha) : alpha_(alpha) {
    if (alpha <= 0.0 || alpha > 1.0) throw std::invalid_argument("alpha (0, 1] aralığında olmalı");
}

double LowPass::add(double sample) {
    if (!started_) {
        y_ = sample;
        started_ = true;
    } else {
        y_ += alpha_ * (sample - y_);
    }
    return y_;
}

}  // namespace telemetri
