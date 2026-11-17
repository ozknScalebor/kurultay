#pragma once
#include <cstddef>
#include <cstdint>
#include <istream>
#include <map>
#include <string>
#include <vector>

#include "telemetri/alarm.hpp"
#include "telemetri/sensor_registry.hpp"

namespace telemetri {

struct AlarmEvent {
    std::uint16_t sensor_id = 0;
    std::string kind;  ///< "high" or "low"
    bool active = false;
    double value = 0.0;
    std::size_t frame = 0;  ///< 0-based index of the process() call
};

/// Config file → sensors and alarm rules; frames → statistics and alarm events.
class Pipeline {
public:
    explicit Pipeline(std::istream& config);
    bool process(const std::vector<std::uint8_t>& frame);
    const std::vector<AlarmEvent>& events() const { return events_; }
    const SensorRegistry& registry() const { return registry_; }
    std::size_t rejected() const { return rejected_; }

private:
    struct Rule {
        bool has_high = false, has_low = false;
        double high = 0, low = 0, hysteresis = 0;
        bool high_on = false, low_on = false;
    };
    SensorRegistry registry_;
    std::map<std::uint16_t, Rule> rules_;
    std::vector<AlarmEvent> events_;
    std::size_t rejected_ = 0;
    std::size_t frames_ = 0;
};

}  // namespace telemetri
