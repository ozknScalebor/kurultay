# Görev listesi – Telemetri (C++17)

Kurultay'ı test etmek için düzeltilmesi / eklenmesi gereken işler. Her madde bir saha/test ekibi bildirimi gibi yazıldı;
nasıl düzeltileceği söylenmez. Gizli kabul testleri `samples/evals/cpp-telemetri/hidden/<id>/tests/`, referans çözümler `solutions/<id>/` altında.

| ID | Tür | Zorluk | Özet |
|---|---|---|---|
| C1-halka-tampon | hata | orta | Dolu RingBuffer sırayı bozuyor |
| C2-crc | hata | orta | Cihaz paketleri CRC hatasıyla reddediliyor |
| C3-hareketli-ortalama | hata | kolay | Hareketli ortalama ilk ölçümlerde düşük |
| C4-eksik-cerceve | hata | orta | Yarım çerçeve tampon dışı okuyor (ASan) |
| C5-alarm-histerezis | hata | kolay | Alarm eşikte açılıp kapanıyor |
| C6-standart-sapma | hata | kolay | Standart sapma örneklem değil |
| C7-ayar-dosyasi | hata | orta | Ayar dosyası boşluk/yorum okuyamıyor |
| C8-cift-kayit | hata | kolay | Çift sensör kaydı ilk kaydı bozuyor |
| F1-medyan-filtre | özellik | orta | MedianFilter ekle |
| F2-istatistik-csv | özellik | orta-zor | İstatistik CSV dışa aktarımı |

## C1-halka-tampon (hata, orta)

RingBuffer dolduktan sonra sırası bozuluyor: kapasitesi 3 olan tampona 1..5 eklenince to_vector() {3,4,5} yerine yanlış sırada/yanlış elemanlar döndürüyor. Dolu tampona eklemede en eski eleman düşmeli; at(0) her zaman en eski, son eleman en yeni olmalı.

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## C2-crc (hata, orta)

Sahadaki cihazlardan gelen paketler 'CRC hatası' ile reddediliyor (ör. AA 05 07 00 01 66 08 71 3D). Cihazlar CRC-16/CCITT-FALSE kullanıyor (polinom 0x1021, başlangıç 0xFFFF; "123456789" için kontrol değeri 0x29B1). Bizim CRC hesabımız bu standarda uymalı.

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## C3-hareketli-ortalama (hata, kolay)

Hareketli ortalama (MovingAverage) ilk ölçümlerde çok düşük çıkıyor: 4'lük pencereye ilk değer 10 eklenince 10 yerine 2.5 dönüyor. Pencere dolana kadar o ana kadarki örneklerin ortalaması dönmeli.

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## C4-eksik-cerceve (hata, orta)

Seri hattan yarım gelen çerçeveler parse_packet içinde tampon dışına okumaya yol açıyor (AddressSanitizer heap-buffer-overflow raporluyor). Eksik/yarım çerçeve hiçbir zaman tampon dışını okumamalı; nullopt döndürüp hata metnini "eksik çerçeve" yapmalı. Çerçeveden sonra gelen fazladan baytlar sorun olmamalı.

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## C5-alarm-histerezis (hata, kolay)

Sıcaklık alarmı eşik çevresinde sürekli açılıp kapanıyor (ör. eşik 80, histerezis 2 iken 80.5 → alarm, 79.0 → alarm hemen kalkıyor). Alarm ancak değer eşik − histerezis altına inince kalkmalı.

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## C6-standart-sapma (hata, kolay)

Raporlardaki standart sapma, Excel'in STDEV.S değerinden farklı (2,4,4,4,5,5,7,9 için 2.0 yerine ≈2.138 olmalı). RunningStats::variance/stddev başlıkta belgelendiği gibi örneklem (n−1) değerini vermeli.

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## C7-ayar-dosyasi (hata, orta)

Ayar dosyası okuyucu, operatörlerin yazdığı dosyaları okuyamıyor: ' port = 8080   # servis portu' satırında port değeri sayı olarak okunamıyor, girintili yorum satırları hata veriyor. Anahtar/değer çevresindeki boşluklar ve tablar atılmalı, '#' sonrası yorum yok sayılmalı, Windows satır sonları (\r\n) desteklenmeli, boş değer ('bos =') geçerli olmalı.

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## C8-cift-kayit (hata, kolay)

Aynı id ile ikinci kez sensör kaydedilince register_sensor false döndürdüğü halde ilk sensörün adı ve birimi değişiyor. Var olan kayıt hiç değişmemeli (istatistikleri de korunmalı).

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## F1-medyan-filtre (özellik, orta)

Ani sıçramaları bastırmak için filters.hpp içine MedianFilter sınıfı ekle: explicit MedianFilter(std::size_t window) — pencere tek sayı ve > 0 değilse std::invalid_argument; double add(double) son en çok `window` örneğin medyanını döndürür (pencere dolmadan örnek sayısı çiftse ortadaki iki değerin ortalaması); std::size_t count() const pencere içindeki örnek sayısı.

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## F2-istatistik-csv (özellik, orta-zor)

Sensör istatistiklerini CSV olarak dışa aktar: yeni başlık telemetri/report.hpp içinde std::string stats_csv(const SensorRegistry&). Başlık 'id,ad,birim,adet,ortalama,min,maks', satırlar id sırasıyla, sayılar '.' ondalık ayırıcıyla 3 basamak (ör. 71.250); ölçümü olmayan sensörde adet 0 ve diğer sayısal alanlar boş ('5,Yedek,%,0,,,'); virgül veya tırnak içeren alanlar RFC 4180'e göre tırnaklanmalı. Her satır \n ile biter; kayıt yoksa yalnızca başlık.

**Kabul:** mevcut testler geçer; ASan/UBSan uyarısı yok; davranış yukarıdaki gibidir.

## Nasıl denenir

```bash
kurultay   # çalışma alanı: samples/cpp-telemetri
kurultay eval samples/evals/cpp-telemetri --modes single,race,council
kurultay eval samples/evals/cpp-telemetri --validate
```
