#include "telemetri/pipeline.hpp"

#include <stdexcept>

#include "telemetri/config.hpp"
#include "telemetri/packet.hpp"

namespace telemetri {

namespace {
double number(const std::string& key, const std::string& text) {
    std::size_t used = 0;
    double v = 0;
    try {
        v = std::stod(text, &used);
    } catch (const std::exception&) {
        throw std::runtime_error(key + ": sayı değil: " + text);
    }
    if (used != text.size()) throw std::runtime_error(key + ": sayı değil: " + text);
    return v;
}

std::uint16_t sensor_id(const std::string& key, const std::string& text) {
    std::size_t used = 0;
    long v = -1;
    try {
        v = std::stol(text, &used);
    } catch (const std::exception&) {
        throw std::runtime_error(key + ": geçersiz sensör no");
    }
    if (used != text.size() || v < 0 || v > 65535) throw std::runtime_error(key + ": geçersiz sensör no");
    return static_cast<std::uint16_t>(v);
}
}  // namespace

Pipeline::Pipeline(std::istream& config) {
    const auto cfg = parse_config(config);
    std::map<std::uint16_t, std::map<std::string, std::string>> sensors, alarms;
    for (const auto& kv : cfg) {
        const auto& key = kv.first;
        const auto d1 = key.find('.');
        const auto d2 = d1 == std::string::npos ? std::string::npos : key.find('.', d1 + 1);
        if (d2 == std::string::npos) throw std::runtime_error("bilinmeyen anahtar: " + key);
        const std::string group = key.substr(0, d1), field = key.substr(d2 + 1);
        const auto id = sensor_id(key, key.substr(d1 + 1, d2 - d1 - 1));
        if (group == "sensor" && (field == "name" || field == "unit")) sensors[id][field] = kv.second;
        else if (group == "alarm" && (field == "high" || field == "low" || field == "hysteresis")) alarms[id][field] = kv.second;
        else throw std::runtime_error("bilinmeyen anahtar: " + key);
    }
    for (const auto& s : sensors) {
        const auto name = s.second.find("name");
        if (name == s.second.end()) throw std::runtime_error("sensor." + std::to_string(s.first) + ".name eksik");
        const auto unit = s.second.find("unit");
        registry_.register_sensor(s.first, name->second, unit == s.second.end() ? "" : unit->second);
    }
    for (const auto& a : alarms) {
        if (!registry_.find(a.first)) throw std::runtime_error("alarm." + std::to_string(a.first) + ": tanımsız sensör");
        Rule r;
        for (const auto& f : a.second) {
            const double v = number("alarm." + std::to_string(a.first) + "." + f.first, f.second);
            if (f.first == "high") r.has_high = true, r.high = v;
            else if (f.first == "low") r.has_low = true, r.low = v;
            else {
                if (v < 0) throw std::runtime_error("histerezis negatif olamaz");
                r.hysteresis = v;
            }
        }
        rules_[a.first] = r;
    }
}

bool Pipeline::process(const std::vector<std::uint8_t>& frame) {
    const std::size_t index = frames_++;
    const auto p = parse_packet(frame);
    if (!p || p->type != MeasureType::Sicaklik || p->payload.size() != 2 || !registry_.find(p->sensor_id)) {
        ++rejected_;
        return false;
    }
    const double t = decode_temperature(*p);
    registry_.record(p->sensor_id, t);
    const auto it = rules_.find(p->sensor_id);
    if (it == rules_.end()) return true;
    Rule& r = it->second;
    if (r.has_high) {
        const bool next = r.high_on ? !(t < r.high - r.hysteresis) : t > r.high;
        if (next != r.high_on) events_.push_back({p->sensor_id, "high", next, t, index});
        r.high_on = next;
    }
    if (r.has_low) {
        const bool next = r.low_on ? !(t > r.low + r.hysteresis) : t < r.low;
        if (next != r.low_on) events_.push_back({p->sensor_id, "low", next, t, index});
        r.low_on = next;
    }
    return true;
}

}  // namespace telemetri
