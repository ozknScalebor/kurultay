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

/// Sensör kaydı ve sensör başına çalışan istatistik.
class SensorRegistry {
public:
    /// Yeni sensör ekler; aynı id zaten kayıtlıysa hiçbir şeyi değiştirmeden false döner.
    bool register_sensor(std::uint16_t id, const std::string& name, const std::string& unit);
    std::optional<SensorInfo> find(std::uint16_t id) const;
    /// Ölçüm ekler; bilinmeyen sensör için std::out_of_range.
    void record(std::uint16_t id, double value);
    const RunningStats& stats(std::uint16_t id) const;
    /// Kayıtlı sensörler, id sırasıyla.
    std::vector<SensorInfo> sensors() const;

private:
    std::map<std::uint16_t, SensorInfo> info_;
    std::map<std::uint16_t, RunningStats> stats_;
};

}  // namespace telemetri
