#include "telemetri/windowed_stats.hpp"

#include <cmath>
#include <stdexcept>

namespace telemetri {

WindowedStats::WindowedStats(std::uint64_t window_ms) : window_(window_ms) {
    if (window_ms == 0) throw std::invalid_argument("pencere 0 olamaz");
}

void WindowedStats::check_time(std::uint64_t t) const {
    if (started_ && t < now_) throw std::invalid_argument("zaman geri gidemez");
}

void WindowedStats::add(std::uint64_t t_ms, double value) {
    check_time(t_ms);
    if (std::isnan(value)) throw std::invalid_argument("NaN ölçüm");
    now_ = t_ms;
    started_ = true;
    const S s{t_ms, value, seq_++};
    samples_.push_back(s);
    sum_ += value;
    while (!mins_.empty() && mins_.back().v >= value) mins_.pop_back();
    mins_.push_back(s);
    while (!maxs_.empty() && maxs_.back().v <= value) maxs_.pop_back();
    maxs_.push_back(s);
    expire();
}

void WindowedStats::advance(std::uint64_t now_ms) {
    check_time(now_ms);
    now_ = now_ms;
    started_ = true;
    expire();
}

void WindowedStats::expire() {
    while (!samples_.empty() && samples_.front().t + window_ <= now_) {
        const auto seq = samples_.front().seq;
        sum_ -= samples_.front().v;
        samples_.pop_front();
        if (!mins_.empty() && mins_.front().seq == seq) mins_.pop_front();
        if (!maxs_.empty() && maxs_.front().seq == seq) maxs_.pop_front();
    }
    if (samples_.empty()) sum_ = 0;
}

double WindowedStats::mean() const {
    if (samples_.empty()) throw std::logic_error("pencere boş");
    return static_cast<double>(sum_ / static_cast<long double>(samples_.size()));
}

double WindowedStats::min() const {
    if (samples_.empty()) throw std::logic_error("pencere boş");
    return mins_.front().v;
}

double WindowedStats::max() const {
    if (samples_.empty()) throw std::logic_error("pencere boş");
    return maxs_.front().v;
}

}  // namespace telemetri
