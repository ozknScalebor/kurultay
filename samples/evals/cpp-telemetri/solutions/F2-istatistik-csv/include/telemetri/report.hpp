#pragma once
#include <string>

#include "telemetri/sensor_registry.hpp"

namespace telemetri {

/// Sensor statistics as CSV: "id,ad,birim,adet,ortalama,min,maks", in id order, 3 decimals,
/// numeric fields empty for a sensor without readings. Fields with commas/quotes are quoted per RFC 4180.
std::string stats_csv(const SensorRegistry& registry);

}  // namespace telemetri
