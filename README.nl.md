# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![GitHub stars](https://img.shields.io/github/stars/tickernelz/opencode-mem.svg)](https://github.com/tickernelz/opencode-mem)

![OpenCode Memory Banner](.github/pics/banner.png)

[English](./README.md) | [Deutsch](./README.de.md) | [中文](./README.zh.md) | [العربية](./README.ar.md) | [Türkçe](./README.tr.md) | **Nederlands**

Een persistent geheugensysteem voor AI-codingagents dat langetermijncontextbehoud over sessies mogelijk maakt met lokale vectordatabasetechnologie.

## Kernfuncties

Lokale Turso/libSQL-database met native vectorzoekopdrachten, persistente projectherinneringen, automatisch leren van gebruikersprofielen, uniforme geheugen-prompttijdlijn, volledige web-UI, intelligente promptgebaseerde geheugenextractie, multi-provider AI-ondersteuning (OpenAI, Anthropic), 12+ lokale embeddingmodellen, slimme deduplicatie en ingebouwde privacybescherming.

## Vereisten

Deze plugin gebruikt embedded Turso (`@tursodatabase/database`) met `F32_BLOB`-vectoren en exacte cosinuszoekopdrachten via `vector_distance_cos`. Er is geen aparte vectordatabase of aangepaste SQLite-build vereist.

**Aanbevolen runtime:**

- Bun
- Standaard OpenCode-pluginomgeving
- Internettoegang bij eerste gebruik als je het standaard lokale embeddingmodel gebruikt, omdat het model wordt gedownload door `@huggingface/transformers`.
- Voor bron-/ontwikkelingsinstallaties: voer `bun install` uit vóór het bouwen of testen. Het gepubliceerde pluginpakket installeert zijn runtime-afhankelijkheden automatisch via OpenCode.

**CI-geteste platforms:** Linux, Windows en macOS 15 / macOS 26 op Apple Silicon (`darwin/arm64`). **Intel Mac (`darwin/x64`) wordt niet ondersteund** — `@tursodatabase/database` en vaste `onnxruntime-node`-releases leveren geen x64 native binding. Oudere macOS-releases zijn niet uitgesloten door die matrix; ze vallen simpelweg buiten de huidige set GitHub-hosted runners.

**Opmerkingen:**

- Vector-embeddings worden direct in Turso opgeslagen en doorzocht; inserts slaan `F32_BLOB`-vectoren op voor exacte cosinusranking.
- Vectorzoekopdrachten gebruiken exacte cosinusafstand via `vector_distance_cos` (geen DiskANN / approximatieve index), met optionele keyword-hybrid ranking wanneer een querystring wordt meegegeven (`@tursodatabase/database` levert geen FTS5).
- Sessieopzoekingen gebruiken een geïndexeerde `session_id`-kolom (teruggevuld vanuit `metadata.sessionID` op schema v2).
- Auto-capture en gebruikersprofiel-leren vereisen een AI-provider die structured/tool-call-output kan teruggeven. Memory search/add/list werken nog steeds zonder auto-capture-providerconfiguratie.

### Hardware- / resourceverwachtingen

opencode-mem vereist **geen** GPU. Lokale embeddings draaien op de CPU via `@huggingface/transformers` en ONNX (er is geen MLX-backend). Extra VRAM is niet nodig.

| Workload                                                       | Typische extra resources                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Lokale embeddings** (standaard `Xenova/nomic-embed-text-v1`) | Ongeveer **0,5–2 GB RAM** terwijl het model geladen is, afhankelijk van de Hugging Face-id die je kiest. Bij eerste gebruik wordt het model gedownload; de schijfcache staat onder `{storagePath}/.cache` (standaard `~/.opencode-mem/data/.cache`) en is vaak **honderden MB tot ~1–2 GB** per model. |
| **Remote embeddings** (`embeddingApiUrl` + `embeddingApiKey`)  | Verwaarloosbare lokale ML-RAM — alleen plugin- + Turso-overhead.                                                                                                                                                                                                                                       |
| **Database / plugin**                                          | Turso/libSQL op schijf onder `storagePath`. De grootte groeit met het aantal opgeslagen herinneringen, niet met GPU-geheugen.                                                                                                                                                                          |

Bovenstaande platformbeperkingen blijven gelden (geen Intel Mac `darwin/x64`; gebruik Apple Silicon, Linux, Windows of een remote embedding-endpoint). Zie [Embeddings kiezen / configureren](#embeddings-kiezen--configureren).

### Upgraden vanaf legacy SQLite-shards

Bij opstarten herstelt de plugin onderbroken re-embed-swaps, zet libSQL DiskANN-indexen om naar de huidige Turso-engine, en verifieert of upgradeert daarna het legacy shard-schema. Engineconversie draait ook wanneer een store al een voltooide legacy-migratiemarker heeft, en behoudt opgeslagen vectoren zonder opnieuw te embedden. Elke geconverteerde database wordt geback-upt als `<database>.pre-tursodb-<timestamp>.bak`.

Op macOS en Linux kunnen meerdere OpenCode-sessies hetzelfde `storagePath` delen via Turso’s experimentele `multiprocess_wal` (elk proces moet dezelfde modus gebruiken — herstart alle sessies na een upgrade). Op Windows weigert de engine die flag, dus slechts één OpenCode-sessie kan tegelijk de geheugendatabases bezitten.

Bij de eerste start na een upgrade migreert opencode-mem bestaande memory-shard-databases automatisch naar het native Turso/libSQL-vectorformaat:

- Elke shard wordt vóór herschrijven geback-upt als `<shard>.db.legacy.bak`
- Voortgang wordt per shard bijgehouden in `<shard>.db.turso-migrate.json`
- Een globale marker `.turso-migrated` wordt pas geschreven nadat alle shards succesvol zijn geverifieerd
- Draai geen meerdere OpenCode-instanties tegen hetzelfde `storagePath` tijdens migratie; een lockbestand (`.turso-migrate.lock`) voorkomt gelijktijdige migratie
- Handmatige dimensiemigraties gebruiken `.turso-operation.lock`; andere pluginprocessen weigeren nieuwe memory-writes tot de migratie klaar is

Als migratie wordt onderbroken, hervat de volgende start automatisch vanuit de backup.

Als een shard incompatibel wordt (bijvoorbeeld na wijziging van `embeddingDimensions`), worden writes geblokkeerd en blijft de originele database onaangeroerd. Gebruik de re-embed-migratie in de web-UI om een vervanging te bouwen en te verifiëren voordat deze wordt omgewisseld. De vorige shard blijft beschikbaar als `<shard>.db.pre-reembed-<pid>-<timestamp>.bak`.

## Schemamigraties

Lokale Turso-shards en huldatabases (`metadata.db`, `user-prompts.db`, `user-profiles.db`, `ai-sessions.db`) worden geüpgraded met geordende `PRAGMA user_version`-migraties in `src/services/turso/schema-migrations.ts`. Migraties zijn idempotent: bij starten van de plugin worden alleen openstaande versies toegepast.

## Aan de slag

Voor OpenCode v2 voeg je het pakket toe aan de native `plugins`-lijst:

```jsonc
{
  "plugins": ["opencode-mem@latest"],
}
```

OpenCode laadt ook automatisch de `./tui`-companion van het pakket zodat
auto-capture- / profiel- / fouttoasts in de TUI verschijnen (serverplugins
kunnen `ui.toast` niet rechtstreeks aanroepen). Je hebt geen tweede entry in
`plugins` nodig. Als je een CLI-only TUI tegen een remote OpenCode-server
draait, registreer `opencode-mem/tui` in de pluginlijst van die CLI (bijvoorbeeld
`cli.json`) zodat de companion kan inschrijven op toast-RPC-events.

Voor OpenCode v1 voeg je de standaard entrypoint toe aan je configuratie op
`~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["opencode-mem@latest"],
}
```

Met `@latest` (of een semver-bereik) en `autoUpdate: true` in `opencode-mem.jsonc` (standaard) wist de plugin de gecachte OpenCode-installatie wanneer een nieuwere npm-release beschikbaar is en vraagt je om te herstarten. Vastgezette versies zoals `opencode-mem@2.26.0` worden nooit automatisch bijgewerkt.

### Automatische geheugencontext op OpenCode v2

De v2-plugin levert automatische geheugencontext via de systeemcontext van het model.
Deze blokken worden niet toegevoegd aan de geschreven gebruikersprompt en niet opgeslagen in het chattranscript.
Met `chatMessage.injectOn: "first"` (de standaard) blijft de initiële context van de sessie
behouden over gebruikersbeurten en modelstappen. Met `"always"` wordt deze bij elke
geschreven gebruikersbeurt vernieuwd.

Na een host- of pluginherstart bouwt een hervatte sessie bij het volgende modelverzoek
zijn context opnieuw op vanuit de huidige memory store, ook als er geen nieuwe gebruikersprompt binnenkomt.
De herbouwde context kan afwijken van de oorspronkelijke naarmate herinneringen en het profiel evolueren.
Herstel legt geen synthetische gebruikersprompt vast en slaat geen tweede kopie van de
geheugentekst op in OpenCode-pluginopslag. Compaction invalideert de gecachte automatische
context; de bestaande compaction-memory-herstel blijft ook draaien.

### Een lokale checkout gebruiken

Om de plugin vanuit een lokale broncheckout te draaien in plaats van de npm-release: `bun install && bun run build` in de checkout, en wijs daarna de `plugins`-lijst naar de checkoutdirectory:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-mem"],
}
```

Wijs naar de pakketroot, niet naar `dist/` of een enkel bestand. OpenCode lost een directoryplugin op door terug te vallen op `<directory>/index` (OpenCode leest geen `package.json` `exports`/`main` voor een padspecificatie in huidige releases), daarom levert deze repository een dunne root-`index.js` die de gebouwde v2-entrypoint uit `dist/plugin.js` opnieuw exporteert, en een root-`tui.js` die `dist/tui.js` opnieuw exporteert voor de TUI-companion. Een pad naar een bestand wordt geweigerd (`configured plugin path must be a directory`), en een directory zonder root-`index.js` wordt stilzwijgend overgeslagen.

### Optionele databaseversleuteling in rust

Schakel AES-256-GCM-versleuteling in voor lokale Turso-shards in `~/.config/opencode/opencode-mem.jsonc`:

```jsonc
{
  "databaseEncryptionEnabled": true,
}
```

Bij de eerste start maakt de plugin `~/.config/opencode/opencode-mem-db.key` aan (32-byte hex-sleutel, `chmod 600`) en migreert bestaande plaintext-shards. Overschrijf met `"databaseEncryptionKey": "env://OPENCODE_MEM_DB_KEY"` of `"file://~/path/to.key"` als je de sleutel zelf beheert. Verlies van de sleutel betekent dat de versleutelde databases niet kunnen worden geopend.

**Windows:** gebruik `%USERPROFILE%\.config\opencode\opencode.json` (bijvoorbeeld `C:\Users\<you>\.config\opencode\opencode.json`). Deze plugin leest **niet** `%APPDATA%` of `%LOCALAPPDATA%` voor zijn OpenCode-pluginentry — plaats het bestand onder `.config\opencode` in je gebruikersprofiel en herstart OpenCode. Als de plugin niet verschijnt, controleer dat pad en herstart opnieuw.

De plugin wordt automatisch gedownload bij de volgende start.

## Dagelijks gebruik

Je hoeft OpenCode **niet** te vragen dingen te “onthouden” om de plugin te laten werken. Met de standaardinstellingen bouwt het geheugen zich op terwijl je werkt.

### Typische dagelijkse workflow

1. Schakel de plugin in (zie [Aan de slag](#aan-de-slag)) en herstart OpenCode.
2. Configureer een AI-provider voor auto-capture — aanbevolen: `opencodeProvider` + `opencodeModel` (of `"opencodeModel": "inherit"`). Details onder [Auto-capture AI-provider](#auto-capture-ai-provider).
3. Werk normaal in OpenCode. Wanneer een sessie idle wordt, extraheert auto-capture memorabele technische context en slaat die op.
4. In latere sessies worden relevante herinneringen in de context geïnjecteerd (zie `chatMessage` / compaction-instellingen). Blader of bewerk ze in de web-UI op `http://127.0.0.1:4747`.
5. Gebruik de `memory`-tool wanneer je iets meteen wilt opslaan of ophalen (zie [Gebruiksvoorbeelden](#gebruiksvoorbeelden)).

### Automatisch versus handmatig geheugen

| Aanpak                                                   | Wanneer het draait                                 | Wat jij doet                                                                               |
| -------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Auto-capture** (`autoCaptureEnabled: true`, standaard) | Na conversatiebeurten wanneer de sessie idle wordt | Niets — extractie is automatisch                                                           |
| **Handmatig** `memory`-tool / commands                   | Op verzoek                                         | `add`, `search`, `list`, `profile`, `forget`, `list-shards`, `migrate`, `export`, `import` |

Handmatige search/add/list werken nog steeds, ook als auto-capture geen provider geconfigureerd heeft. Auto-capture en gebruikersprofiel-leren hebben een provider nodig die structured/tool-call-output kan teruggeven.

### Geheugen versus AGENTS.md / projectdocumentatie

| Opslaan in **geheugen**                                                             | Opslaan in **AGENTS.md** / statische docs                |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Projectspecifieke beslissingen, bugpatronen, “we hebben X geprobeerd en het faalde” | Stabiele regels en workflows die zelden wijzigen         |
| Gebruikersvoorkeuren ontdekt over sessies                                           | Altijd-aan codingconventies en proces                    |
| Feiten die je over chats heen moeten volgen                                         | Instructies die elke agent moet zien, ongeacht retrieval |

Vuistregel: als het een blijvende projectinstructie is, zet het in AGENTS.md; als het context is die groeit uit echt werk, laat geheugen (of auto-capture) het bewaren.

### Intelligente promptgebaseerde geheugenextractie

Die zin in de functielijst is **auto-capture**: na een conversatie vat een achtergrond-AI-verzoek technisch werk samen en slaat het op als geheugen. Er is geen speciale prompt van jou nodig. Het gebruikt `opencodeProvider` / `opencodeModel` wanneer die zijn ingesteld, anders de handmatige `memoryProvider`-fallback.

### Gebruikersprofiel

Het **gebruikersprofiel** is een aparte, cross-projectsamenvatting van hoe jij wilt werken (voorkeuren, gewoonten). Het wordt bijgewerkt op een interval (`userProfileAnalysisInterval`, standaard elke 10 geanalyseerde prompts), getoond in de profielweergave van de web-UI, en leesbaar via `memory({ mode: "profile" })`. Je vult het voor normaal gebruik niet handmatig — profiel-leren vult het wanneer een provider klaar is. De uitvoertaal volgt `autoCaptureLanguage` (standaard `"auto"`, spiegelt de taal van je prompts), dezelfde instelling als voor auto-captured herinneringen.

**“No profile found. Keep chatting to build your profile.”** is de verwachte lege toestand, geen crash. Profiel-leren heeft nodig:

1. Auto-capture die draait met een bereikbare provider (`opencodeProvider` + `opencodeModel`, of een complete handmatige fallback met `memoryModel` + `memoryApiUrl`).
2. Genoeg sessieprompts sinds de laatste analyse — minstens `userProfileAnalysisInterval` (standaard **10**).
3. Dat die provider structured/tool-call-output ondersteunt (zelfde eis als auto-capture).

Als je een tijd hebt gechat en het bericht nog steeds ziet, controleer of auto-capture echt afgaat in de logs en of de geconfigureerde provider slaagt (mislukte profielanalyse verbergt zich niet meer achter een generieke lege toestand wanneer de provider een fout geeft).

### Web-UI

Open `http://127.0.0.1:4747` om de geheugen–prompttijdlijn te bekijken, captures te inspecteren en het gebruikersprofiel te beheren. Als je de server buiten loopback bindt, zie [Web-UI HTTP Basic Auth](#web-ui-http-basic-auth).

## Gebruiksvoorbeelden

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

Open de webinterface op `http://127.0.0.1:4747` voor visueel bladeren en beheer van herinneringen.

**Netwerkbindingsbeveiliging:** Houd `webServerHost` op `127.0.0.1` tenzij je de UI bewust blootstelt. Binding aan `0.0.0.0` (of een niet-loopback-host) vereist `webServerApiToken`; alle `/api/*`-verzoeken moeten dan `Authorization: Bearer <token>` of `X-Opencode-Mem-Token` meesturen. Open de UI met `?apiToken=<token>` zodat de browser die opslaat en meestuurt.

Dimensiemigraties genereren eerst elke nieuwe embedding, importeren die in een tijdelijke geïndexeerde shard, verifiëren het rijaantal, en vervangen pas daarna het originele bestand. Mislukte migraties laten de bronsshard onaangeroerd.

## Essentiële configuratie

Configureer op `~/.config/opencode/opencode-mem.jsonc`:

**Windows:** `%USERPROFILE%\.config\opencode\opencode-mem.jsonc` (zelfde `.config\opencode`-directory als hierboven — niet AppData). Standaardopslag lost op naar `%USERPROFILE%\.opencode-mem\data` (de `~`-vorm expandt ook op Windows naar je gebruikershome).

De plugin maakt bij de eerste start een volledig becommentarieerd template op dit pad. Voor elke instelling en commentaar, zie [`opencode-mem.example.jsonc`](opencode-mem.example.jsonc).

### Chatberichtvastlegging en -injectie (`chatMessage`)

Deze instellingen staan onder de `chatMessage`-sleutel in `~/.config/opencode/opencode-mem.jsonc`:

| Optie                                                  | Standaard        | Wat het doet                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                              | `true`           | Leg geschreven gebruikersprompts vast en injecteer geheugencontext.                                                                                                                                                                                                                                                             |
| `injectOn`                                             | `"first"`        | Injecteer geheugencontext bij het eerste gebruikersbericht van een sessie, of bij `"always"` elke geschreven beurt.                                                                                                                                                                                                             |
| `maxMemories` / `excludeCurrentSession` / `maxAgeDays` | `3` / `true` / — | Hoeveel herinneringen de geïnjecteerde context bevat, of herinneringen uit de huidige sessie worden uitgesloten, en een optionele leeftijdslimiet in dagen.                                                                                                                                                                     |
| `filterInjectedPrompts`                                | `true`           | Sla prompttekst over die door de host of andere OpenCode-plugins is geïnjecteerd (systeemherinneringen, orchestratierichtlijnen, achtergrondtaakmeldingen) zodat die nooit wordt opgeslagen alsof de gebruiker die heeft getypt.                                                                                                |
| `injectionMarkers`                                     | built-ins        | Extra markers die geïnjecteerde blokken identificeren; worden toegevoegd aan de ingebouwde lijst, vervangen die nooit.                                                                                                                                                                                                          |
| `captureChildSessions`                                 | `false`          | Leg prompts vast van orchestrator-childsessies (sessies met een `parentID`, bijv. OpenCode task/subagent-children). Hun “user”-berichten worden door de parent-agent geschreven, niet door jou, en worden standaard niet opgeslagen, auto-captured, gebruikt voor profiel-leren, of van geïnjecteerde geheugencontext voorzien. |

### Embeddings kiezen / configureren

Embeddings voeden similarity search voor herinneringen en het gebruikersprofiel. Configureer ze in hetzelfde bestand (`~/.config/opencode/opencode-mem.jsonc`). Er is **geen MLX-backend** — lokale embeddings gebruiken `@huggingface/transformers` met ONNX, niet Apple MLX.

**Lokaal (standaard):** stel alleen `embeddingModel` in. Bij eerste gebruik wordt het model gedownload van Hugging Face en gecached onder `{storagePath}/.cache` (standaard `~/.opencode-mem/data/.cache`).

**Remote (OpenAI-compatibel):** stel zowel `embeddingApiUrl` als `embeddingApiKey` in. De plugin roept dan `{embeddingApiUrl}/embeddings` aan met een Bearer-token. `embeddingApiKey` accepteert dezelfde geheime formaten als `memoryApiKey` (`literal`, `env://…`, `file://…`).

| Sleutel                    | Rol                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `embeddingModel`           | Hugging Face-id (lokaal) of API-modelnaam (remote). Standaard: `Xenova/nomic-embed-text-v1`                                              |
| `embeddingDimensions`      | Optionele override; meestal weglaten — dimensies worden opgezocht uit een ingebouwde map                                                 |
| `embeddingPooling`         | Lokale pooling: `"mean"` (standaard), `"cls"`, of `"last_token"`. Unset → klein known-model-preset of `"mean"`                           |
| `embeddingQueryPrefix`     | Prefix voor query-task-embeddings. Unset → modelpreset of Nomic wanneer `embeddingUseTaskPrefixes` true is. Expliciete `""` schakelt uit |
| `embeddingDocumentPrefix`  | Prefix voor document-task-embeddings (zelfde resolutieregels als `embeddingQueryPrefix`)                                                 |
| `embeddingUseTaskPrefixes` | Opt-in Nomic `search_query:` / `search_document:`-prefixes wanneer custom/preset-prefixes unset zijn. Standaard `false`                  |
| `embeddingDtype`           | Optionele lokale ONNX-dtype-override (bijv. `"q8"`, `"fp32"`). Indien gezet, doorgegeven aan transformers.js `pipeline({ dtype })`       |
| `embeddingApiUrl`          | Basis-URL voor een OpenAI-compatibele embeddings-API (geen trailing path voorbij `/v1`)                                                  |
| `embeddingApiKey`          | API-sleutel voor dat endpoint (vereist samen met `embeddingApiUrl`)                                                                      |

Aanbevolen lokale modellen:

| Model                                | Dims | Opmerkingen                                      |
| ------------------------------------ | ---- | ------------------------------------------------ |
| `Xenova/nomic-embed-text-v1`         | 768  | Standaard; meertalig, 8192 context; mean pooling |
| `Xenova/jina-embeddings-v2-base-en`  | 768  | Alleen Engels, 8192 context                      |
| `Xenova/jina-embeddings-v2-small-en` | 512  | Sneller, 8192 context                            |
| `Xenova/all-MiniLM-L6-v2`            | 384  | Zeer snel, 512 context                           |
| `Xenova/all-mpnet-base-v2`           | 768  | Goede kwaliteit, 512 context                     |
| `Xenova/bge-m3`                      | 1024 | Meertalig; auto CLS-pooling                      |
| `intfloat/multilingual-e5-large`     | 1024 | Auto `query:` / `passage:`-prefixes              |

Voorbeeld — remote OpenAI-embeddings:

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "env://OPENAI_API_KEY",
  "embeddingModel": "text-embedding-3-small",
}
```

Voorbeeld — lokaal bge-m3 (pooling standaard CLS via preset; override indien nodig):

```jsonc
{
  "embeddingModel": "Xenova/bge-m3",
  // "embeddingPooling": "cls",
  // "embeddingDtype": "q8",
}
```

Wijzigen van `embeddingModel`, dimensies, pooling of task-prefixes kan opnieuw embedden van opgeslagen herinneringen vereisen zodat store- en queryvectoren uitgelijnd blijven. Kies liever één keer een model (en pooling-/prefixinstellingen) en blijf daarbij voor een gegeven datadirectory.

**Niet ondersteund — Intel Mac (`darwin/x64`):** Lokale persistentie vereist `@tursodatabase/database`, dat geen Intel Mac native binding publiceert. Vaste `onnxruntime-node`-releases (`1.24.1+`, inclusief de vastgezette `1.30.0`) missen ook darwin/x64. Gebruik een Apple Silicon Mac, Linux of Windows, of een remote endpoint via `embeddingApiUrl` + `embeddingApiKey` (voorbeeld hierboven). Op ondersteunde platforms pinnet `opencode-mem` `onnxruntime-node@1.30.0` (Ort::Env teardown-fix uit `1.24.1` / #225) en laadt transformers via een CJS resolve-shim zodat geneste OpenCode-installaties die binding behouden. Transformers wordt naar een absoluut pad opgelost voordat die shim wordt geïnstalleerd, zodat OpenCode’s Bun `--compile`-host niet faalt met `Cannot find module '@huggingface/transformers' from ''`. Wis na een upgrade de geneste plugincache van OpenCode (`~/.cache/opencode/packages/opencode-mem@*`) en herinstalleer.

### Geheugenbereik

- `scope: "project"`: query alleen het huidige project. Dit is de standaard.
- `scope: "all-projects"`: query `search` / `list` over alle projectshards.
- `memory.defaultScope` stelt het standaard querybereik in wanneer geen expliciet bereik is opgegeven.

### Web-UI HTTP Basic Auth

Wanneer `webServerHost` op iets anders dan loopback staat (bijvoorbeeld `0.0.0.0`), is de web-UI bereikbaar voor iedereen op het netwerk. Om je herinneringen van het LAN te houden, beveilig de webserver met HTTP Basic Auth via hetzelfde configbestand als voor al het andere:

```jsonc
{
  "webServerHost": "0.0.0.0", // optioneel: UI bereikbaar vanaf het LAN
  "webServerAuthPassword": "pick-a-strong-one",
  "webServerAuthUsername": "admin", // optioneel, standaard de huidige OS-gebruiker
}
```

| Veld                    | Standaard              | Effect                                                                                                                          |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `webServerAuthPassword` | _(leeg)_               | Wanneer gezet, eist de server HTTP Basic Auth-credentials bij elk verzoek. Laat leeg om het open-by-default-gedrag te behouden. |
| `webServerAuthUsername` | OS-gebruiker (`$USER`) | Gebruikersnaam vereist door de Basic Auth-challenge.                                                                            |

`webServerAuthPassword` accepteert dezelfde geheime formaten als `memoryApiKey`:

- een letterlijke string (eenvoudig, prima voor persoonlijke machines),
- `env://SOME_ENV_VAR` om de waarde bij start uit de omgeving te halen,
- `file:///path/to/secret` om die uit een bestand te lezen (`chmod 600` aanbevolen — de plugin waarschuwt als het bestand world-readable is).

De browser toont zijn native Basic Auth-dialoog en onthoudt de credentials voor de huidige sessie; alle browservensters sluiten wist ze, dus opnieuw openen van de browser vereist opnieuw inloggen. Credentials worden vergeleken met een constant-time check, en de niet-geauthenticeerde 401-response draagt `Cache-Control: no-store` zodat geen intermediaire cache die opnieuw speelt. CORS wordt ook versoepeld zodra auth aan staat, zodat andere tools op hetzelfde LAN na authenticatie met de API kunnen praten.

### Eén projectgeheugen delen over geneste repo’s

Standaard wordt een project geïdentificeerd door zijn omsluitende git-repository, dus elke
fysieke git-repo krijgt zijn eigen geïsoleerde geheugenstore. Dat is verkeerd voor
multi-repo-workspaces — bomen beheerd door Google [`repo`](https://gerrit.googlesource.com/git-repo/+/HEAD/Docs/manual-repo.md),
monorepo’s, of elke layout waarin meerdere geneste git-repositories tot één
logisch project behoren — omdat elke subrepository silogeïsoleerd zou zijn.

Plaats een leeg **`.opencode-mem-project`**-markerbestand bij de workspaceroot:

```
my-workspace/
├── .opencode-mem-project   ← workspaceroot
├── kernel/                 (eigen git-repo)
├── userspace/              (eigen git-repo)
└── tools/                  (eigen git-repo)
```

Elke sessie die ergens onder de marker start, lost dan op naar die
root en deelt één geheugenstore, ongeacht in welke subrepo de werkdirectory
staat:

```sh
touch ~/my-workspace/.opencode-mem-project
```

De marker wordt opgezocht door omhoog te lopen vanaf de werkdirectory die elk
codepad al doorgeeft (de werkdirectory van de plugin, de `process.cwd()` van de web-API),
dus identiteit is **directorygedreven en procesonafhankelijk**.
Het steunt niet op omgevingsvariabelen of een globale configwaarde, die
hier onbetrouwbaar zouden zijn: opencode-mem draait over meerdere opencode-processen
die één webserver delen, en slechts sommige van die processen dragen een
gegeven env-var. Met de marker wordt de projectroot altijd afgeleid van waar
de sessie daadwerkelijk draait.

De marker heeft voorrang op git-detectie. Wanneer aanwezig, wordt de
eigen git-remote van de subrepo bewust genegeerd (die zou slechts één
geneste repository beschrijven). Zonder marker blijft het gedrag ongewijzigd (git-gebaseerde
identiteit).

### Projectherinneringen verplaatsen of herstellen

opencode-mem koppelt projectshards aan een hash van de projectidentiteit. Een repository
verplaatsen (OS-migratie, padreorganisatie, overschakelen van een Windows-mount
naar een native pad) kan daarom de oude shard wees maken onder
`~/.opencode-mem/data/projects/` terwijl een nieuwe lege shard wordt aangemaakt voor het
nieuwe pad.

Dit zijn OpenCode `memory`-toolaanroepen met JSON-argumenten, geen commands om
in een terminal te draaien. De issue-stijlnotatie `memory migrate --from ...` mappt
naar `memory({ mode: "migrate", fromPath: "..." })`.

**1. Lokale verplaatsing wanneer je het oude pad nog kent**

Open OpenCode in de **nieuwe** projectdirectory. Het doelproject mag nog
geen herinneringen bevatten (migratie breekt ongewijzigd af bij conflict). Bekijk eerst de
gedetecteerde bron, bestemming en bestandsacties voordat je iets wijzigt:

```typescript
memory({ mode: "migrate", fromPath: "/old/path/to/project", dryRun: true });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
```

Voor de veiligheid weigert migratie een bron waarvan de opgeslagen projectdirectory nog
bestaat. Als je bewust een actieve bron wilt verplaatsen, bekijk eerst de dry-run-
output en geef daarna `allowLinkedSource: true` mee. Originele bronsshard-
bestanden blijven behouden als timestamped `*.pre-path-migrate-*.bak`-backups.

**2. Oud pad is weg — ontdek eerst de wees-shard**

```typescript
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromHash: "fa645294d88bbae2" });
```

`list-shards` rapporteert elke projecthash, opgeslagen `projectPath`, geheugenaantal,
en status (`current`, `linked`, `orphaned`, `missing-file`, `empty`, of
`ambiguous`). `fromHash` is de 16-tekens lowercase hexadecimale `scopeHash`
die deze call teruggeeft. Geef daaraan de voorkeur wanneer de oude directory niet meer bestaat of
meerdere shards hetzelfde opgeslagen pad bevatten, omdat git-gebaseerde identiteiten
niet altijd opnieuw kunnen worden berekend vanuit een ontbrekend pad.

**3. Cross-machine backup / restore**

```typescript
// on the source machine / old checkout
memory({ mode: "export", outputPath: "./memories.json" });

// on the destination machine / new checkout
memory({ mode: "import", inputPath: "./memories.json", dryRun: true });
memory({ mode: "import", inputPath: "./memories.json" });
```

Export schrijft een geversionneerd JSON-document zonder vectoren. Import remappt de
herinneringen naar het huidige project en herberekent embeddings met het momenteel
geconfigureerde model. Import voegt herinneringen toe aan een bestaand project, maar dubbele
memory-ID’s breken de hele import af vóór schrijven; dit verschilt van `migrate`,
dat een leeg doel vereist.

Exportbestanden zijn plaintext en kunnen geheugeninhoud, gebruikersnamen/e-mailadressen,
repository-URL’s en absolute projectpaden bevatten. Bewaar ze als andere
gevoelige backups en verwijder ze wanneer ze niet meer nodig zijn. Volledig private entries
worden weggelaten, en gebruikersprofielen en prompthistorie zijn niet inbegrepen. Het
document bevat `schemaVersion: 1`; imports weigeren nieuwere niet-ondersteunde schema-
versies in plaats van te gokken.

### Auto-capture AI-provider

Auto-capture draait een achtergrond-AI-verzoek om technisch werk samen te vatten en als geheugen op te slaan. Het heeft een van de onderstaande providerconfiguraties nodig.

**Aanbevolen:** Gebruik een provider die al in opencode is geauthenticeerd en structured output ondersteunt:

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

De plugin stuurt structured-output-verzoeken naar de session-API van opencode in plaats van providerendpoints rechtstreeks aan te roepen, zodat opencode auth, tokenvernieuwing en providerrouting beheert. De providernaam moet overeenkomen met een entry uit `opencode providers list`, en het geselecteerde model moet structured JSON-output via opencode ondersteunen.

Optioneel kun je een model-reasoningvariant vastzetten met `"opencodeVariant": "xhigh"` (bijv. voor grok-4.7). Die wordt toegepast op de interne LLM-calls van de plugin (auto-capture-samenvattingen, profiel-leren, profielopschoning), ook wanneer `opencodeModel` `"inherit"` is, zodat achtergrondwerk een ander reasoningniveau kan gebruiken dan de interactieve sessie.

Trage reasoningmodellen (of zeer grote profielprompts) kunnen het standaard 90 s structured-output-budget overschrijden. Stel `"opencodeTimeoutMs"` (milliseconden) in om het te verlengen voor interne structured-output-calls (auto-capture-samenvattingen, profiel-leren) — bijv. `"opencodeTimeoutMs": 180000` voor 3 minuten. Waarden worden geclampt tot 10000..600000; de standaard blijft 90000. Numerieke strings worden gecoeerd. Profielopschoning gebruikt een aparte, langere timeout.

Ondersteunde providers: elke provider uit `opencode providers list` (bijv. `anthropic`, `openai`, `github-copilot`, ...).

Als `opencodeProvider` en `opencodeModel` zijn ingesteld, hebben ze voorrang op de handmatige `memoryProvider`-instellingen hieronder.

**Volg het sessiermodel:** stel `"opencodeModel": "inherit"` in om op call-tijd een concreet OpenCode-model te gebruiken in plaats van een vastgezette id. Voor **auto-capture** wordt elke prompt via de `chat.params`-hook vastgelegd en hergebruikt het capture-verzoek provider/model van die prompt. Voor **profiel-leren** en andere structured-output-paden (die niet aan één gebruikersbericht zijn gebonden) valt `inherit` terug op het meest recente model in OpenCode’s `model.json`-recentelijst (met voorkeur voor de geconfigureerde `opencodeProvider`). Het letterlijke model-id `inherit` versturen is nooit geldig en veroorzaakte eerder `ProviderModelNotFoundError: Model not found: <provider>/inherit` op die paden. `opencodeProvider` blijft vereist als normale configgate.

**Fallback:** Handmatige API-configuratie (als je geen opencodeProvider gebruikt):

```jsonc
"memoryProvider": "openai-chat",
"memoryModel": "gpt-4o-mini",
"memoryApiUrl": "https://api.openai.com/v1",
"memoryApiKey": "sk-...",
```

**API-sleutelformaten:**

```jsonc
"memoryApiKey": "sk-..."
"memoryApiKey": "file://~/.config/opencode/api-key.txt"
"memoryApiKey": "env://OPENAI_API_KEY"
```

Handmatige `memoryProvider`-modi:

- `openai-chat`: OpenAI Chat Completions-compatibele API met tool/function calling. Dit kan werken met compatibele proxies zoals LiteLLM alleen wanneer het geselecteerde upstream-model en de proxy tool calls behouden.
- `openai-responses`: OpenAI Responses API met function-call-output.
- `anthropic`: Anthropic Messages API met tool use.
- `minimax`: MiniMax Anthropic Messages-compatibel endpoint. Stel `memoryApiUrl` in op het globale endpoint (`https://api.minimax.io`) of het China-endpoint (`https://api.minimaxi.com`); het pad `/anthropic/v1/messages` en de header `x-api-key` worden automatisch toegepast. Huidige modellen zijn onder meer `MiniMax-M3` (1.000.000-token context; adaptief of uitgeschakeld thinking) en `MiniMax-M2.7` (204.800-token context; altijd-aan thinking). `MiniMax-M3` ondersteunt adaptief thinking via `memoryExtraParams`.
- `orcarouter`: OpenAI-compatibele modelgateway met namespaced model-ID’s. `memoryApiUrl` en `memoryModel` zijn optioneel — ze defaulten naar `https://api.orcarouter.ai/v1` en `orcarouter/auto` (een routingalias die per verzoek een capabel model kiest). Als je `memoryModel` instelt, gebruik een namespaced ID zoals `openai/gpt-5.5` of `deepseek/deepseek-v4-flash`; OrcaRouter weigert bare modelnamen. Voorbeeld:
  ```jsonc
  "memoryProvider": "orcarouter",
  "memoryApiKey": "<OrcaRouter API key>",
  ```
  [OrcaRouter](https://www.orcarouter.ai) draait ook gateway-level, zero-trust security voor AI-agents op hetzelfde endpoint — screening van elke prompt/response en governance van elke tool call op default-deny-basis, zonder wijzigingen in applicatiecode.
- `atlas-cloud`: OpenAI-compatibel Chat Completions-preset voor [Atlas Cloud](https://www.atlascloud.ai). `memoryApiUrl` en `memoryModel` zijn optioneel — ze defaulten naar `https://api.atlascloud.ai/v1` en `deepseek-ai/deepseek-v4-pro`. Als `memoryApiKey` wordt weggelaten, wordt `ATLASCLOUD_API_KEY` uit de omgeving gebruikt. Voorbeeld:
  ```jsonc
  "memoryProvider": "atlas-cloud",
  "memoryApiKey": "env://ATLASCLOUD_API_KEY",
  ```
  Wanneer deze provider is geselecteerd, worden auto-capture- / profielprompts, modelantwoorden en relevante conversatiecontext verzonden naar `https://api.atlascloud.ai`.

Probleemoplossing:

- Auto-capture-fouten blokkeren handmatig `memory`-toolgebruik niet.
- Als auto-capture meldt dat een provider niet verbonden is, bevestig de providernaam met `opencode providers list` en configureer die provider eerst in opencode.
- Als een proxy of custom provider platte tekst teruggeeft in plaats van structured/tool-output, kies een ander model/provider of gebruik een van de handmatige providermodi hierboven.
- Voor modellen die `temperature` weigeren, voeg `"memoryTemperature": false` toe bij handmatige API-configuratie.
- Voor modellen die geforceerde tool calls weigeren (`tool_choice: "required"`, bijv. sommige thinking-modi), voeg `"forceToolChoice": false` toe bij `openai-chat` / `orcarouter` / `atlas-cloud`.
- Voor `opencodeProvider` / `opencodeModel` (bijv. DeepSeek V4 thinking) stuurt OpenCode nog steeds geforceerde `tool_choice` voor structured output. opencode-mem schakelt thinking uit op de interne `opencode-mem-structured`-agent (en past dat opnieuw toe in `chat.params` na variant-merge) zodat auto-capture en profiel-leren kunnen voltooien. Je interactieve chatagent blijft ongewijzigd. Als capture nog steeds faalt met een thinking/`tool_choice`-fout, kies een non-thinking model voor `opencodeModel` of configureer een complete handmatige fallback (`memoryModel` + `memoryApiUrl`).
- **`opencode-claude-auth` / Claude Code:** auto-capture gebruikt OpenCode met je geauthenticeerde `anthropic`-provider. Geforceerde `format: json_schema` loopt vaak vast met Claude-auth, dus opencode-mem gebruikt een auth-behoudend **text-JSON**-pad voor `opencodeProvider: "anthropic"` (geen geforceerde `StructuredOutput`-tools; antwoord wordt met Zod geparsed). Een step-watchdog breekt runaway interne sessies nog steeds af na 2 stappen. Als capture nog steeds faalt, configureer een complete handmatige Anthropic API-key-fallback (`memoryProvider: "anthropic"` + `memoryModel` + `memoryApiUrl` + `memoryApiKey`) — Claude Pro/Max OAuth kan niet buiten OpenCode worden hergebruikt.
- **Niet-ondersteunde platforms:** Intel Mac (`darwin/x64`) wordt niet ondersteund — `@tursodatabase/database` en vaste `onnxruntime-node`-releases (vastgezet `1.30.0`) leveren geen x64 native binding. Gebruik Apple Silicon, Linux of Windows, of een remote embedding-endpoint via `embeddingApiUrl` + `embeddingApiKey`. MLX wordt niet ondersteund.

## Publieke subpath-exports

Naast de hoofdplugin-entrypoint stelt `opencode-mem` één stabiele subpath bloot
die andere opencode-plugins rechtstreeks kunnen importeren. Zo hoef je geen
container-tagconventies te reverse-engineeren bij het schrijven van third-party tools die
in dezelfde geheugenstore lezen of schrijven.

### `opencode-mem/tags`

Canonieke container-taghelpers. Dezelfde functies die opencode-mem zelf gebruikt
om auto-captured herinneringen te scopen.

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

Tags die deze helpers produceren komen overeen met wat auto-capture schrijft, zodat third-party
plugins die `POST /api/memories` aanroepen in dezelfde shards belanden die de rest
van het systeem al begrijpt. Handgerolde tags waarvan de substring niet
`_project_` of `_user_` is, belanden in shadow shards die `/api/stats` en
`/api/memories` stilzwijgend filteren — deze helpers gebruiken voorkomt die valkuil.

## Ontwikkeling & bijdragen

Lokaal bouwen en testen:

```bash
bun install
bun run build
bun run typecheck
bun run format
```

Dit project zoekt actief bijdragen om de definitieve geheugenplugin voor AI-codingagents te worden. Of je bugs fixt, features toevoegt, documentatie verbetert of embeddingmodelondersteuning uitbreidt: je bijdragen zijn cruciaal. De codebase is goed gestructureerd en klaar voor verbetering. Open issues met de Issue- of Feature request-templates, en vul het pull request-template in wanneer je een PR indient — we reviewen en mergen bijdragen snel.

**README-vertalingen:** `README.md` (Engels) is de bron van waarheid. Wanneer je de inhoud wijzigt, werk dan de sibling-bestanden `README.de.md`, `README.zh.md`, `README.ar.md`, `README.tr.md` en `README.nl.md` bij zodat ze overeenkomen.

## Licentie & links

MIT-licentie — zie LICENSE-bestand

- **Repository**: https://github.com/tickernelz/opencode-mem
- **Issues**: https://github.com/tickernelz/opencode-mem/issues
- **OpenCode-platform**: https://opencode.ai

Geïnspireerd door [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
