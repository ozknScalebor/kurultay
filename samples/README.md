# Örnek projeler ve görev setleri

Kurultay'ı kendi modellerinizle denemek için iki orta büyüklükte, **bilerek hatalı** proje:

| Proje | Dil / derleme | Hata | Özellik | Görev listesi |
|---|---|---|---|---|
| [java-envanter](java-envanter/) | Java 8, bağımlılıksız `tools/Build.java` (JDK yeterli) | 8 | 2 | [GOREVLER.md](java-envanter/GOREVLER.md) |
| [cpp-telemetri](cpp-telemetri/) | C++17, CMake + CTest, ASan/UBSan | 8 | 2 | [GOREVLER.md](cpp-telemetri/GOREVLER.md) |

Her projede mevcut testler geçer; hatalar test edilmeyen yollardadır. Görevler kullanıcı bildirimi gibi yazılmıştır.

## Elle deneme

```bash
cd samples/java-envanter        # veya samples/cpp-telemetri
kurultay                        # konsol; çalışma alanı = bu klasör
```

Projelerdeki `kurultay.config.json` yalnızca derleme/test komutlarını içerir; endpoint'ler sizin `~/.kurultay/config.json`
dosyanızdan alınır. Değişiklikleri geri almak için `/rewind` ya da `git checkout samples/`.

## Ölçerek deneme (gizli testler)

`evals/` altındaki görev setleri her görevi projenin **temiz bir kopyasında** çalıştırır, ajan bitirince gizli testleri ekler
ve sonucu mod bazında (başarı, istek, token, süre) raporlar:

```bash
kurultay eval samples/evals/java-envanter --modes single,race,council --out eval-sonuc
kurultay eval samples/evals/cpp-telemetri --tasks C2-crc,C4-eksik-cerceve --repeat 3
kurultay eval samples/evals/cpp-telemetri --validate   # temel proje kalmalı, referans çözüm geçmeli
```

Gizli testler `evals/<set>/hidden/<görev>/`, referans çözümler `evals/<set>/solutions/<görev>/` altındadır — ajanlar bunları görmez.
CI her değişiklikte iki setin de geçerli olduğunu (`--validate`) doğrular.
