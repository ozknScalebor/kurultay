# Telemetri – proje kuralları (ajanlar için)

- **C++17**, yalnızca standart kütüphane; dış bağımlılık yok. Derleyici: GCC ≥ 9, Clang ≥ 10 veya MSVC 2019+.
- Başlıklar `include/telemetri/`, kaynaklar `src/`; her yeni `.cpp` CMake tarafından otomatik bulunur (GLOB CONFIGURE_DEPENDS).
- Debug derlemesi AddressSanitizer + UBSan ile yapılır: tampon dışı okuma/yazma, tanımsız davranış testleri düşürür.
- Ham `new`/`delete` yok; sahiplik `std::vector`, `std::unique_ptr` ile. Tampon erişimlerinde uzunluk her zaman önce kontrol edilir.
- Testler `tests/` altında, `mini_test.hpp` ile (`TEST(ad) { CHECK(...); CHECK_EQ(a, b); CHECK_NEAR(a, b, eps); CHECK_THROWS(ifade, tür); }`);
  `tests/*.cpp` dosyalarının hepsi tek test programında toplanır.
- Derleme: `cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug && cmake --build build --config Debug -j4`
- Test: `ctest --test-dir build -C Debug --output-on-failure` (CMake yoksa `make test`)
- Hata mesajları Türkçe; public API değişiklikleri başlıkta `///` yorumuyla belgelenir.
