#include "telemetri/report.hpp"

#include <cstdio>

namespace telemetri {

namespace {
std::string field(const std::string& v) {
    if (v.find_first_of(",\"\n") == std::string::npos) return v;
    std::string out = "\"";
    for (char c : v) {
        if (c == '"') out += '"';
        out += c;
    }
    return out + "\"";
}

std::string num(double v) {
    char buf[64];
    std::snprintf(buf, sizeof buf, "%.3f", v);
    return buf;
}
}  // namespace

std::string stats_csv(const SensorRegistry& registry) {
    std::string out = "id,ad,birim,adet,ortalama,min,maks\n";
    for (const auto& s : registry.sensors()) {
        const auto& st = registry.stats(s.id);
        out += std::to_string(s.id) + "," + field(s.name) + "," + field(s.unit) + "," + std::to_string(st.count()) + ",";
        if (st.count()) out += num(st.mean()) + "," + num(st.min()) + "," + num(st.max());
        else out += ",,";
        out += "\n";
    }
    return out;
}

}  // namespace telemetri
