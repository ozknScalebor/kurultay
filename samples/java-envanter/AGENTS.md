# Envanter – proje kuralları (ajanlar için)

- Dil seviyesi **Java 8**: `var`, `List.of`, `Map.of`, record, switch ifadesi, text block vb. Java 9+ özellikleri kullanılamaz.
  Derleme her zaman `--release 8` ile yapılır; Java 9+ API'si derleme hatası verir.
- Para tutarları yalnızca `BigDecimal`; `double`/`float` ile para hesabı yapılmaz. Kuruşa yuvarlama `RoundingMode.HALF_UP`, ölçek 2.
- Dış bağımlılık yok (Maven/JUnit yok). Testler `src/test/java` altında, `com.ornek.test.Test` notasyonu ve `com.ornek.test.Assert` ile yazılır;
  adı `Test` ile biten her sınıf otomatik çalışır.
- Derleme: `javac -d .build/tools tools/Build.java && java -cp .build/tools Build compile`
- Test: `javac -d .build/tools tools/Build.java && java -cp .build/tools Build test`
- Demo: `java -cp .build/tools Build run` (data/urunler.csv okunur)
- Hata mesajları Türkçe; istisnalar yutulmaz.
- Public API değişiklikleri (yeni metot, imza) Javadoc ile belgelenir.
