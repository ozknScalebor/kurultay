#pragma once
// Bağımlılıksız mini test çatısı: TEST(ad) { CHECK(...); } — tüm testler tek çalıştırılabilir dosyada toplanır.
#include <cmath>
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace mini {

struct Case {
    const char* name;
    std::function<void()> fn;
};

inline std::vector<Case>& registry() {
    static std::vector<Case> r;
    return r;
}

struct Failure {
    std::string message;
};

struct Registrar {
    Registrar(const char* name, std::function<void()> fn) { registry().push_back({name, std::move(fn)}); }
};

template <typename A, typename B>
void check_eq(const A& a, const B& b, const char* ea, const char* eb, const char* file, int line) {
    if (!(a == b)) {
        std::ostringstream os;
        os << file << ":" << line << ": CHECK_EQ(" << ea << ", " << eb << ") beklenen " << b << " ama " << a;
        throw Failure{os.str()};
    }
}

}  // namespace mini

#define MINI_CAT2(a, b) a##b
#define MINI_CAT(a, b) MINI_CAT2(a, b)
#define TEST(name)                                                              \
    static void name();                                                         \
    static ::mini::Registrar MINI_CAT(mini_reg_, name)(#name, &name);           \
    static void name()

#define CHECK(cond)                                                                                                  \
    do {                                                                                                             \
        if (!(cond)) throw ::mini::Failure{std::string(__FILE__) + ":" + std::to_string(__LINE__) + ": CHECK(" #cond ")"}; \
    } while (0)

#define CHECK_EQ(a, b) ::mini::check_eq((a), (b), #a, #b, __FILE__, __LINE__)

#define CHECK_NEAR(a, b, eps)                                                                                        \
    do {                                                                                                             \
        const double mini_a = (a), mini_b = (b);                                                                     \
        if (std::fabs(mini_a - mini_b) > (eps)) {                                                                    \
            std::ostringstream mini_os;                                                                              \
            mini_os << __FILE__ << ":" << __LINE__ << ": CHECK_NEAR(" #a ", " #b ") " << mini_a << " != " << mini_b; \
            throw ::mini::Failure{mini_os.str()};                                                                    \
        }                                                                                                            \
    } while (0)

#define CHECK_THROWS(expr, type)                                                                                      \
    do {                                                                                                              \
        bool mini_thrown = false;                                                                                     \
        try {                                                                                                         \
            (void)(expr);                                                                                             \
        } catch (const type&) {                                                                                       \
            mini_thrown = true;                                                                                       \
        }                                                                                                             \
        if (!mini_thrown) throw ::mini::Failure{std::string(__FILE__) + ":" + std::to_string(__LINE__) + ": " #type " fırlatılmadı"}; \
    } while (0)
