# Açık kaynak kodlama ajanları – kaynak kod incelemesi

Bu doküman, Kurultay tasarlanırken incelenen 15 açık kaynak ajanın **kaynak kodundan** çıkarılan bulguları ve bunların Kurultay'a nasıl yansıdığını anlatır. İlk sürümdeki araştırma web dokümantasyonuna dayanıyordu; bu sürüm her projenin deposunu klonlayıp ilgili modülleri okuyarak hazırlandı.

## Yöntem

- **İncelenen sürümler:** Her depo 2026-10-20'de `--depth 1` ile klonlandı; incelenen commit'ler aşağıdaki tabloda.
- **İncelenen boyutlar:** Her projede şu 10 başlık için ilgili çekirdek modüller okundu:
  1. ajan döngüsü
  2. araçlar ve düzenleme formatı
  3. bağlam yönetimi (sıkıştırma)
  4. model yönlendirme ve yedekleme
  5. alt ajan / paralellik
  6. indeksleme
  7. kurallar ve skill'ler
  8. doğrulama / inceleme
  9. yerel model ve araç çağrısı ayrıştırma
  10. döngü tespiti / dayanıklılık
- **Sınır:** Toplam yaklaşık 58 bin kaynak dosya var. Her satır okunmadı; dosya adları, sabitler, yorumlar ve kritik fonksiyonlar üzerinden hedefli okuma yapıldı. Aşağıdaki her bulgu dosya yoluyla belirtilmiştir ve doğrulanabilir.

| Proje | Depo | Commit | Dil | Ana fikir |
|---|---|---|---|---|
| Pi | badlogic/pi-mono | 26293e7 | TS | Minimal çekirdek; Agent Skills; ağaç yapılı oturumlar |
| omp | can1357/oh-my-pi | 2220e58 | TS+Rust | Rol bazlı model zincirleri; hashline düzenleme; TTSR kuralları |
| Qwen Code | QwenLM/qwen-code | f4f3749 | TS | Kapsamlı döngü tespiti; okumadan düzenleme yasağı; koşullu skill'ler |
| OpenCode | anomalyco/opencode | d814879 | TS | Retry-After uyumlu yeniden deneme; patch formatı; doom-loop |
| oh-my-openagent | code-yeongyu/oh-my-openagent | f90d451 | TS | Todo devam ettirici; düzenleme hatası kurtarma; dizin kuralları |
| Aider | Aider-AI/aider | 5dc9490 | Python | Repo haritası; düzenleme sonrası lint/test yansıması |
| Cline | cline/cline | ca7402c | TS | Ardışık hata sayacı; `skills` aracı; takım ajanları |
| Goose | aaif-goose/goose | 9920efa | Rust | Toolshim yorumlayıcı model; tarifler (recipe) |
| Codex CLI | openai/codex | 464add4 | Rust | apply_patch eşleştirme; inceleme rubriği; `$skill` anma |
| OpenHands SDK | OpenHands/software-agent-sdk | 0996c33 | Python | Takılma dedektörü; yoğunlaştırıcı; eleştirmen (critic) |
| Kilo Code | Kilo-Org/kilocode | 5cc65d1 | TS | Gömülü vektör deposu; oturum özeti hafızası |
| Crush | charmbracelet/crush | 91c7065 | Go | Sonuç duyarlı döngü tespiti; düzenleme sonrası LSP tanıları |
| Serena | oraios/serena | abb0a0f | Python | Sembol düzeyinde düzenleme; onboarding hafızaları |
| DeepWiki-Open | AsyncFuncAI/deepwiki-open | d92819a | Python | İki aşamalı wiki: yapı → kaynaklı sayfalar |
| llm-council | karpathy/llm-council | 92e1fcc | Python | Metin tabanlı anonim sıralama + başkan |
| Agent Skills | anthropics/skills | dbd4588 | – | SKILL.md standardı |

---

## 1. Skill'ler

| Proje | Biçim | Nasıl seçiliyor | Kaynak |
|---|---|---|---|
| Pi | `skills/<ad>/SKILL.md` veya kökte açıklamalı `.md` | Sistem isteminde yalnızca ad, açıklama ve konum listelenir; model `read` aracıyla dosyayı kendisi yükler. `disable-model-invocation` olan skill'ler gizlenir ve yalnızca `/skill:ad` ile çağrılır | `packages/coding-agent/src/core/skills.ts` |
| omp | `.omp`, `.claude`, `.codex`, `.agents`, `.github/skills` altından | Ad ve açıklama sistem isteminde; gövde `skill://ad` ile okunur; `globs`, `alwaysApply`, `hide`, `enabled:false` | `docs/skills.md`, `src/extensibility/skills.ts` |
| Qwen Code | `.qwen/skills/<ad>/SKILL.md` | Ayrı bir `skill` aracı. `paths:` glob'u olan skill'ler, bir araç eşleşen bir dosyaya dokunana kadar gösterilmez | `src/skills/skill-activation.ts`, `src/tools/skill.ts` |
| Cline | `.cline`, `.clinerules`, eklentiler | Açıklaması dinamik olarak mevcut skill adlarını listeleyen `skills(skill, args)` aracı | `sdk/packages/core/src/extensions/tools/definitions.ts` |
| Goose | `.agents/skills`, `.goose/skills`, `.claude/skills` (proje → global) | Destek dosyaları istek üzerine yüklenir; `argument-hint` ile argümanlar gövdeye yerleştirilir | `crates/goose/src/skills/mod.rs` |
| Codex | Sıralı kök dizinler | Kullanıcı metninde `$skill-adı` anılırsa açıkça seçilir; devre dışı bırakılabilir | `codex-rs/skills/src/selection.rs`, `mentions.rs` |
| OpenHands | `.openhands/skills` | `KeywordTrigger`: kullanıcı mesajında anahtar kelime geçerse otomatik devreye girer | `openhands/sdk/skills/trigger.py` |
| Agent Skills spesifikasyonu | `<ad>/SKILL.md` (+ `scripts/`, `references/`, `assets/`) | `name` en fazla 64 karakter ve küçük harf-tire; `description` en fazla 1024 karakter. Aşamalı yükleme: başta ~100 token üst veri, etkinleşince 5 bin token altında gövde, kaynaklar ihtiyaç oldukça | anthropics/skills |

**Kurultay'a yansıması (bu sürüm):**
- Agent Skills uyumlu `SKILL.md` klasörleri ve eski düz `.md` dosyaları okunuyor.
- `.kurultay`, `.agents`, `.claude`, `.codex`, `.qwen`, `.goose`, `.opencode`, `.github` dizinleri ve global dizinler taranıyor.
- Sistem isteminde yalnızca skill adı ve açıklaması gösteriliyor; gövde gerektiğinde `skill` aracıyla yükleniyor.
- Destek dosyaları `skill_file` aracıyla okunuyor.
- `paths`/`globs` ile koşullu skill'ler, `keywords` ile tetikleyiciler, `$ad` ile anma ve `--skill` seçeneği destekleniyor.
- `disable-model-invocation` ve ad/açıklama doğrulama tanıları (diagnostics) var.
- Kullanılan skill'ler raporlanıyor.

## 2. Döngü ve takılma tespiti

| Proje | Kural | Kaynak |
|---|---|---|
| Qwen Code | Ardışık aynı araç çağrısı ≥5; aynı içerik parçası ≥10; aynı dosya 15 çağrıda ≥8 kez okunma; salt-okuma durgunluğu 8; A/B dönüşümü 3 tur; tur başına en fazla 100 araç çağrısı | `services/loopDetectionService.ts` |
| Cline | İmza = araç adı + anahtarları sıralı JSON; 3'te uyarı, 5'te durdurma | `runtime/safety/loop-detection.ts` |
| Crush | İmza = SHA-256(çağrı + **sonuç**); 10 adımlık pencerede >5 tekrar varsa durdurma | `internal/agent/loop_detection.go` |
| OpenHands | Aynı eylem + aynı gözlem; aynı eylem + hata; monolog ≥3; dönüşüm ≥6; bağlam hatası döngüsü | `conversation/stuck_detector.py` |
| OpenCode | Aynı çağrı 3 kez tekrarlanırsa `doom_loop` izin isteği | `v1/config/permission.ts` |

**Kurultay'a yansıması:** Yeni `LoopGuard` modülü:
- Çağrı ve sonucu birlikte imzalıyor; sonuç değiştiyse tekrar döngü sayılmıyor.
- Aynı imza 3. kez gelince uyarı, 5. kezde durdurma.
- 10 adımlık pencerede A/B dönüşümünü yakalıyor.
- Uzun salt-okuma serilerinde "artık uygulamaya geç" hatırlatması veriyor (Qwen keşif bütçesi).

## 3. Hata kurtarma ve güvenli düzenleme

| Fikir | Proje | Kaynak |
|---|---|---|
| Ardışık hata sayacı (API hatası / geçersiz araç çağrısı / araç hatası) → sınırda dur | Cline | `runtime/safety/mistake-tracker.ts` |
| Düzenleme hatasında "önce dosyayı yeniden oku" hatırlatması | oh-my-openagent | `hooks/edit-error-recovery` |
| Okunmamış veya okunduktan sonra değişmiş dosyayı düzenlemeyi reddet | Qwen, Crush, OMO | `tools/priorReadEnforcement.ts`, `internal/filetracker`, `hooks/write-existing-file-guard` |
| Düzenleme sonrası sözdizimi/LSP tanısını araç sonucuna ekle | Aider, Crush, Serena, omp | `linter.py` (tree-sitter hata düğümleri), `tools/edit.go` → `getDiagnostics`, `edit/auto-repair.ts` |
| CRLF koruma, Unicode tırnak/tire normalizasyonu | Pi, Codex | `tools/edit-diff.ts`, `apply-patch/src/seek_sequence.rs` |
| Dosya adını bilinen dosyalarla eşleştirme (tam → taban adı → bulanık) | Aider | `coders/editblock_coder.py` → `find_filename` |
| Yerel modelin düz metninden araç çağrısını ikinci bir modelle çıkarma | Goose | `providers/toolshim.rs` |
| Retry-After başlığına uyma; zaman aşımı tekrarlarını sınırlama | OpenCode | `core/src/model-retry.ts` |

**Kurultay'a yansıması:**
- Ardışık hata sınırı ve düzenleme hatası hatırlatması eklendi.
- Mevcut bir dosyanın üzerine yazmak veya onu silmek için önce okumuş olmak gerekiyor. `edit_file` için `old_text` birebir eşleşmek zorunda olduğundan (Aider SEARCH/REPLACE mantığı) okuma şartı yalnızca eşleşmeyen bir düzenlemeden sonra devreye giriyor: dosya yeniden okunmadan tekrar düzenlenemez.
- Toolshim yalnızca metin bir araç adı veya JSON/kod içeriyorsa çağrılıyor; düz sohbet ek istek maliyeti yaratmıyor.
- Düzenlemeden sonra parantez/küme parantezi dengesi ve JSON geçerliliği kontrol ediliyor; bozulursa uyarı araç sonucuna ekleniyor.
- CRLF satır sonları korunuyor; Unicode bulanık eşleşme var.
- Dosya adı taban adından çözümleniyor.
- Toolshim yedeği: araç çağrısı ayrıştırılamazsa başka bir model düz metinden çağrıyı çıkarıyor.
- Router `Retry-After` başlığına uyuyor.

## 4. Bağlam sıkıştırma

| Proje | Tetik | Özet yapısı | Kaynak |
|---|---|---|---|
| Pi | `bağlam > pencere − 16384` | Hedef / Kısıtlar / İlerleme (Bitti–Devam–Engelli) / Kararlar / Sonraki adımlar / Kritik bağlam; önceki özet artımlı güncellenir; okunan ve değiştirilen dosya listeleri taşınır | `core/compaction/compaction.ts`, `utils.ts` |
| Codex | Model limitine göre | Devir (handoff) özeti; ilk kullanıcı mesajları 20 bin token'a kadar aynen korunur | `core/src/compact.rs`, `prompts/templates/compact/prompt.md` |
| Qwen Code | Pencerenin %85'i | Önce eski araç çıktıları atılır (mikro sıkıştırma), sonra son dokunulan dosyalar yeniden eklenir | `services/chatCompressionService.ts`, `microcompaction/` |
| OpenCode | `max(16k, %15)` rezerv | – | `session/compaction.ts` |
| Goose | %80 | Özetleme veya kırpma | `context_mgmt/mod.rs` |
| OpenHands | 240 olay | İlk 2 olay asla özetlenmez | `condenser/llm_summarizing_condenser.py` |

**Kurultay'a yansıması:**
- Yoğunlaştırıcı (condenser) Pi/Codex tarzı yapılandırılmış devir özeti üretiyor; önceki özet artımlı güncelleniyor.
- Okunan ve değiştirilen dosya listeleri özetle birlikte taşınıyor.
- Görev mesajı hiçbir zaman özetlenmiyor.

## 5. İnceleme ve konsey

- **Codex `review/rubric.md`:** Yalnızca **değişikliğin getirdiği**, somut ve kanıtlanabilir hatalar işaretlenir. Her bulguya [P0–P3] öncelik ve güven puanı verilir. Spekülatif bulgu yerine "bulgu yok" tercih edilir.
- **llm-council `backend/council.py`:** Sıralama düz metin olarak `FINAL RANKING:` bölümünde istenir, ayrıştırma regex yedekleriyle yapılır. JSON üretemeyen modellerle de çalışır.
- **OpenHands critic:** Boş yama ve ajanın bitirmemiş olması ayrı kriterler.

**Kurultay'a yansıması:**
- Konsey istemi Codex rubriğine göre yeniden yazıldı; P0/P1 bulgular engelleyici sayılıyor.
- JSON bozuksa `FINAL RANKING:` metin ayrıştırmasına düşülüyor.
- **İnceleme bağımsızlığı:** Tek adaylı işlerde kodu yazan model (failover sonrası devralan modeller dahil) inceleyici olamaz; inceleyici düşerse yerine yine yazar olmayan bir model geçer. Çok adaylı konseyde bir inceleyicinin kendi adayına verdiği oy sayılmaz. Engelleyici bulgu sonrası yapılan düzeltme, yazar olmayan bir model tarafından yeniden inceleniyor; hâlâ engelleyici bulgu varsa ikinci düzeltme turu açılıyor. Kabul hakemleri de önce kodu yazmayan modellerden seçiliyor. Rapor, incelemenin bağımsız olup olmadığını yazıyor.

## 6. Proje analizi ve hafıza

- **DeepWiki-Open:** Önce dosya ağacı ve README'den `<wiki_structure>` çıkarılıyor; her sayfa yalnızca kendi `relevant_files` dosyalarından, kaynak atıflı ve Mermaid diyagramlı üretiliyor (`api/services/wiki/prompts.py`).
- **Serena onboarding:** Kalıcı hafızalar üretiliyor: `core`, `tech_stack`, `suggested_commands`, `conventions`, `task_completion` (`resources/config/prompt_templates/simple_tool_outputs.yml`).
- **Kilo hafızası:** Her turdan sonra oturum özeti (amaç, yapılanlar, dosyalar, kararlar, sonraki adım, engeller) yazılıyor (`kilo-memory/src/prompts/session-digest.txt`).
- **Pi ve OMO:** Her üst dizindeki `AGENTS.md` dosyaları ve okunan dosyanın dizinindeki `AGENTS.md` bağlama ekleniyor.

**Kurultay'a yansıması:**
- `analyze` artık ana **akışları** (flows) model konseyine seçtiriyor; her akış için kaynak dosyalara dayanan, atıflı ve diyagramlı sayfalar tüm modellere paralel ürettiriliyor (`.kurultay/flows/`).
- Serena tarzı `PROJECT_NOTES.md` (teknoloji yığını, komutlar, kurallar, tamamlanma kontrol listesi) üretiliyor ve her çalışanın bağlamına ekleniyor.
- Alt dizinlerdeki `AGENTS.md`, o dizindeki dosyalara uygulanan kural olarak kullanılıyor.

## 7. Model yönlendirme

- **omp:** `modelRoles.<rol>` ve `retry.fallbackChains.<rol>`. Küçük modeller için deneyler: <1B modellerde örnek (few-shot) vermek zararlı; önceden doldurma (prefill) ve durdurma belirteci (stop token) kullanılmalı (`docs/local-models.md`).
- **oh-my-openagent:** Model ailesine göre istem önayarları var; Claude adım adım kontrol listelerini, GPT ise ilke odaklı istemleri iyi izliyor. "İstem bir modeli düzeltemez": orkestratör rolü yalnızca güçlü modellere veriliyor (`docs/guide/agent-model-matching.md`).
- **Aider `model-settings.yml`:** 357 model için ayrı düzenleme formatı, zayıf model ve hatırlatma yerleşimi ayarları var.

### Yanıt vermeyen model (zaman aşımı ve failover)

| Ne | Nerede | Kaynak |
|---|---|---|
| Akış boşta kalma zaman aşımı (varsayılan 300 sn) ve akış yeniden deneme sayısı | Codex | `codex-rs/model-provider-info/src/lib.rs` (`DEFAULT_STREAM_IDLE_TIMEOUT_MS`, `DEFAULT_STREAM_MAX_RETRIES`) |
| SSE parçaları arası `chunkTimeout`: süre içinde parça gelmezse istek iptal | OpenCode / Kilo | `packages/opencode/src/provider/provider.ts` (`wrapSSE`), `core/src/v1/config/provider.ts` |
| Çalışma anında model değiştirme: yeniden denenebilir hatalarda `fallback_models` zincirine geçiş, hata sınıflandırma | oh-my-openagent | `packages/model-core/src/runtime-fallback-error-classifier.ts`, `model-resolution-pipeline.ts` |
| Rol başına yedek zincirleri | omp | `retry.fallbackChains.<rol>` |
| Sağlayıcılar arası mesaj dönüştürme (bir modelin geçmişini başka formatta sürdürme) | Pi | `packages/ai` (`transformMessages`) |

**Kurultay'a yansıması:**
- Her istekte üç saat var: toplam süre, **ilk token süresi** (uzun istemler için istem token'ı başına ek pay) ve **akış sessizlik süresi**. Takılan model dakikalar yerine saniyeler içinde fark ediliyor.
- Zaman aşımına uğrayan model aynı modelde varsayılan olarak tekrar denenmiyor; **karantinaya alınıyor** (2 dk, tekrarlarda ikiye katlanarak en fazla 16 dk). Karantina tüm çalışanlar için geçerli.
- Çalışan **kalıcı failover** yapıyor: model yanıt vermezse görev bağlamı sığan en iyi yedek modelle sürüyor, düşen model o görevde bir daha kullanılmıyor. Yeni model native araç çağrısı desteklemiyorsa geçmiş `<tool_call>`/`<tool_result>` metin protokolüne çevriliyor. Hiç sağlam model kalmazsa düşenler bir kez daha deneniyor, ardından router'ın bekle-tekrar dene mantığı devreye giriyor.
- Düzeltme turları, son çalışan modelle (düşen modelle değil) yapılıyor. Model değişimleri raporda listeleniyor.

Kurultay bunu ölçümle yapıyor: probe sonuçlarından rol puanı çıkarılıyor, kodlama ve düzenleme puanları planlayıcı ve hakem seçimini belirliyor. Model ailesine özel istem önayarları yol haritasında.

## 8. Kurultay'da bilerek yapılmayanlar

| Fikir | Neden şimdilik yok |
|---|---|
| Hashline / AST düzenleme (omp, Serena) | Native tree-sitter veya LSP gerektiriyor; offline paketleme hedefiyle çelişiyor. Yol haritasında: isteğe bağlı WASM tree-sitter |
| Gömülü vektör deposu (Kilo LanceDB) | Native modül gerektiriyor. Şimdilik BM25 + PageRank kullanılıyor |
| Sandbox (Codex landlock/seatbelt) | Platforma özgü. Kurultay yasaklı komut kalıpları ve overlay izolasyonu kullanıyor |
| TTSR akış kuralları (omp) | Akışı yarıda kesmek yerel sunucularda (llama.cpp) kararsız |
