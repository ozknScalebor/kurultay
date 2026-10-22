#pragma once
#include <string>

#include "telemetri/sensor_registry.hpp"

namespace telemetri {

/// Sensör istatistikleri CSV olarak: "id,ad,birim,adet,ortalama,min,maks", id sırasıyla, 3 ondalık,
/// ölçümü olmayan sensörde sayısal alanlar boş. Virgül/tırnak içeren alanlar RFC 4180'e göre tırnaklanır.
std::string stats_csv(const SensorRegistry& registry);

}  // namespace telemetri
