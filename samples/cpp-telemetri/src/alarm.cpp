#include "telemetri/alarm.hpp"

#include <stdexcept>

namespace telemetri {

ThresholdAlarm::ThresholdAlarm(double high, double hysteresis) : high_(high), hysteresis_(hysteresis) {
    if (hysteresis < 0.0) throw std::invalid_argument("histerezis negatif olamaz");
}

bool ThresholdAlarm::update(double value) {
    bool next = active_;
    if (!active_ && value > high_) next = true;
    if (active_ && value < high_) next = false;
    if (next == active_) return false;
    active_ = next;
    ++transitions_;
    return true;
}

}  // namespace telemetri
