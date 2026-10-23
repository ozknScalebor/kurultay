// Demo: builds a few temperature packets, parses and records them, prints a summary.
#include <iomanip>
#include <iostream>

#include "telemetri/alarm.hpp"
#include "telemetri/filters.hpp"
#include "telemetri/packet.hpp"
#include "telemetri/sensor_registry.hpp"

using namespace telemetri;

int main() {
    SensorRegistry reg;
    reg.register_sensor(7, "Kazan dairesi", "°C");
    MovingAverage avg(4);
    ThresholdAlarm alarm(80.0, 2.0);
    const double readings[] = {71.5, 76.0, 80.4, 79.9, 80.2, 77.0, 74.3};
    for (double r : readings) {
        Packet p;
        p.sensor_id = 7;
        p.type = MeasureType::Sicaklik;
        const auto raw = static_cast<std::int16_t>(r * 100);
        p.payload = {static_cast<std::uint8_t>(raw & 0xFF), static_cast<std::uint8_t>((raw >> 8) & 0xFF)};
        std::string err;
        const auto parsed = parse_packet(encode_packet(p), &err);
        if (!parsed) {
            std::cerr << "çözülemedi: " << err << "\n";
            return 1;
        }
        const double t = decode_temperature(*parsed);
        reg.record(parsed->sensor_id, t);
        if (alarm.update(t)) std::cout << (alarm.active() ? "ALARM " : "normal ") << t << "\n";
        std::cout << std::fixed << std::setprecision(2) << "ölçüm " << t << "  ort " << avg.add(t) << "\n";
    }
    const auto& s = reg.stats(7);
    std::cout << "adet " << s.count() << " ortalama " << s.mean() << " std " << s.stddev() << "\n";
    return 0;
}
