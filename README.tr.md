# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![GitHub stars](https://img.shields.io/github/stars/tickernelz/opencode-mem.svg)](https://github.com/tickernelz/opencode-mem)

![OpenCode Memory Banner](.github/pics/banner.png)

[🇬🇧](./README.md) | [🇩🇪](./README.de.md) | [🇨🇳](./README.zh.md) | [🇸🇦](./README.ar.md) | **🇹🇷** | [🇳🇱](./README.nl.md)

Yerel vektör veritabanı teknolojisi kullanarak oturumlar arasında uzun vadeli bağlam saklamayı sağlayan, yapay zeka kodlama ajanları için kalıcı bir bellek sistemi.

## Temel Özellikler

Yerel Turso/libSQL veritabanı ve yerel vektör arama, kalıcı proje bellekleri, otomatik kullanıcı profili öğrenme, birleşik bellek-prompt zaman çizelgesi, tam özellikli web arayüzü, akıllı prompt tabanlı bellek çıkarımı, çoklu sağlayıcı AI desteği (OpenAI, Anthropic), 12+ yerel embedding modeli, akıllı tekilleştirme ve yerleşik gizlilik koruması.

## Ön Koşullar

Bu eklenti, gömülü Turso (`@tursodatabase/database`) ile `F32_BLOB` vektörleri ve `vector_distance_cos` üzerinden kesin kosinüs araması kullanır. Ayrı bir vektör veritabanı veya özel SQLite derlemesi gerekmez.

**Önerilen çalışma zamanı:**

- Bun
- Standart OpenCode eklenti ortamı
- Varsayılan yerel embedding modelini kullanıyorsanız ilk kullanımda internet erişimi gerekir; çünkü model `@huggingface/transformers` tarafından indirilir.
- Kaynak/geliştirme kurulumlarında derlemeden veya testten önce `bun install` çalıştırın. Yayınlanan eklenti paketi çalışma zamanı bağımlılıklarını OpenCode üzerinden otomatik kurar.

**CI’da test edilen platformlar:** Linux, Windows ve Apple Silicon üzerinde macOS 15 / macOS 26 (`darwin/arm64`). **Intel Mac (`darwin/x64`) desteklenmez** — `@tursodatabase/database` ve sabit `onnxruntime-node` sürümleri x64 yerel bağlayıcı yayınlamaz. Daha eski macOS sürümleri bu matris tarafından dışlanmaz; yalnızca mevcut GitHub barındırmalı runner kümesinin dışındadırlar.

**Notlar:**

- Vektör embedding’leri doğrudan Turso’da saklanır ve aranır; eklemeler kesin kosinüs sıralaması için `F32_BLOB` vektörleri depolar.
- Vektör araması `vector_distance_cos` ile kesin kosinüs mesafesi kullanır (DiskANN / yaklaşık dizin yok); bir sorgu dizgesi verildiğinde isteğe bağlı anahtar kelime hibrit sıralaması vardır (`@tursodatabase/database` FTS5 içermez).
- Oturum aramaları indeksli bir `session_id` sütunu kullanır (şema v2’de `metadata.sessionID` üzerinden geri doldurulur).
- Otomatik yakalama ve kullanıcı profili öğrenme, yapılandırılmış/araç-çağrısı çıktısı döndürebilen bir AI sağlayıcısı gerektirir. Bellek arama/ekleme/listeleme, otomatik yakalama sağlayıcı yapılandırması olmadan da çalışır.

### Donanım / kaynak beklentileri

opencode-mem bir GPU **gerektirmez**. Yerel embedding’ler `@huggingface/transformers` ve ONNX üzerinden CPU’da çalışır (MLX backend yoktur). Ekstra VRAM gerekmez.

| İş yükü                                                           | Tipik ek kaynaklar                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Yerel embedding’ler** (varsayılan `Xenova/nomic-embed-text-v1`) | Model yükleniyken yaklaşık **0,5–2 GB RAM**, seçtiğiniz Hugging Face kimliğine bağlı. İlk kullanım modeli indirir; disk önbelleği `{storagePath}/.cache` altında yaşar (varsayılan `~/.opencode-mem/data/.cache`) ve model başına genelde **yüzlerce MB ile ~1–2 GB** arasındadır. |
| **Uzak embedding’ler** (`embeddingApiUrl` + `embeddingApiKey`)    | İhmal edilebilir yerel ML RAM — yalnızca eklenti + Turso ek yükü.                                                                                                                                                                                                                  |
| **Veritabanı / eklenti**                                          | `storagePath` altında diskte Turso/libSQL. Boyut GPU belleğiyle değil, sakladığınız bellek sayısıyla büyür.                                                                                                                                                                        |

Yukarıdaki platform sınırlamaları geçerlidir (Intel Mac `darwin/x64` yok; Apple Silicon, Linux, Windows veya uzak bir embedding uç noktası kullanın). Bkz. [Embedding seçimi / yapılandırması](#embedding-seçimi--yapılandırması).

### Eski SQLite shard’larından yükseltme

Başlangıçta kesintiye uğramış yeniden-embedding değişimleri kurtarılır, libSQL DiskANN indeksleri mevcut Turso motoruna dönüştürülür ve ardından eski shard şeması doğrulanır veya yükseltilir. Motor dönüşümü, bir depoda tamamlanmış eski migrasyon işaretçisi olsa bile çalışır ve saklanan vektörleri yeniden embedding yapmadan korur. Her dönüştürülen veritabanı `<database>.pre-tursodb-<timestamp>.bak` olarak yedeklenir.

macOS ve Linux’ta birden fazla OpenCode oturumu, Turso’nun deneysel `multiprocess_wal` özelliğiyle aynı `storagePath`’i paylaşabilir (her süreç aynı modu kullanmalıdır — yükseltmeden sonra tüm oturumları yeniden başlatın). Windows’ta motor bu bayrağı reddeder; bu nedenle aynı anda yalnızca bir OpenCode oturumu bellek veritabanlarının sahibi olabilir.

Yükseltmeden sonraki ilk başlangıçta opencode-mem mevcut bellek shard veritabanlarını yerel Turso/libSQL vektör biçimine otomatik olarak taşır:

- Her shard yeniden yazılmadan önce `<shard>.db.legacy.bak` olarak yedeklenir
- İlerleme shard başına `<shard>.db.turso-migrate.json` içinde izlenir
- Genel bir `.turso-migrated` işaretçisi yalnızca tüm shard’lar başarıyla doğrulandıktan sonra yazılır
- Migrasyon sırasında aynı `storagePath`’e karşı birden fazla OpenCode örneği çalıştırmayın; bir kilit dosyası (`.turso-migrate.lock`) eşzamanlı migrasyonu engeller
- Manuel boyut migrasyonları `.turso-operation.lock` kullanır; diğer eklenti süreçleri migrasyon bitene kadar yeni bellek yazılarını reddeder

Migrasyon kesintiye uğrarsa, sonraki başlangıç yedekten otomatik olarak devam eder.

Bir shard uyumsuz hale gelirse (örneğin `embeddingDimensions` değiştikten sonra), yazmalar engellenir ve orijinal veritabanına dokunulmaz. Yerine geçmeden önce bir yedek oluşturup doğrulamak için Web arayüzünün yeniden-embedding migrasyonunu kullanın. Önceki shard `<shard>.db.pre-reembed-<pid>-<timestamp>.bak` olarak kullanılabilir kalır.

## Şema migrasyonları

Yerel Turso shard’ları ve yardımcı veritabanları (`metadata.db`, `user-prompts.db`, `user-profiles.db`, `ai-sessions.db`), `src/services/turso/schema-migrations.ts` içindeki sıralı `PRAGMA user_version` migrasyonlarıyla yükseltilir. Migrasyonlar idempotent’tir: eklentiyi başlatmak yalnızca bekleyen sürümleri uygular.

## Başlarken

OpenCode v2 için paketi yerel `plugins` listesine ekleyin:

```jsonc
{
  "plugins": ["opencode-mem@latest"],
}
```

OpenCode ayrıca paketin `./tui` eşlikçisini otomatik yükler; böylece
otomatik yakalama / profil / hata toast’ları TUI’de görünür (sunucu eklentileri
`ui.toast`’ı doğrudan çağıramaz). `plugins` içinde ikinci bir girdiye
ihtiyacınız yoktur. Uzak bir OpenCode sunucusuna karşı yalnızca CLI TUI
çalıştırıyorsanız, eşlikçinin toast RPC olaylarına abone olabilmesi için
o CLI’nin eklenti listesine (örneğin `cli.json`) `opencode-mem/tui` kaydedin.

OpenCode v1 için varsayılan giriş noktasını
`~/.config/opencode/opencode.json` yapılandırmanıza ekleyin:

```jsonc
{
  "plugin": ["opencode-mem@latest"],
}
```

`@latest` (veya bir semver aralığı) ve `opencode-mem.jsonc` içinde `autoUpdate: true` (varsayılan) ile eklenti, daha yeni bir npm sürümü mevcut olduğunda OpenCode’un önbelleğe alınmış kurulumunu temizler ve yeniden başlatmanızı ister. `opencode-mem@2.26.0` gibi sabitlenmiş sürümler asla otomatik güncellenmez.

### OpenCode v2’de otomatik bellek bağlamı

v2 eklentisi, modelin sistem bağlamı üzerinden otomatik bellek bağlamı sağlar.
Bu bloklar yazılan kullanıcı prompt’una eklenmez veya sohbet dökümünde saklanmaz.
`chatMessage.injectOn: "first"` (varsayılan) ile oturumun başlangıç bağlamı
kullanıcı turları ve model adımları boyunca korunur. `"always"` ile her
yazılan kullanıcı turunda yenilenir.

Bir ana bilgisayar veya eklenti yeniden başlatmasından sonra, devam ettirilen bir
oturum, yeni bir kullanıcı prompt’u gelmese bile bir sonraki model isteğinde
bağlamını mevcut bellek deposundan yeniden oluşturur.
Yeniden oluşturulan bağlam, bellekler ve profil geliştikçe orijinalinden
farklı olabilir. Geri yükleme sentetik bir kullanıcı prompt’u yakalamaz veya
bellek metninin ikinci bir kopyasını OpenCode eklenti depolamasında saklamaz.
Sıkıştırma, önbelleğe alınmış otomatik bağlamı geçersiz kılar; mevcut
sıkıştırma-bellek geri yüklemesi de çalışmaya devam eder.

### Yerel bir checkout kullanma

Eklentiyi npm sürümü yerine yerel bir kaynak checkout’undan çalıştırmak için checkout’ta `bun install && bun run build` çalıştırın, ardından `plugins` listesini checkout dizinine yönlendirin:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-mem"],
}
```

`dist/` veya tek bir dosyaya değil, paket köküne işaret edin. OpenCode bir dizin eklentisini `<directory>/index`’e geri düşerek çözer (OpenCode mevcut sürümlerde bir yol belirtimi için `package.json` `exports`/`main` okumaz); bu nedenle bu depo, `dist/plugin.js`’deki derlenmiş v2 giriş noktasını yeniden dışa aktaran ince bir kök `index.js` ve TUI eşlikçisi için `dist/tui.js`’yi yeniden dışa aktaran bir kök `tui.js` sağlar. Bir dosya yolu reddedilir (`configured plugin path must be a directory`); kök `index.js` olmayan bir dizin sessizce atlanır.

### İsteğe bağlı durağan veritabanı şifrelemesi

Yerel Turso shard’ları için AES-256-GCM şifrelemesini `~/.config/opencode/opencode-mem.jsonc` içinde etkinleştirin:

```jsonc
{
  "databaseEncryptionEnabled": true,
}
```

İlk başlangıçta eklenti `~/.config/opencode/opencode-mem-db.key` oluşturur (32 bayt hex anahtar, `chmod 600`) ve mevcut düz metin shard’larını taşır. Anahtarı kendiniz yönetiyorsanız `"databaseEncryptionKey": "env://OPENCODE_MEM_DB_KEY"` veya `"file://~/path/to.key"` ile geçersiz kılın. Anahtarı kaybetmek, şifreli veritabanlarının açılamayacağı anlamına gelir.

**Windows:** `%USERPROFILE%\.config\opencode\opencode.json` kullanın (örneğin `C:\Users\<you>\.config\opencode\opencode.json`). Bu eklenti OpenCode eklenti girişi için `%APPDATA%` veya `%LOCALAPPDATA%` **okumaz** — dosyayı kullanıcı profilinizdeki `.config\opencode` altına koyun, ardından OpenCode’u yeniden başlatın. Eklenti görünmezse yolu doğrulayın ve yeniden başlatın.

Eklenti bir sonraki başlangıçta otomatik olarak indirilir.

## Günlük kullanım

Eklentinin çalışması için OpenCode’dan bir şeyleri “hatırlamasını” istemeniz **gerekmez**. Varsayılanlarla bellek, siz çalıştıkça birikir.

### Tipik günlük akış

1. Eklentiyi etkinleştirin (bkz. [Başlarken](#başlarken)) ve OpenCode’u yeniden başlatın.
2. Otomatik yakalama için bir AI sağlayıcısı yapılandırın — önerilen: `opencodeProvider` + `opencodeModel` (veya `"opencodeModel": "inherit"`). Ayrıntılar [Otomatik yakalama AI sağlayıcısı](#otomatik-yakalama-ai-sağlayıcısı) altında.
3. OpenCode’da normal şekilde çalışın. Bir oturum boşta kaldığında otomatik yakalama hatırlanmaya değer teknik bağlamı çıkarır ve saklar.
4. Sonraki oturumlarda ilgili bellekler bağlama enjekte edilir (bkz. `chatMessage` / sıkıştırma ayarları). Bunlara `http://127.0.0.1:4747` adresindeki web arayüzünden göz atın veya düzenleyin.
5. Bir şeyin hemen saklanmasını veya alınmasını istediğinizde `memory` aracını kullanın (bkz. [Kullanım Örnekleri](#kullanım-örnekleri)).

### Otomatik ve manuel bellek

| Yaklaşım                                                       | Ne zaman çalışır                                  | Sizin yaptığınız                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Otomatik yakalama** (`autoCaptureEnabled: true`, varsayılan) | Oturum boşta kaldığında konuşma turlarından sonra | Hiçbir şey — çıkarım otomatiktir                                                           |
| **Manuel** `memory` aracı / komutlar                           | İsteğe bağlı                                      | `add`, `search`, `list`, `profile`, `forget`, `list-shards`, `migrate`, `export`, `import` |

Manuel arama/ekleme/listeleme, otomatik yakalama için yapılandırılmış bir sağlayıcı olmasa bile çalışır. Otomatik yakalama ve kullanıcı profili öğrenme, yapılandırılmış/araç-çağrısı çıktısı döndürebilen bir sağlayıcı gerektirir.

### Bellek ve AGENTS.md / proje dokümanları

| **Bellekte** saklayın                                                  | **AGENTS.md** / statik dokümanlarda saklayın                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Projeye özgü kararlar, hata kalıpları, “X’i denedik ve başarısız oldu” | Nadiren değişen kararlı kurallar ve iş akışları                 |
| Oturumlar boyunca keşfedilen kullanıcı tercihleri                      | Her zaman geçerli kodlama kuralları ve süreç                    |
| Sohbetler arasında sizi takip etmesi gereken gerçekler                 | Erişimden bağımsız olarak her ajanın görmesi gereken talimatlar |

Parmak kuralı: kalıcı bir proje talimatıysa AGENTS.md’ye koyun; gerçek çalışmadan büyüyen bağlamsa belleğin (veya otomatik yakalamanın) tutmasına izin verin.

### Akıllı prompt tabanlı bellek çıkarımı

Özellik listesindeki bu ifade **otomatik yakalama**dır: bir konuşmadan sonra arka plan bir AI isteği teknik çalışmayı özetler ve bellek olarak kaydeder. Sizden özel bir prompt gerekmez. Ayarlandığında `opencodeProvider` / `opencodeModel` kullanır; aksi halde manuel `memoryProvider` yedeğine düşer.

### Kullanıcı profili

**Kullanıcı Profili**, nasıl çalışmayı sevdiğinizin (tercihler, alışkanlıklar) ayrı, projeler arası bir özetidir. Bir aralıkta güncellenir (`userProfileAnalysisInterval`, varsayılan her 10 analiz edilen prompt), web arayüzünün profil görünümünde gösterilir ve `memory({ mode: "profile" })` ile okunabilir. Normal kullanım için elle doldurmazsınız — bir sağlayıcı hazır olduğunda profil öğrenme doldurur. Çıktı dili `autoCaptureLanguage`’ı izler (varsayılan `"auto"`, prompt’larınızın dilini yansıtır); otomatik yakalanan bellekler için aynı ayar kullanılır.

**“No profile found. Keep chatting to build your profile.”** beklenen boş durumdur, bir çökme değildir. Profil öğrenme şunları gerektirir:

1. Erişilebilir bir sağlayıcıyla çalışan otomatik yakalama (`opencodeProvider` + `opencodeModel`, veya `memoryModel` + `memoryApiUrl` ile eksiksiz bir manuel yedek).
2. Son analizden bu yana yeterli oturum prompt’u — en az `userProfileAnalysisInterval` (varsayılan **10**).
3. O sağlayıcının yapılandırılmış/araç-çağrısı çıktısını desteklemesi (otomatik yakalama ile aynı gereksinim).

Bir süre sohbet ettikten sonra hâlâ bu mesajı görüyorsanız, otomatik yakalamanın günlüklerde gerçekten ateşlendiğini ve yapılandırılmış sağlayıcının başarılı olduğunu kontrol edin (sağlayıcı hata verdiğinde başarısız profil analizi artık genel bir boş durumun ardında gizlenmez).

### Web arayüzü

Bellek–prompt zaman çizelgesine göz atmak, yakalamaları incelemek ve kullanıcı profilini yönetmek için `http://127.0.0.1:4747` adresini açın. Sunucuyu loopback dışına bağlarsanız bkz. [Web arayüzü HTTP Basic Auth](#web-arayüzü-http-basic-auth).

## Kullanım Örnekleri

```typescript
memory({ mode: "add", content: "Project uses microservices architecture" });
memory({ mode: "search", query: "architecture decisions" });
memory({ mode: "search", query: "architecture decisions", scope: "all-projects" });
memory({ mode: "profile" });
memory({ mode: "list", limit: 10 });
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
memory({ mode: "export", outputPath: "./memories.json" });
memory({ mode: "import", inputPath: "./memories.json" });
```

Görsel bellek gezinme ve yönetimi için web arayüzüne `http://127.0.0.1:4747` adresinden erişin.

**Ağ bağlama güvenliği:** UI’yi bilerek dışarı açmadığınız sürece `webServerHost`’u `127.0.0.1`’de tutun. `0.0.0.0`’a (veya herhangi bir loopback dışı ana bilgisayara) bağlamak `webServerApiToken` gerektirir; tüm `/api/*` istekleri ardından `Authorization: Bearer <token>` veya `X-Opencode-Mem-Token` göndermelidir. Tarayıcının saklayıp göndermesi için UI’yi `?apiToken=<token>` ile açın.

Boyut migrasyonları önce her yeni embedding’i üretir, bunları geçici indeksli bir shard’a içe aktarır, satır sayısını doğrular ve ancak o zaman orijinal dosyayı değiştirir. Başarısız migrasyonlar kaynak shard’a dokunmaz.

## Yapılandırma Temelleri

`~/.config/opencode/opencode-mem.jsonc` konumunda yapılandırın:

**Windows:** `%USERPROFILE%\.config\opencode\opencode-mem.jsonc` (yukarıdakiyle aynı `.config\opencode` dizini — AppData değil). Varsayılan depolama `%USERPROFILE%\.opencode-mem\data` olarak çözülür (`~` biçimi Windows’ta da kullanıcı ev dizinine genişler).

Eklenti ilk başlangıçta bu yolda tam yorumlu bir şablon oluşturur. Her ayar ve yorum için bkz. [`opencode-mem.example.jsonc`](opencode-mem.example.jsonc).

### Sohbet mesajı yakalama ve enjekte etme (`chatMessage`)

Bu ayarlar `~/.config/opencode/opencode-mem.jsonc` içindeki `chatMessage` anahtarı altında yaşar:

| Seçenek                                                | Varsayılan       | Ne yapar                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                                              | `true`           | Yazılan kullanıcı prompt’larını yakala ve bellek bağlamını enjekte et.                                                                                                                                                                                                                                                         |
| `injectOn`                                             | `"first"`        | Bellek bağlamını bir oturumun ilk kullanıcı mesajında veya `"always"` ile her yazılan turda enjekte et.                                                                                                                                                                                                                        |
| `maxMemories` / `excludeCurrentSession` / `maxAgeDays` | `3` / `true` / — | Enjekte edilen bağlamın kaç bellek tutacağı, mevcut oturumda yakalanan belleklerin hariç tutulup tutulmayacağı ve isteğe bağlı gün cinsinden yaş sınırı.                                                                                                                                                                       |
| `filterInjectedPrompts`                                | `true`           | Ana bilgisayar veya diğer OpenCode eklentileri tarafından enjekte edilen prompt metnini (sistem hatırlatıcıları, orkestrasyon yönergeleri, arka plan görev bildirimleri) atla; böylece kullanıcı yazmış gibi asla saklanmaz.                                                                                                   |
| `injectionMarkers`                                     | yerleşikler      | Enjekte edilmiş blokları tanımlayan ek işaretçiler; yerleşik listeye eklenir, asla onun yerine geçmez.                                                                                                                                                                                                                         |
| `captureChildSessions`                                 | `false`          | Orkestratör alt oturumlarından (`parentID` olan oturumlar, örn. OpenCode görev/alt ajan çocukları) prompt yakala. Bunların “kullanıcı” mesajları sizin değil üst ajan tarafından yazılır; bu nedenle varsayılan olarak saklanmaz, otomatik yakalanmaz, profil öğrenmede kullanılmaz veya enjekte edilmiş bellek bağlamı almaz. |

### Embedding seçimi / yapılandırması

Embedding’ler bellekler ve kullanıcı profili için benzerlik aramasını güçlendirir. Bunları aynı dosyada yapılandırın (`~/.config/opencode/opencode-mem.jsonc`). **MLX backend yoktur** — yerel embedding’ler Apple MLX değil, ONNX ile `@huggingface/transformers` kullanır.

**Yerel (varsayılan):** yalnızca `embeddingModel` ayarlayın. İlk kullanımda model Hugging Face’ten indirilir ve `{storagePath}/.cache` altında önbelleğe alınır (varsayılan `~/.opencode-mem/data/.cache`).

**Uzak (OpenAI uyumlu):** hem `embeddingApiUrl` hem `embeddingApiKey` ayarlayın. Eklenti ardından Bearer belirteciyle `{embeddingApiUrl}/embeddings` çağırır. `embeddingApiKey`, `memoryApiKey` ile aynı gizli biçimleri kabul eder (`literal`, `env://…`, `file://…`).

| Anahtar                    | Rol                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embeddingModel`           | Hugging Face kimliği (yerel) veya API model adı (uzak). Varsayılan: `Xenova/nomic-embed-text-v1`                                                   |
| `embeddingDimensions`      | İsteğe bağlı geçersiz kılma; genellikle atlayın — boyutlar yerleşik bir haritadan alınır                                                           |
| `embeddingPooling`         | Yerel pooling: `"mean"` (varsayılan), `"cls"` veya `"last_token"`. Ayarlanmamış → küçük bilinen-model ön ayarı veya `"mean"`                       |
| `embeddingQueryPrefix`     | Sorgu-görevi embedding’leri için önek. Ayarlanmamış → model ön ayarı veya `embeddingUseTaskPrefixes` true iken Nomic. Açık `""` devre dışı bırakır |
| `embeddingDocumentPrefix`  | Belge-görevi embedding’leri için önek (`embeddingQueryPrefix` ile aynı çözüm kuralları)                                                            |
| `embeddingUseTaskPrefixes` | Özel/ön ayar önekleri ayarlanmamışken Nomic `search_query:` / `search_document:` öneklerine katılma. Varsayılan `false`                            |
| `embeddingDtype`           | İsteğe bağlı yerel ONNX dtype geçersiz kılması (örn. `"q8"`, `"fp32"`). Ayarlandığında transformers.js `pipeline({ dtype })`’a iletilir            |
| `embeddingApiUrl`          | OpenAI uyumlu bir embeddings API’si için temel URL (`/v1` ötesinde sondaki yol yok)                                                                |
| `embeddingApiKey`          | O uç nokta için API anahtarı (`embeddingApiUrl` ile birlikte gerekli)                                                                              |

Önerilen yerel modeller:

| Model                                | Boyut | Notlar                                           |
| ------------------------------------ | ----- | ------------------------------------------------ |
| `Xenova/nomic-embed-text-v1`         | 768   | Varsayılan; çok dilli, 8192 bağlam; mean pooling |
| `Xenova/jina-embeddings-v2-base-en`  | 768   | Yalnızca İngilizce, 8192 bağlam                  |
| `Xenova/jina-embeddings-v2-small-en` | 512   | Daha hızlı, 8192 bağlam                          |
| `Xenova/all-MiniLM-L6-v2`            | 384   | Çok hızlı, 512 bağlam                            |
| `Xenova/all-mpnet-base-v2`           | 768   | İyi kalite, 512 bağlam                           |
| `Xenova/bge-m3`                      | 1024  | Çok dilli; otomatik CLS pooling                  |
| `intfloat/multilingual-e5-large`     | 1024  | Otomatik `query:` / `passage:` önekleri          |

Örnek — uzak OpenAI embedding’leri:

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "env://OPENAI_API_KEY",
  "embeddingModel": "text-embedding-3-small",
}
```

Örnek — yerel bge-m3 (pooling ön ayar üzerinden CLS’ye varsayılan; gerekirse geçersiz kılın):

```jsonc
{
  "embeddingModel": "Xenova/bge-m3",
  // "embeddingPooling": "cls",
  // "embeddingDtype": "q8",
}
```

`embeddingModel`, boyutlar, pooling veya görev öneklerini değiştirmek, depo ve sorgu vektörlerinin hizalı kalması için saklanan belleklerin yeniden embedding’ini gerektirebilir. Belirli bir veri dizini için bir modeli (ve pooling/önek ayarlarını) bir kez seçip bunlara bağlı kalmayı tercih edin.

**Desteklenmez — Intel Mac (`darwin/x64`):** Yerel kalıcılık, Intel Mac yerel bağlayıcısı yayınlamayan `@tursodatabase/database` gerektirir. Sabit `onnxruntime-node` sürümleri (`1.24.1+`, sabitlenmiş `1.30.0` dahil) de darwin/x64 içermez. Apple Silicon Mac, Linux veya Windows kullanın; ya da `embeddingApiUrl` + `embeddingApiKey` ile uzak bir uç nokta (yukarıdaki örnek). Desteklenen platformlarda `opencode-mem`, `onnxruntime-node@1.30.0`’ı sabitler (`1.24.1` / #225’ten Ort::Env teardown düzeltmesi) ve OpenCode iç içe kurulumlarının o bağlayıcıyı koruması için transformers’ı bir CJS çözüm shim’i üzerinden yükler. Transformers, o shim kurulmadan önce mutlak bir yola çözülür; böylece OpenCode’un Bun `--compile` ana bilgisayarı `Cannot find module '@huggingface/transformers' from ''` ile başarısız olmaz. Yükseltmeden sonra OpenCode’un iç içe eklenti önbelleğini temizleyin (`~/.cache/opencode/packages/opencode-mem@*`) ve yeniden kurun.

### Bellek kapsamı

- `scope: "project"`: yalnızca mevcut projeyi sorgula. Bu varsayılandır.
- `scope: "all-projects"`: tüm proje shard’larında `search` / `list` sorgula.
- `memory.defaultScope`, açık bir kapsam sağlanmadığında varsayılan sorgu kapsamını ayarlar.

### Web arayüzü HTTP Basic Auth

`webServerHost` loopback dışında herhangi bir şeye ayarlandığında (örneğin `0.0.0.0`), web arayüzüne ağdaki herkes erişebilir. Belleklerinizi LAN’dan uzak tutmak için web sunucusunu diğer her şey için kullanılan aynı yapılandırma dosyası üzerinden HTTP Basic Auth ile kapayın:

```jsonc
{
  "webServerHost": "0.0.0.0", // optional: reach the UI from the LAN
  "webServerAuthPassword": "pick-a-strong-one",
  "webServerAuthUsername": "admin", // optional, defaults to the current OS user
}
```

| Alan                    | Varsayılan               | Etki                                                                                                                          |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `webServerAuthPassword` | _(boş)_                  | Ayarlandığında sunucu her istekte HTTP Basic Auth kimlik bilgileri ister. Varsayılan açık davranışı korumak için boş bırakın. |
| `webServerAuthUsername` | OS kullanıcısı (`$USER`) | Basic Auth challenge’ının gerektirdiği kullanıcı adı.                                                                         |

`webServerAuthPassword`, `memoryApiKey` ile aynı gizli biçimleri kabul eder:

- bir düz metin dize (basit, kişisel makineler için uygun),
- başlangıçta ortamdan değeri almak için `env://SOME_ENV_VAR`,
- bir dosyadan okumak için `file:///path/to/secret` (`chmod 600` önerilir — dosya dünya tarafından okunabilirse eklenti uyarır).

Tarayıcı yerel Basic Auth iletişim kutusunu açar ve kimlik bilgilerini mevcut oturum için hatırlar; tüm tarayıcı pencerelerini kapatmak onları siler, bu nedenle tarayıcıyı yeniden açmak yeniden oturum açmayı gerektirir. Kimlik bilgileri sabit süreli bir kontrolle karşılaştırılır ve kimlik doğrulanmamış 401 yanıtı `Cache-Control: no-store` taşır; böylece hiçbir ara önbellek onu yeniden oynatmaz. Auth açıkken CORS da gevşetilir; böylece aynı LAN’daki diğer araçlar kimlik doğrulamasından sonra API ile konuşabilir.

### İç içe repolar arasında tek proje belleğini paylaşma

Varsayılan olarak bir proje, onu çevreleyen git deposuyla tanımlanır; bu nedenle her
fiziksel git deposu kendi yalıtılmış bellek deposunu alır. Bu, çoklu-repo
çalışma alanları için yanlıştır — Google [`repo`](https://gerrit.googlesource.com/git-repo/+/HEAD/Docs/manual-repo.md)
ile yönetilen ağaçlar, monorepolar veya birkaç iç içe git deposunun tek bir
mantıksal projeye ait olduğu herhangi bir düzen — çünkü her alt depo silolanırdı.

Çalışma alanı köküne boş bir **`.opencode-mem-project`** işaretçi dosyası bırakın:

```
my-workspace/
├── .opencode-mem-project   ← workspace root
├── kernel/                 (own git repo)
├── userspace/              (own git repo)
└── tools/                  (own git repo)
```

İşaretçinin altındaki herhangi bir yerde başlatılan her oturum ardından o
köke çözülür ve çalışma dizininin hangi alt depoda yaşadığına bakılmaksızın
tek bir bellek deposunu paylaşır:

```sh
touch ~/my-workspace/.opencode-mem-project
```

İşaretçi, her kod yolunun zaten ilettiği çalışma dizininden yukarı yürüyerek
aranır (eklentinin çalışma dizini, web API’nin `process.cwd()`’si); böylece
kimlik **dizin odaklı ve süreçten bağımsızdır**.
Burada güvenilmez olacak ortam değişkenlerine veya genel bir yapılandırma
değerine dayanmaz: opencode-mem, tek bir web sunucusunu paylaşan birden fazla
opencode sürecinde çalışır ve bu süreçlerin yalnızca bazıları belirli bir
ortam değişkenini taşır. İşaretçiyle proje kökü her zaman oturumun gerçekten
çalıştığı yerden türetilir.

İşaretçi, git tespitine göre önceliklidir. Mevcut olduğunda alt deponun kendi
git remote’u kasıtlı olarak yok sayılır (yalnızca bir iç içe depoyu tanımlardı).
İşaretçi olmadan davranış değişmez (git tabanlı kimlik).

### Proje belleklerini taşıma veya kurtarma

opencode-mem proje shard’larını proje kimliğinin bir karmasıyla anahtarlar. Bir
depoyu taşımak (OS migrasyonu, yol yeniden düzenleme, Windows bağlama noktasından
yerel bir yola geçiş) bu nedenle eski shard’ı
`~/.opencode-mem/data/projects/` altında yetim bırakabilir; yeni yol için yeni
boş bir shard oluşturulurken.

Bunlar terminalde çalıştırılacak komutlar değil, JSON argümanlı OpenCode
`memory` araç çağrılarıdır. Issue tarzı `memory migrate --from ...` notasyonu
`memory({ mode: "migrate", fromPath: "..." })` ile eşleşir.

**1. Eski yolu hâlâ bildiğinizde yerel taşıma**

OpenCode’u **yeni** proje dizininde açın. Hedef proje zaten bellek
içermemelidir (çatışmada migrasyon değişmeden iptal edilir). Herhangi bir şeyi
değiştirmeden önce algılanan kaynağı, hedefi ve dosya eylemlerini önizleyin:

```typescript
memory({ mode: "migrate", fromPath: "/old/path/to/project", dryRun: true });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
```

Güvenlik için migrasyon, saklanan proje dizini hâlâ var olan bir kaynağı reddeder.
Aktif bir kaynağı kasıtlı olarak taşımak istiyorsanız önce dry-run çıktısını
inceleyin ve ardından `allowLinkedSource: true` geçirin. Orijinal kaynak shard
dosyaları zaman damgalı `*.pre-path-migrate-*.bak` yedekleri olarak saklanır.

**2. Eski yol yok — önce yetim shard’ı keşfedin**

```typescript
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromHash: "fa645294d88bbae2" });
```

`list-shards` her proje karmasını, saklanan `projectPath`’i, bellek sayısını
ve durumu (`current`, `linked`, `orphaned`, `missing-file`, `empty` veya
`ambiguous`) bildirir. `fromHash`, bu çağrı tarafından döndürülen 16 karakterlik
küçük harf onaltılık `scopeHash`’tir. Eski dizin artık yoksa veya birden fazla
shard aynı saklanan yolu içeriyorsa bunu tercih edin; çünkü git tabanlı kimlikler
eksik bir yoldan her zaman yeniden hesaplanamaz.

**3. Makineler arası yedekleme / geri yükleme**

```typescript
// on the source machine / old checkout
memory({ mode: "export", outputPath: "./memories.json" });

// on the destination machine / new checkout
memory({ mode: "import", inputPath: "./memories.json", dryRun: true });
memory({ mode: "import", inputPath: "./memories.json" });
```

Export, vektörsüz sürümlü bir JSON belgesi yazar. Import, bellekleri mevcut
projeye yeniden eşler ve şu anda yapılandırılmış modelle embedding’leri yeniden
hesaplar. Import, mevcut bir projeye bellek ekler; ancak yinelenen bellek
kimlikleri yazmadan önce tüm import’u iptal eder; bu, boş bir hedef gerektiren
`migrate`’ten farklıdır.

Export dosyaları düz metindir ve bellek içeriği, kullanıcı adları/e-posta
adresleri, depo URL’leri ve mutlak proje yolları içerebilir. Bunları diğer
hassas yedekler gibi saklayın ve artık gerekmediğinde silin. Tamamen özel
girdiler atlanır; kullanıcı profilleri ve prompt geçmişi dahil edilmez. Belge
`schemaVersion: 1` içerir; import’lar tahmin etmek yerine daha yeni desteklenmeyen
şema sürümlerini reddeder.

### Otomatik yakalama AI sağlayıcısı

Otomatik yakalama, teknik çalışmayı özetlemek ve bellek olarak kaydetmek için arka planda bir AI isteği çalıştırır. Aşağıdaki sağlayıcı yapılandırmalarından birine ihtiyaç duyar.

**Önerilen:** opencode’da zaten kimlik doğrulanmış ve yapılandırılmış çıktıyı destekleyen bir sağlayıcı kullanın:

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

Eklenti, sağlayıcı uç noktalarını doğrudan çağırmak yerine yapılandırılmış çıktı isteklerini opencode’un oturum API’sine gönderir; böylece kimlik doğrulama, belirteç yenileme ve sağlayıcı yönlendirme opencode’a aittir. Sağlayıcı adı `opencode providers list` içindeki bir girdiyle eşleşmelidir ve seçilen model opencode üzerinden yapılandırılmış JSON çıktısını desteklemelidir.

İsteğe bağlı olarak `"opencodeVariant": "xhigh"` ile bir model muhakeme varyantını sabitleyin (örn. grok-4.7 için). Eklentinin dahili LLM çağrılarına uygulanır (otomatik yakalama özetleri, profil öğrenme, profil temizleme); `opencodeModel` `"inherit"` olsa bile, böylece arka plan çalışması etkileşimli oturumdan farklı bir muhakeme düzeyi kullanabilir.

Yavaş muhakeme modelleri (veya çok büyük profil prompt’ları) varsayılan 90 sn yapılandırılmış çıktı bütçesini aşabilir. Dahili yapılandırılmış çıktı çağrıları (otomatik yakalama özetleri, profil öğrenme) için uzatmak üzere `"opencodeTimeoutMs"` (milisaniye) ayarlayın — örn. 3 dakika için `"opencodeTimeoutMs": 180000`. Değerler 10000..600000’e sıkıştırılır; varsayılan 90000 kalır. Sayısal dizgeler zorlanır. Profil temizleme ayrı, daha uzun bir zaman aşımı kullanır.

Desteklenen sağlayıcılar: `opencode providers list` tarafından listelenen herhangi bir sağlayıcı (örn. `anthropic`, `openai`, `github-copilot`, ...).

`opencodeProvider` ve `opencodeModel` ayarlanmışsa, aşağıdaki manuel `memoryProvider` ayarlarına göre önceliklidirler.

**Oturum modelini izle:** çağrı anında sabitlenmiş bir kimlik yerine somut bir OpenCode modeli kullanmak için `"opencodeModel": "inherit"` ayarlayın. **Otomatik yakalama** için her prompt `chat.params` kancası üzerinden kaydedilir ve yakalama isteği o prompt’un sağlayıcı/modelini yeniden kullanır. **Profil öğrenme** ve diğer yapılandırılmış çıktı yolları için (tek bir kullanıcı mesajına bağlı değildir), `inherit` OpenCode’un `model.json` son liste içindeki en son modele düşer (yapılandırılmış `opencodeProvider` tercih edilir). Literâl model kimliği `inherit` göndermek asla geçerli değildir ve daha önce bu yollarda `ProviderModelNotFoundError: Model not found: <provider>/inherit`’e neden olmuştur. `opencodeProvider` yine de normal yapılandırma kapısı olarak gereklidir.

**Yedek:** Manuel API yapılandırması (opencodeProvider kullanılmıyorsa):

```jsonc
"memoryProvider": "openai-chat",
"memoryModel": "gpt-4o-mini",
"memoryApiUrl": "https://api.openai.com/v1",
"memoryApiKey": "sk-...",
```

**API Anahtarı Biçimleri:**

```jsonc
"memoryApiKey": "sk-..."
"memoryApiKey": "file://~/.config/opencode/api-key.txt"
"memoryApiKey": "env://OPENAI_API_KEY"
```

Manuel `memoryProvider` modları:

- `openai-chat`: Araç/fonksiyon çağrısıyla OpenAI Chat Completions uyumlu API. Seçilen üst akış modeli ve proxy araç çağrılarını koruduğunda LiteLLM gibi uyumlu proxy’lerle çalışabilir.
- `openai-responses`: Fonksiyon çağrısı çıktısıyla OpenAI Responses API.
- `anthropic`: Araç kullanımıyla Anthropic Messages API.
- `minimax`: MiniMax Anthropic Messages uyumlu uç noktası. `memoryApiUrl`’yi küresel uç noktaya (`https://api.minimax.io`) veya Çin uç noktasına (`https://api.minimaxi.com`) ayarlayın; `/anthropic/v1/messages` yolu ve `x-api-key` başlığı otomatik uygulanır. Güncel modeller arasında `MiniMax-M3` (1.000.000 jeton bağlam; uyarlanabilir veya devre dışı düşünme) ve `MiniMax-M2.7` (204.800 jeton bağlam; her zaman açık düşünme) vardır. `MiniMax-M3`, `memoryExtraParams` üzerinden uyarlanabilir düşünmeyi destekler.
- `orcarouter`: Ad alanlı model kimlikleriyle OpenAI uyumlu model ağ geçidi. `memoryApiUrl` ve `memoryModel` isteğe bağlıdır — varsayılanları `https://api.orcarouter.ai/v1` ve `orcarouter/auto`’dur (istek başına yetenekli bir model seçen bir yönlendirme takma adı). `memoryModel` ayarlarsanız `openai/gpt-5.5` veya `deepseek/deepseek-v4-flash` gibi ad alanlı bir kimlik kullanın; OrcaRouter çıplak model adlarını reddeder. Örnek:
  ```jsonc
  "memoryProvider": "orcarouter",
  "memoryApiKey": "<OrcaRouter API key>",
  ```
  [OrcaRouter](https://www.orcarouter.ai) aynı uç noktada AI ajanları için ağ geçidi düzeyinde, sıfır güven güvenlik de çalıştırır — her prompt/yanıtı tarar ve varsayılan-reddet temelinde her araç çağrısını yönetir; uygulama kodu değişikliği gerekmez.
- `atlas-cloud`: [Atlas Cloud](https://www.atlascloud.ai) için OpenAI uyumlu Chat Completions ön ayarı. `memoryApiUrl` ve `memoryModel` isteğe bağlıdır — varsayılanları `https://api.atlascloud.ai/v1` ve `deepseek-ai/deepseek-v4-pro`’dur. `memoryApiKey` atlanırsa ortamdan `ATLASCLOUD_API_KEY` kullanılır. Örnek:
  ```jsonc
  "memoryProvider": "atlas-cloud",
  "memoryApiKey": "env://ATLASCLOUD_API_KEY",
  ```
  Bu sağlayıcı seçildiğinde otomatik yakalama / profil prompt’ları, model yanıtları ve ilgili konuşma bağlamı `https://api.atlascloud.ai` adresine iletilir.

Sorun giderme:

- Otomatik yakalama hataları manuel `memory` araç kullanımını engellemez.
- Otomatik yakalama bir sağlayıcının bağlı olmadığını bildirirse, sağlayıcı adını `opencode providers list` ile doğrulayın ve önce o sağlayıcıyı opencode’da yapılandırın.
- Bir proxy veya özel sağlayıcı yapılandırılmış/araç çıktısı yerine düz metin döndürürse, başka bir model/sağlayıcı seçin veya yukarıdaki manuel sağlayıcı modlarından birini kullanın.
- `temperature` reddeden modeller için manuel API yapılandırması kullanırken `"memoryTemperature": false` ekleyin.
- Zorlanmış araç çağrılarını (`tool_choice: "required"`, örn. bazı düşünme modları) reddeden modeller için `openai-chat` / `orcarouter` / `atlas-cloud` kullanırken `"forceToolChoice": false` ekleyin.
- `opencodeProvider` / `opencodeModel` için (örn. DeepSeek V4 thinking), OpenCode yapılandırılmış çıktı için hâlâ zorlanmış `tool_choice` gönderir. opencode-mem dahili `opencode-mem-structured` ajanında düşünmeyi devre dışı bırakır (ve varyant birleştirmesinden sonra bunu `chat.params` içinde yeniden uygular); böylece otomatik yakalama ve profil öğrenme tamamlanabilir. Etkileşimli sohbet ajanınız değişmez. Yakalama hâlâ bir thinking/`tool_choice` hatasıyla başarısız olursa, `opencodeModel` için düşünmeyen bir model seçin veya eksiksiz bir manuel yedek yapılandırın (`memoryModel` + `memoryApiUrl`).
- **`opencode-claude-auth` / Claude Code:** otomatik yakalama, kimlik doğrulanmış `anthropic` sağlayıcınızla OpenCode kullanır. Zorlanmış `format: json_schema` Claude-auth ile sık sık döngüye girer; bu nedenle opencode-mem `opencodeProvider: "anthropic"` için kimlik doğrulamayı koruyan bir **metin-JSON** yolu kullanır (zorlanmış `StructuredOutput` araçları yok; yanıt Zod ile ayrıştırılır). Bir adım watchdog’u hâlâ 2 adımdan sonra kaçak dahili oturumları iptal eder. Yakalama hâlâ başarısız olursa, eksiksiz bir manuel Anthropic API anahtarı yedeği yapılandırın (`memoryProvider: "anthropic"` + `memoryModel` + `memoryApiUrl` + `memoryApiKey`) — Claude Pro/Max OAuth OpenCode dışında yeniden kullanılamaz.
- **Desteklenmeyen platformlar:** Intel Mac (`darwin/x64`) desteklenmez — `@tursodatabase/database` ve sabit `onnxruntime-node` sürümleri (sabitlenmiş `1.30.0`) x64 yerel bağlayıcı yayınlamaz. Apple Silicon, Linux veya Windows kullanın; ya da `embeddingApiUrl` + `embeddingApiKey` ile uzak bir embedding uç noktası. MLX desteklenmez.

## Genel Alt Yol Dışa Aktarımları

Ana eklenti girişine ek olarak `opencode-mem`, diğer opencode eklentilerinin
doğrudan içe aktarabileceği bir kararlı alt yol dışa aktarır. Bu, aynı bellek
deposuna okuyan veya yazan üçüncü taraf araçlar yazarken konteyner-etiket
sözleşmelerini tersine mühendislik ihtiyacını ortadan kaldırır.

### `opencode-mem/tags`

Kanonik konteyner-etiket yardımcıları. opencode-mem’in otomatik yakalanan
bellekleri kapsamlandırmak için kullandığı aynı işlevler.

```ts
import { getProjectTagInfo, getUserTagInfo, getTags } from "opencode-mem/tags";

// Canonical project tag derived from cwd (git remote URL if present, else
// the project root path). Format: `opencode_project_<sha16>`.
const projectTag = getProjectTagInfo(process.cwd()).tag;

// Canonical user tag derived from `git config user.email`.
// Format: `opencode_user_<sha16>`.
const userTag = getUserTagInfo().tag;

// Both at once.
const { user, project } = getTags(process.cwd());
```

Bu yardımcıların ürettiği etiketler, otomatik yakalamanın yazdıklarıyla eşleşir;
böylece `POST /api/memories` çağıran üçüncü taraf eklentiler, sistemin geri
kalanının zaten anladığı aynı shard’lara iner. Alt dizgesi `_project_` veya
`_user_` olmayan elle yapılmış etiketler, `/api/stats` ve `/api/memories`’in
sessizce filtrelediği gölge shard’lara düşer — bu yardımcıları kullanmak o
tuzaktan kaçınır.

## Geliştirme ve Katkı

Yerelde derleyin ve test edin:

```bash
bun install
bun run build
bun run typecheck
bun run format
```

Bu proje, AI kodlama ajanları için nihai bellek eklentisi olmak üzere aktif olarak katkı arıyor. Hataları düzeltmek, özellik eklemek, belgeleri iyileştirmek veya embedding model desteğini genişletmek olsun, katkılarınız kritiktir. Kod tabanı iyi yapılandırılmış ve iyileştirmeye hazırdır. Lütfen Issue veya Feature request şablonlarıyla issue açın ve bir PR gönderdiğinizde pull request şablonunu doldurun — katkıları hızlıca inceler ve birleştiririz.

**README çevirileri:** `README.md` (İngilizce) esas kaynaktır. İçeriğini değiştirdiğinizde kardeş dosyaları `README.de.md`, `README.zh.md`, `README.ar.md`, `README.tr.md` ve `README.nl.md` buna uyacak şekilde güncelleyin.

## Lisans ve Bağlantılar

MIT License - see LICENSE file

- **Depo**: https://github.com/tickernelz/opencode-mem
- **Issues**: https://github.com/tickernelz/opencode-mem/issues
- **OpenCode Platform**: https://opencode.ai

[opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory) tarafından ilham alınmıştır
