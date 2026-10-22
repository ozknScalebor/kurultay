# Envanter (Java 8 örnek proje)

Kurultay'ı denemek için hazırlanmış, orta büyüklükte bir **stok ve sipariş yönetimi** projesi:
ürün kataloğu (CSV), çok depolu stok ve rezervasyon, sipariş yaşam döngüsü (NEW → CONFIRMED → SHIPPED / CANCELLED),
müşteri kademesine göre indirim, kategoriye göre KDV ve raporlar.

İçine bilerek **8 hata** bırakıldı ve **2 özellik** eksik — liste [GOREVLER.md](GOREVLER.md) dosyasında.
Mevcut testlerin hepsi geçer; hatalar test edilmeyen yollarda.

## Gereksinim

Yalnızca bir JDK (8 veya üstü). Maven, Gradle, JUnit, internet gerekmez.

```bash
javac -d .build/tools tools/Build.java
java -cp .build/tools Build test      # derle + testleri çalıştır
java -cp .build/tools Build run       # demo (şu an B2 hatası yüzünden açılmıyor)
```

## Yapı

| Paket | İçerik |
|---|---|
| `model` | Product, Category (KDV oranı), Customer/CustomerTier, Order, OrderLine, StockItem |
| `repo` | Bellek içi ürün ve stok depoları |
| `service` | InventoryService (rezervasyon), PricingService (indirim, KDV), OrderService, ReportService |
| `io` | CsvProductLoader, ReportFormatter |
| `util` | DateRange, Validation |

## Kurultay ile

```bash
cd samples/java-envanter
kurultay                       # konsol: çalışma alanı olarak bu klasörü seçin
> B4: iptal edilen siparişlerin stoğu geri gelmiyor …
```

veya ölçüm için gizli testlerle: `kurultay eval samples/evals/java-envanter --modes single,race`.
