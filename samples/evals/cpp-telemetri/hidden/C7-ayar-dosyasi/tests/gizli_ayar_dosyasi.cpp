#include "mini_test.hpp"
#include <sstream>
#include <string>
#include "telemetri/config.hpp"

using namespace telemetri;

TEST(gizli_config_trims_and_strips_comments) {
    std::istringstream in("  # girintili yorum\n port = 8080   # servis portu\nad = Kazan dairesi\r\nbos =\n\t esik=\t75 \n");
    const auto cfg = parse_config(in);
    CHECK_EQ(cfg.size(), 4u);
    CHECK_EQ(cfg.at("port"), std::string("8080"));
    CHECK_EQ(config_int(cfg, "port", 0), 8080);
    CHECK_EQ(cfg.at("ad"), std::string("Kazan dairesi"));
    CHECK_EQ(cfg.at("bos"), std::string(""));
    CHECK_EQ(config_int(cfg, "esik", 0), 75);
}
