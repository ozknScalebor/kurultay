#include <exception>
#include <initializer_list>
#include <iostream>

#include "mini_test.hpp"

#if defined(_WIN32)
#include <cstdlib>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#if defined(_MSC_VER)
#include <crtdbg.h>
#endif
#endif

// On Windows a failed debug assertion or abort() opens a modal dialog and the test run
// hangs forever (nobody clicks it in CI or under an agent). Report to stderr instead.
static void no_error_dialogs() {
#if defined(_WIN32)
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
#if defined(_MSC_VER)
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
    for (int kind : {_CRT_WARN, _CRT_ERROR, _CRT_ASSERT}) {
        _CrtSetReportMode(kind, _CRTDBG_MODE_FILE | _CRTDBG_MODE_DEBUG);
        _CrtSetReportFile(kind, _CRTDBG_FILE_STDERR);
    }
#endif
#endif
}

int main() {
    no_error_dialogs();
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
