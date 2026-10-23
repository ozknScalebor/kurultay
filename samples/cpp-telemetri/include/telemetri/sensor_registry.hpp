#pragma once
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "telemetri/stats.hpp"

namespace telemetri {

struct SensorInfo {
    std::uint16_t id = 0;
    std::string name;
    std::string unit;
};

/// Sensor registry with running statistics per sensor.
class SensorRegistry {
public:
    /// Adds a new sensor; returns false without changing anything when the id is already registered.
    bool register_sensor(std::uint16_t id, const std::string& name, const std::string& unit);
    std::optional<SensorInfo> find(std::uint16_t id) const;
    /// Adds a reading; std::out_of_range for an unknown sensor.
    void record(std::uint16_t id, double value);
    const RunningStats& stats(std::uint16_t id) const;
    /// Registered sensors in id order.
    std::vector<SensorInfo> sensors() const;

private:
    std::map<std::uint16_t, SensorInfo> info_;
    std::map<std::uint16_t, RunningStats> stats_;
};

}  // namespace telemetri
