#pragma once
#include <istream>
#include <map>
#include <string>

namespace telemetri {

/// `anahtar = değer` satırları. Boş satırlar ve '#' ile başlayan satırlar yok sayılır;
/// satır sonundaki "# yorum" kısmı değere dahil değildir; anahtar ve değerin çevresindeki boşluklar atılır.
/// '=' içermeyen satır std::runtime_error fırlatır (mesajda satır numarası bulunur).
std::map<std::string, std::string> parse_config(std::istream& in);

/// Sayısal değer; anahtar yoksa `fallback`.
int config_int(const std::map<std::string, std::string>& cfg, const std::string& key, int fallback);

}  // namespace telemetri
