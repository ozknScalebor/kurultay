#include "telemetri/config.hpp"

#include <stdexcept>

namespace telemetri {

std::map<std::string, std::string> parse_config(std::istream& in) {
    std::map<std::string, std::string> out;
    std::string line;
    int no = 0;
    while (std::getline(in, line)) {
        ++no;
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty() || line[0] == '#') continue;
        const auto eq = line.find('=');
        if (eq == std::string::npos) throw std::runtime_error("satır " + std::to_string(no) + ": '=' bekleniyordu");
        out[line.substr(0, eq)] = line.substr(eq + 1);
    }
    return out;
}

int config_int(const std::map<std::string, std::string>& cfg, const std::string& key, int fallback) {
    const auto it = cfg.find(key);
    if (it == cfg.end()) return fallback;
    std::size_t used = 0;
    const int v = std::stoi(it->second, &used);
    if (used != it->second.size()) throw std::runtime_error(key + ": sayı değil: " + it->second);
    return v;
}

}  // namespace telemetri
