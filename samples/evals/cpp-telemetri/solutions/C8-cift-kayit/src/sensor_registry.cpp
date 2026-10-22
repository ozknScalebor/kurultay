#include "telemetri/sensor_registry.hpp"

#include <stdexcept>

namespace telemetri {

bool SensorRegistry::register_sensor(std::uint16_t id, const std::string& name, const std::string& unit) {
    if (name.empty()) throw std::invalid_argument("sensör adı boş olamaz");
    if (info_.find(id) != info_.end()) return false;
    info_[id] = SensorInfo{id, name, unit};
    stats_[id];
    return true;
}

std::optional<SensorInfo> SensorRegistry::find(std::uint16_t id) const {
    const auto it = info_.find(id);
    if (it == info_.end()) return std::nullopt;
    return it->second;
}

void SensorRegistry::record(std::uint16_t id, double value) {
    const auto it = stats_.find(id);
    if (it == stats_.end()) throw std::out_of_range("bilinmeyen sensör: " + std::to_string(id));
    it->second.add(value);
}

const RunningStats& SensorRegistry::stats(std::uint16_t id) const {
    const auto it = stats_.find(id);
    if (it == stats_.end()) throw std::out_of_range("bilinmeyen sensör: " + std::to_string(id));
    return it->second;
}

std::vector<SensorInfo> SensorRegistry::sensors() const {
    std::vector<SensorInfo> out;
    for (const auto& kv : info_) out.push_back(kv.second);
    return out;
}

}  // namespace telemetri
