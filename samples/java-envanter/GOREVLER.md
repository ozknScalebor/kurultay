# Görev listesi – Envanter (Java 8)

Kurultay'ı test etmek için düzeltilmesi / eklenmesi gereken işler. Her madde bir kullanıcı/test ekibi bildirimi gibi yazıldı;
nasıl düzeltileceği söylenmez. Her görevin gizli kabul testi `samples/evals/java-envanter/hidden/<id>/` altında, referans çözümü
`solutions/<id>/` altındadır (ajana gösterilmez).

| ID | Tür | Zorluk | Özet |
|---|---|---|---|
| B1-kademe-indirimi | hata | kolay | GOLD/SILVER müşterilere kademe indirimi uygulanmıyor |
| B2-csv-tirnak | hata | orta | Uygulama örnek CSV ile açılmıyor (tırnaklı alanlar) |
| B3-son-stok | hata | kolay | Stoğun tamamı sipariş edilemiyor |
| B4-iptal-stok | hata | kolay | İptal edilen siparişin stoğu geri gelmiyor |
| B5-satis-raporu | hata | kolay | Satış raporu iptal edilen siparişleri sayıyor |
| B6-tarih-araligi | hata | kolay | Aylık rapor ayın son gününü kaçırıyor |
| B7-kdv-yuvarlama | hata | orta | KDV bazen 1 kuruş eksik |
| B8-negatif-stok | hata | kolay | Negatif/sıfır stok girişi kabul ediliyor |
| F1-kupon | özellik | orta-zor | Kupon (YAZ15) desteği |
| F2-dusuk-stok-csv | özellik | orta | Düşük stok raporu CSV dışa aktarımı |

## B1-kademe-indirimi (hata, kolay)

GOLD ve SILVER müşterilere sadakat indirimi hiç uygulanmıyor. GOLD müşteri %10, SILVER %5 indirim almalı (ara toplam üzerinden); KDV indirimli tutar üzerinden hesaplanmalı. Örnek: GOLD müşteri, 2 adet 100 TL'lik elektronik ürün → indirim 20 TL, KDV 36 TL, toplam 216 TL.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## B2-csv-tirnak (hata, orta)

Uygulama örnek veri dosyasıyla (data/urunler.csv) açılmıyor: 'Satır 4: 4 alan bekleniyordu, 5 bulundu'. Ürün adlarında virgül olabiliyor; CSV okuyucu tırnaklı alanları ("Defter, A4 kareli") ve tırnak içindeki çift tırnakları ("Çay ""Rize"" 1kg") doğru okumalı. Kapanmamış tırnak satır numarasıyla birlikte IOException vermeli.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## B3-son-stok (hata, kolay)

Depodaki stoğun tamamı sipariş edilemiyor: 5 adet stok varken 5 adetlik sipariş 'Yetersiz stok' hatası veriyor. Mevcut stoğun tamamı rezerve edilebilmeli, fazlası reddedilmeli.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## B4-iptal-stok (hata, kolay)

İptal edilen siparişlerin stoğu geri gelmiyor: sipariş iptal edildikten sonra ürünlerin mevcut (available) miktarı sipariş öncesine dönmüyor. NEW veya CONFIRMED bir sipariş iptal edildiğinde ayrılan stok serbest bırakılmalı; aynı sipariş ikinci kez iptal edilememeli.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## B5-satis-raporu (hata, kolay)

Kategori bazında satış raporu (ReportService.salesByCategory) iptal edilmiş siparişleri de satış olarak sayıyor. İptal edilen siparişler rapora hiç girmemeli; yalnızca iptal edilmiş siparişi olan kategori raporda görünmemeli.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## B6-tarih-araligi (hata, kolay)

Aylık sipariş raporu ayın son günü verilen siparişleri göstermiyor. DateRange iki ucu da dahil bir aralık olarak belgelenmiş ama bitiş günü aralığa dahil edilmiyor; tek günlük aralık da çalışmıyor.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## B7-kdv-yuvarlama (hata, orta)

KDV tutarları bazen 1 kuruş eksik çıkıyor (ör. 10,05 TL'lik gıda ürününün KDV'si 1,01 yerine 1,00 TL). KDV hesabı kayan nokta (double) kullanmadan BigDecimal ile yapılmalı ve kuruşa HALF_UP yuvarlanmalı.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## B8-negatif-stok (hata, kolay)

Stok girişinde (InventoryService.addStock) sıfır veya negatif miktar kabul ediliyor ve stok eksiye düşebiliyor. Pozitif olmayan miktar IllegalArgumentException ile reddedilmeli, stok değişmemeli.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## F1-kupon (özellik, orta-zor)

Siparişlere kupon desteği ekle: OrderService.applyCoupon(String siparisId, String kod) ve Order.getCouponCode(). Şimdilik tek kupon var: YAZ15 (büyük/küçük harf duyarsız) — kademe indirimi düşüldükten sonra kalan ara toplamın %15'i kadar ek indirim; PricingService.discount bu indirimi de içermeli, KDV indirimli tutardan hesaplanmalı. Bilinmeyen kod IllegalArgumentException; ikinci kupon veya iptal/sevk edilmiş siparişe kupon IllegalStateException vermeli. getCouponCode kodu büyük harfle döndürmeli, kupon yoksa null.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## F2-dusuk-stok-csv (özellik, orta)

Düşük stok raporunu CSV olarak dışa aktar: ReportFormatter.lowStockCsv(List<StockLevel>) başlığı 'sku,ad,mevcut' olan, satır sonu \n olan bir metin döndürmeli. Virgül, tırnak veya satır sonu içeren alanlar RFC 4180'e göre tırnaklanmalı (içteki tırnak iki kez yazılır). Boş liste yalnızca başlık satırını döndürür.

**Kabul:** mevcut testler geçmeye devam eder; davranış yukarıdaki gibidir; Java 8 ile derlenir.

## Nasıl denenir

```bash
# tek görev, konsoldan
kurultay   # çalışma alanı: samples/java-envanter

# hepsi, gizli testlerle puanlanarak
kurultay eval samples/evals/java-envanter --modes single,race,council

# görevlerin geçerliliği (temel proje kalmalı, referans çözüm geçmeli)
kurultay eval samples/evals/java-envanter --validate
```
