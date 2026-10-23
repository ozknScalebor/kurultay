# Telemetri (C++17 örnek proje)

Kurultay'ı denemek için hazırlanmış, orta büyüklükte bir **sensör telemetrisi** kütüphanesi:
ikili paket çerçeveleme (CRC-16), dairesel tampon, hareketli ortalama / alçak geçiren filtre, histerezisli eşik alarmı,
Welford istatistiği, ayar dosyası okuyucu ve sensör kaydı. CMake + CTest, Debug'da ASan/UBSan.

İçine bilerek **8 hata** bırakıldı ve **2 özellik** eksik — liste [GOREVLER.md](GOREVLER.md) dosyasında.
Mevcut testlerin hepsi geçer; hatalar test edilmeyen yollarda.

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build --config Debug -j4
ctest --test-dir build -C Debug --output-on-failure
./build/telemetri_demo
# CMake yoksa:  make test
```

`compile_commands.json` otomatik üretilir; Kurultay her düzenlemeden sonra bu bayraklarla `-fsyntax-only` kontrolü yapar
(clangd kuruluysa `config.lsp.servers` ile LSP tanılamaları da kullanılabilir).

| Modül | Dosyalar |
|---|---|
| Paket çerçeveleme | `packet.hpp/.cpp`, `crc16.hpp/.cpp` |
| Tampon ve filtreler | `ring_buffer.hpp`, `filters.hpp/.cpp` |
| Alarm ve istatistik | `alarm.hpp/.cpp`, `stats.hpp/.cpp` |
| Ayarlar ve kayıt | `config.hpp/.cpp`, `sensor_registry.hpp/.cpp` |

Ölçüm için: `kurultay eval samples/evals/cpp-telemetri --modes single,race`.
