#pragma once

namespace telemetri {

/// Histerezisli üst eşik alarmı: değer `high` üstüne çıkınca alarm kurulur,
/// ancak `high - hysteresis` altına inince kalkar (eşik çevresinde sürekli açılıp kapanmaz).
class ThresholdAlarm {
public:
    ThresholdAlarm(double high, double hysteresis);

    /// Yeni ölçümü işler; alarm durumu değiştiyse true döner.
    bool update(double value);
    bool active() const { return active_; }
    int transitions() const { return transitions_; }

private:
    double high_;
    double hysteresis_;
    bool active_ = false;
    int transitions_ = 0;
};

}  // namespace telemetri
