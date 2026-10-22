#include <exception>
#include <iostream>

#include "mini_test.hpp"

int main() {
    int failed = 0;
    for (const auto& c : mini::registry()) {
        try {
            c.fn();
            std::cout << "  [OK]   " << c.name << "\n";
        } catch (const mini::Failure& f) {
            ++failed;
            std::cout << "  [HATA] " << c.name << ": " << f.message << "\n";
        } catch (const std::exception& e) {
            ++failed;
            std::cout << "  [HATA] " << c.name << ": beklenmeyen istisna: " << e.what() << "\n";
        }
    }
    std::cout << mini::registry().size() << " test, " << failed << " hata\n";
    return failed == 0 ? 0 : 1;
}
