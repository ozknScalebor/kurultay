#pragma once

namespace telemetri {

/// Upper-threshold alarm with hysteresis: it is raised when the value goes above `high`
/// and cleared only below `high - hysteresis` (no chattering around the threshold).
class ThresholdAlarm {
public:
    ThresholdAlarm(double high, double hysteresis);

    /// Processes a new reading; returns true when the alarm state changed.
    bool update(double value);
    bool active() const { return active_; }
    int transitions() const { return transitions_; }

private:
    double high_;
    double hysteresis_;
    bool active_ = false;
    int transitions_ = 0;
};

}  // namespace telemetri
