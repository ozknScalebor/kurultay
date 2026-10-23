#pragma once
#include <istream>
#include <map>
#include <string>

namespace telemetri {

/// `key = value` lines. Empty lines and lines starting with '#' are ignored;
/// a trailing "# comment" is not part of the value; whitespace around keys and values is trimmed.
/// A line without '=' throws std::runtime_error (the message contains the line number).
std::map<std::string, std::string> parse_config(std::istream& in);

/// Integer value; `fallback` when the key is missing.
int config_int(const std::map<std::string, std::string>& cfg, const std::string& key, int fallback);

}  // namespace telemetri
