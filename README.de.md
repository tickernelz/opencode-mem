# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![GitHub stars](https://img.shields.io/github/stars/tickernelz/opencode-mem.svg)](https://github.com/tickernelz/opencode-mem)

![OpenCode Memory Banner](.github/pics/banner.png)

[English](./README.md) | **Deutsch** | [中文](./README.zh.md) | [العربية](./README.ar.md) | [Türkçe](./README.tr.md) | [Nederlands](./README.nl.md)

Ein persistentes Speichersystem für KI-Coding-Agenten, das langfristige Kontextbeibehaltung über Sitzungen hinweg mittels lokaler Vektordatenbank-Technologie ermöglicht.

## Kernfunktionen

Lokale Turso/libSQL-Datenbank mit nativer Vektorsuche, persistente Projektspeicher, automatisches Lernen des Benutzerprofils, einheitliche Speicher-Prompt-Timeline, vollständige Web-UI, intelligente promptbasierte Speicherextraktion, Multi-Provider-KI-Unterstützung (OpenAI, Anthropic), 12+ lokale Embedding-Modelle, smarte Deduplizierung und integrierter Datenschutz.

## Voraussetzungen

Dieses Plugin nutzt eingebettetes Turso (`@tursodatabase/database`) mit `F32_BLOB`-Vektoren und exakter Cosinus-Suche über `vector_distance_cos`. Es ist keine separate Vektordatenbank und kein eigener SQLite-Build erforderlich.

**Empfohlene Laufzeitumgebung:**

- Bun
- Standard-OpenCode-Plugin-Umgebung
- Internetzugang beim ersten Einsatz, wenn du das Standard-Embedding-Modell lokal nutzt, weil das Modell von `@huggingface/transformers` heruntergeladen wird.
- Bei Quell-/Entwicklungsinstallationen vor dem Bauen oder Testen `bun install` ausführen. Das veröffentlichte Plugin-Paket installiert seine Laufzeitabhängigkeiten automatisch über OpenCode.

**In CI getestete Plattformen:** Linux, Windows sowie macOS 15 / macOS 26 auf Apple Silicon (`darwin/arm64`). **Intel Mac (`darwin/x64`) wird nicht unterstützt** — `@tursodatabase/database` und feste `onnxruntime-node`-Releases liefern kein natives x64-Binding. Ältere macOS-Versionen sind durch diese Matrix nicht ausgeschlossen; sie liegen lediglich außerhalb der aktuell von GitHub gehosteten Runner.

**Hinweise:**

- Vektor-Embeddings werden direkt in Turso gespeichert und durchsucht; Inserts speichern `F32_BLOB`-Vektoren für exaktes Cosinus-Ranking.
- Die Vektorsuche verwendet exakte Cosinus-Distanz über `vector_distance_cos` (kein DiskANN / approximativer Index), mit optionalem Keyword-Hybrid-Ranking, wenn ein Query-String angegeben ist (`@tursodatabase/database` liefert kein FTS5).
- Session-Lookups nutzen eine indexierte Spalte `session_id` (nachgezogen aus `metadata.sessionID` bei Schema v2).
- Auto-Capture und Lernen des Benutzerprofils erfordern einen KI-Provider, der strukturierte/Tool-Call-Ausgabe liefern kann. Speicher-Suche/Hinzufügen/Listen funktionieren auch ohne Auto-Capture-Provider-Konfiguration.

### Hardware- / Ressourcenanforderungen

opencode-mem benötigt **keine** GPU. Lokale Embeddings laufen auf der CPU über `@huggingface/transformers` und ONNX (es gibt kein MLX-Backend). Zusätzlicher VRAM ist nicht nötig.

| Workload                                                      | Typische zusätzliche Ressourcen                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lokale Embeddings** (Standard `Xenova/nomic-embed-text-v1`) | Etwa **0,5–2 GB RAM**, solange das Modell geladen ist, abhängig von der gewählten Hugging-Face-ID. Beim ersten Einsatz wird das Modell heruntergeladen; der Disk-Cache liegt unter `{storagePath}/.cache` (Standard `~/.opencode-mem/data/.cache`) und beträgt oft **hunderte MB bis ~1–2 GB** pro Modell. |
| **Remote-Embeddings** (`embeddingApiUrl` + `embeddingApiKey`) | Vernachlässigbarer lokaler ML-RAM — nur Plugin- + Turso-Overhead.                                                                                                                                                                                                                                          |
| **Datenbank / Plugin**                                        | Turso/libSQL auf dem Datenträger unter `storagePath`. Die Größe wächst mit der Anzahl gespeicherter Memories, nicht mit GPU-Speicher.                                                                                                                                                                      |

Die oben genannten Plattformgrenzen gelten weiterhin (kein Intel Mac `darwin/x64`; Apple Silicon, Linux, Windows oder ein Remote-Embedding-Endpoint nutzen). Siehe [Embeddings wählen / konfigurieren](#embeddings-wählen--konfigurieren).

### Upgrade von Legacy-SQLite-Shards

Beim Start werden unterbrochene Re-Embed-Swaps wiederhergestellt, libSQL-DiskANN-Indizes auf die aktuelle Turso-Engine konvertiert und anschließend das Legacy-Shard-Schema verifiziert oder aktualisiert. Die Engine-Konvertierung läuft auch, wenn ein Store bereits einen abgeschlossenen Legacy-Migrationsmarker hat, und erhält gespeicherte Vektoren ohne erneutes Embedding. Jede konvertierte Datenbank wird als `<database>.pre-tursodb-<timestamp>.bak` gesichert.

Unter macOS und Linux können mehrere OpenCode-Sitzungen denselben `storagePath` über Turso’s experimentelles `multiprocess_wal` teilen (jeder Prozess muss denselben Modus nutzen — nach dem Upgrade alle Sitzungen neu starten). Unter Windows lehnt die Engine dieses Flag ab, sodass nur eine OpenCode-Sitzung die Speicherdatenbanken gleichzeitig besitzen kann.

Beim ersten Start nach dem Upgrade migriert opencode-mem vorhandene Memory-Shard-Datenbanken automatisch in das native Turso/libSQL-Vektorformat:

- Jeder Shard wird vor dem Rewrite als `<shard>.db.legacy.bak` gesichert
- Der Fortschritt wird pro Shard in `<shard>.db.turso-migrate.json` verfolgt
- Ein globaler Marker `.turso-migrated` wird erst geschrieben, wenn alle Shards erfolgreich verifiziert wurden
- Während der Migration keine mehreren OpenCode-Instanzen gegen denselben `storagePath` betreiben; eine Lock-Datei (`.turso-migrate.lock`) verhindert parallele Migration
- Manuelle Dimensionsmigrationen nutzen `.turso-operation.lock`; andere Plugin-Prozesse lehnen neue Memory-Writes ab, bis die Migration fertig ist

Wird die Migration unterbrochen, setzt der nächste Start die Arbeit aus dem Backup automatisch fort.

Wird ein Shard inkompatibel (z. B. nach Änderung von `embeddingDimensions`), werden Writes blockiert und die Originaldatenbank bleibt unberührt. Nutze die Re-Embed-Migration der Web-UI, um einen Ersatz zu bauen und zu verifizieren, bevor er an Ort und Stelle getauscht wird. Der vorherige Shard bleibt als `<shard>.db.pre-reembed-<pid>-<timestamp>.bak` verfügbar.

## Schema-Migrationen

Lokale Turso-Shards und Hilfsdatenbanken (`metadata.db`, `user-prompts.db`, `user-profiles.db`, `ai-sessions.db`) werden mit geordneten `PRAGMA user_version`-Migrationen in `src/services/turso/schema-migrations.ts` aktualisiert. Migrationen sind idempotent: Beim Start des Plugins werden nur ausstehende Versionen angewendet.

## Erste Schritte

Für OpenCode v2 das Paket zur nativen `plugins`-Liste hinzufügen:

```jsonc
{
  "plugins": ["opencode-mem@latest"],
}
```

OpenCode lädt den `./tui`-Companion des Pakets automatisch, damit
Auto-Capture- / Profil- / Fehler-Toasts in der TUI erscheinen (Server-Plugins
können `ui.toast` nicht direkt aufrufen). Du brauchst keinen zweiten Eintrag in
`plugins`. Wenn du eine reine CLI-TUI gegen einen Remote-OpenCode-Server
betreibst, registriere `opencode-mem/tui` in der Plugin-Liste dieser CLI (z. B.
`cli.json`), damit der Companion Toast-RPC-Events abonnieren kann.

Für OpenCode v1 den Standard-Entrypoint in der Konfiguration unter
`~/.config/opencode/opencode.json` hinzufügen:

```jsonc
{
  "plugin": ["opencode-mem@latest"],
}
```

Mit `@latest` (oder einem Semver-Bereich) und `autoUpdate: true` in `opencode-mem.jsonc` (Standard) löscht das Plugin den von OpenCode zwischengespeicherten Install, sobald eine neuere npm-Version verfügbar ist, und bittet dich um einen Neustart. Gepinnte Versionen wie `opencode-mem@2.26.0` werden nie automatisch aktualisiert.

### Automatischer Speicher-Kontext unter OpenCode v2

Das v2-Plugin liefert automatischen Speicher-Kontext über den Systemkontext des Modells.
Diese Blöcke werden nicht zum verfassten User-Prompt hinzugefügt und nicht im Chat-Transkript gespeichert.
Mit `chatMessage.injectOn: "first"` (der Standard) bleibt der initiale Kontext der Sitzung
über User-Turns und Modell-Schritte erhalten. Mit `"always"` wird er bei jedem
verfassten User-Turn aktualisiert.

Nach einem Host- oder Plugin-Neustart baut eine fortgesetzte Sitzung ihren Kontext beim
nächsten Modell-Request aus dem aktuellen Speicher neu auf, auch wenn kein neuer User-Prompt eintrifft.
Der neu aufgebaute Kontext kann vom Original abweichen, da sich Memories und Profil weiterentwickeln.
Die Wiederherstellung erzeugt keinen synthetischen User-Prompt und speichert keine zweite Kopie des
Speichertexts im OpenCode-Plugin-Storage. Compaction invalidiert den zwischengespeicherten automatischen
Kontext; die bestehende Compaction-Memory-Wiederherstellung läuft weiterhin.

### Lokalen Checkout verwenden

Um das Plugin aus einem lokalen Quell-Checkout statt aus dem npm-Release zu betreiben, im Checkout `bun install && bun run build` ausführen und die `plugins`-Liste auf das Checkout-Verzeichnis zeigen:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-mem"],
}
```

Auf die Paketwurzel zeigen, nicht auf `dist/` oder eine einzelne Datei. OpenCode löst ein Verzeichnis-Plugin über Fallback auf `<directory>/index` auf (OpenCode liest bei aktuellem Stand für eine Pfadangabe nicht `package.json` `exports`/`main`), daher liefert dieses Repository ein schlankes Root-`index.js`, das den gebauten v2-Entrypoint aus `dist/plugin.js` re-exportiert, sowie ein Root-`tui.js`, das `dist/tui.js` für den TUI-Companion re-exportiert. Ein Pfad zu einer Datei wird abgelehnt (`configured plugin path must be a directory`), und ein Verzeichnis ohne Root-`index.js` wird stillschweigend übersprungen.

### Optionale Datenbankverschlüsselung im Ruhezustand

AES-256-GCM-Verschlüsselung für lokale Turso-Shards in `~/.config/opencode/opencode-mem.jsonc` aktivieren:

```jsonc
{
  "databaseEncryptionEnabled": true,
}
```

Beim ersten Start erstellt das Plugin `~/.config/opencode/opencode-mem-db.key` (32-Byte-Hex-Key, `chmod 600`) und migriert vorhandene Klartext-Shards. Überschreiben mit `"databaseEncryptionKey": "env://OPENCODE_MEM_DB_KEY"` oder `"file://~/path/to.key"`, wenn du den Key selbst verwaltest. Ohne den Key lassen sich die verschlüsselten Datenbanken nicht öffnen.

**Windows:** `%USERPROFILE%\.config\opencode\opencode.json` verwenden (z. B. `C:\Users\<you>\.config\opencode\opencode.json`). Dieses Plugin liest **nicht** `%APPDATA%` oder `%LOCALAPPDATA%` für seinen OpenCode-Plugin-Eintrag — die Datei unter `.config\opencode` im User-Profil ablegen und OpenCode neu starten. Erscheint das Plugin nicht, den Pfad prüfen und erneut neu starten.

Das Plugin wird beim nächsten Start automatisch heruntergeladen.

## Tägliche Nutzung

Du musst OpenCode **nicht** bitten, Dinge zu „merken“, damit das Plugin funktioniert. Mit den Standardeinstellungen baut sich der Speicher auf, während du arbeitest.

### Typischer Tagesablauf

1. Plugin aktivieren (siehe [Erste Schritte](#erste-schritte)) und OpenCode neu starten.
2. KI-Provider für Auto-Capture konfigurieren — empfohlen: `opencodeProvider` + `opencodeModel` (oder `"opencodeModel": "inherit"`). Details unter [Auto-Capture-KI-Provider](#auto-capture-ki-provider).
3. Normal in OpenCode arbeiten. Wenn eine Sitzung idle wird, extrahiert Auto-Capture merkenswerten technischen Kontext und speichert ihn.
4. In späteren Sitzungen werden relevante Memories in den Kontext injiziert (siehe `chatMessage` / Compaction-Einstellungen). Im Web-UI unter `http://127.0.0.1:4747` browsen oder bearbeiten.
5. Das `memory`-Tool nutzen, wenn etwas sofort gespeichert oder abgerufen werden soll (siehe [Verwendungsbeispiele](#verwendungsbeispiele)).

### Automatischer vs. manueller Speicher

| Ansatz                                                  | Wann er läuft                                    | Was du tust                                                                                |
| ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **Auto-Capture** (`autoCaptureEnabled: true`, Standard) | Nach Gesprächsrunden, wenn die Sitzung idle wird | Nichts — die Extraktion ist automatisch                                                    |
| **Manuell** `memory`-Tool / Befehle                     | Auf Abruf                                        | `add`, `search`, `list`, `profile`, `forget`, `list-shards`, `migrate`, `export`, `import` |

Manuelle Suche/Hinzufügen/Listen funktionieren auch, wenn für Auto-Capture kein Provider konfiguriert ist. Auto-Capture und Lernen des Benutzerprofils brauchen einen Provider, der strukturierte/Tool-Call-Ausgabe liefern kann.

### Speicher vs. AGENTS.md / Projektdokumentation

| In **memory** speichern                                                                      | In **AGENTS.md** / statischen Docs speichern                     |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Projektspezifische Entscheidungen, Bug-Muster, „wir haben X versucht und es ist gescheitert“ | Stabile Regeln und Workflows, die sich selten ändern             |
| Über Sitzungen hinweg entdeckte Benutzerpräferenzen                                          | Immer gültige Coding-Konventionen und Prozesse                   |
| Fakten, die dir über Chats hinweg folgen sollen                                              | Anweisungen, die jeder Agent unabhängig von Retrieval sehen soll |

Faustregel: Ist es eine dauerhafte Projektanweisung, gehört sie in AGENTS.md; ist es Kontext, der aus echter Arbeit wächst, soll ihn der Speicher (oder Auto-Capture) halten.

### Intelligente promptbasierte Speicherextraktion

Dieser Begriff in der Feature-Liste ist **Auto-Capture**: Nach einem Gespräch fasst eine Hintergrund-KI-Anfrage technische Arbeit zusammen und speichert sie als Memory. Es ist kein spezieller Prompt von dir nötig. Es nutzt `opencodeProvider` / `opencodeModel`, wenn gesetzt, sonst den manuellen `memoryProvider`-Fallback.

### Benutzerprofil

Das **Benutzerprofil** ist eine separate, projektübergreifende Zusammenfassung, wie du gerne arbeitest (Präferenzen, Gewohnheiten). Es wird in einem Intervall aktualisiert (`userProfileAnalysisInterval`, Standard alle 10 analysierten Prompts), in der Profilansicht der Web-UI angezeigt und über `memory({ mode: "profile" })` lesbar. Für den Normalbetrieb füllst du es nicht von Hand — das Profil-Lernen füllt es, sobald ein Provider bereit ist. Die Ausgabesprache folgt `autoCaptureLanguage` (Standard `"auto"`, spiegelt die Sprache deiner Prompts), dieselbe Einstellung wie für auto-erfasste Memories.

**„No profile found. Keep chatting to build your profile.“** ist der erwartete Leerzustand, kein Absturz. Profil-Lernen braucht:

1. Laufendes Auto-Capture mit erreichbarem Provider (`opencodeProvider` + `opencodeModel`, oder vollständiger manueller Fallback mit `memoryModel` + `memoryApiUrl`).
2. Genug Sitzungs-Prompts seit der letzten Analyse — mindestens `userProfileAnalysisInterval` (Standard **10**).
3. Dass dieser Provider strukturierte/Tool-Call-Ausgabe unterstützt (gleiche Anforderung wie Auto-Capture).

Wenn du eine Weile gechattet hast und die Meldung weiterhin siehst, prüfe in den Logs, ob Auto-Capture tatsächlich feuert und der konfigurierte Provider erfolgreich ist (fehlgeschlagene Profilanalyse versteckt sich nicht mehr hinter einem generischen Leerzustand, wenn der Provider fehlerhaft ist).

### Web-UI

Öffne `http://127.0.0.1:4747`, um die Speicher–Prompt-Timeline zu browsen, Captures zu prüfen und das Benutzerprofil zu verwalten. Bindest du den Server über Loopback hinaus, siehe [Web-UI HTTP Basic Auth](#web-ui-http-basic-auth).

## Verwendungsbeispiele

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

Web-Oberfläche unter `http://127.0.0.1:4747` für visuelle Speicherverwaltung und -browsing.

**Netzwerk-Binding-Sicherheit:** `webServerHost` auf `127.0.0.1` lassen, sofern du die UI nicht absichtlich exponierst. Binding auf `0.0.0.0` (oder jeden Non-Loopback-Host) erfordert `webServerApiToken`; alle `/api/*`-Requests müssen dann `Authorization: Bearer <token>` oder `X-Opencode-Mem-Token` senden. Die UI mit `?apiToken=<token>` öffnen, damit der Browser den Token speichert und mitsendet.

Dimensionsmigrationen erzeugen zuerst jedes neue Embedding, importieren sie in einen temporären indexierten Shard, verifizieren die Zeilenanzahl und ersetzen erst dann die Originaldatei. Fehlgeschlagene Migrationen lassen den Quell-Shard unberührt.

## Wichtige Konfiguration

Konfiguration unter `~/.config/opencode/opencode-mem.jsonc`:

**Windows:** `%USERPROFILE%\.config\opencode\opencode-mem.jsonc` (dasselbe Verzeichnis `.config\opencode` wie oben — nicht AppData). Der Standard-Storage löst sich zu `%USERPROFILE%\.opencode-mem\data` auf (die `~`-Form expandiert unter Windows ebenfalls zu deinem User-Home).

Das Plugin legt beim ersten Start eine voll kommentierte Vorlage unter diesem Pfad an. Für jede Einstellung und jeden Kommentar siehe [`opencode-mem.example.jsonc`](opencode-mem.example.jsonc).

### Erfassung und Injection von Chat-Nachrichten (`chatMessage`)

Diese Einstellungen liegen unter dem Schlüssel `chatMessage` in `~/.config/opencode/opencode-mem.jsonc`:

| Option                                                 | Standard         | Was sie tut                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                              | `true`           | Verfasste User-Prompts erfassen und Speicher-Kontext injizieren.                                                                                                                                                                                                                                                                |
| `injectOn`                                             | `"first"`        | Speicher-Kontext bei der ersten User-Nachricht einer Sitzung injizieren, oder bei `"always"` bei jedem verfassten Turn.                                                                                                                                                                                                         |
| `maxMemories` / `excludeCurrentSession` / `maxAgeDays` | `3` / `true` / — | Wie viele Memories der injizierte Kontext hält, ob Memories aus der aktuellen Sitzung ausgeschlossen werden, und optionaler Alters-Cutoff in Tagen.                                                                                                                                                                             |
| `filterInjectedPrompts`                                | `true`           | Prompt-Text überspringen, der vom Host oder anderen OpenCode-Plugins injiziert wurde (System-Reminders, Orchestrierungsanweisungen, Background-Task-Benachrichtigungen), damit er nie so gespeichert wird, als hätte ihn der User getippt.                                                                                      |
| `injectionMarkers`                                     | Built-ins        | Zusätzliche Marker zur Erkennung injizierter Blöcke; werden zur Built-in-Liste hinzugefügt, ersetzen sie nie.                                                                                                                                                                                                                   |
| `captureChildSessions`                                 | `false`          | Prompts aus Orchestrator-Child-Sitzungen erfassen (Sitzungen mit `parentID`, z. B. OpenCode-Task-/Subagent-Children). Deren „User“-Nachrichten schreibt der Parent-Agent, nicht du — daher werden sie standardmäßig nicht gespeichert, auto-captured, für Profil-Lernen genutzt oder mit injiziertem Speicher-Kontext versehen. |

### Embeddings wählen / konfigurieren

Embeddings treiben die Ähnlichkeitssuche für Memories und das Benutzerprofil. Konfiguration in derselben Datei (`~/.config/opencode/opencode-mem.jsonc`). Es gibt **kein MLX-Backend** — lokale Embeddings nutzen `@huggingface/transformers` mit ONNX, nicht Apple MLX.

**Lokal (Standard):** nur `embeddingModel` setzen. Beim ersten Einsatz wird das Modell von Hugging Face heruntergeladen und unter `{storagePath}/.cache` zwischengespeichert (Standard `~/.opencode-mem/data/.cache`).

**Remote (OpenAI-kompatibel):** sowohl `embeddingApiUrl` als auch `embeddingApiKey` setzen. Das Plugin ruft dann `{embeddingApiUrl}/embeddings` mit Bearer-Token auf. `embeddingApiKey` akzeptiert dieselben Secret-Formate wie `memoryApiKey` (`literal`, `env://…`, `file://…`).

| Schlüssel                  | Rolle                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `embeddingModel`           | Hugging-Face-ID (lokal) oder API-Modellname (remote). Standard: `Xenova/nomic-embed-text-v1`                                                  |
| `embeddingDimensions`      | Optionaler Override; meist weglassen — Dimensionen werden aus einer Built-in-Map nachgeschlagen                                               |
| `embeddingPooling`         | Lokales Pooling: `"mean"` (Standard), `"cls"` oder `"last_token"`. Ungesetzt → kleines Known-Model-Preset oder `"mean"`                       |
| `embeddingQueryPrefix`     | Präfix für Query-Task-Embeddings. Ungesetzt → Modell-Preset oder Nomic, wenn `embeddingUseTaskPrefixes` true ist. Explizites `""` deaktiviert |
| `embeddingDocumentPrefix`  | Präfix für Document-Task-Embeddings (gleiche Auflösungsregeln wie `embeddingQueryPrefix`)                                                     |
| `embeddingUseTaskPrefixes` | Opt-in für Nomic-Präfixe `search_query:` / `search_document:`, wenn Custom-/Preset-Präfixe nicht gesetzt sind. Standard `false`               |
| `embeddingDtype`           | Optionaler lokaler ONNX-Dtype-Override (z. B. `"q8"`, `"fp32"`). Wenn gesetzt, an transformers.js `pipeline({ dtype })` übergeben             |
| `embeddingApiUrl`          | Basis-URL für eine OpenAI-kompatible Embeddings-API (kein trailing Path über `/v1` hinaus)                                                    |
| `embeddingApiKey`          | API-Key für diesen Endpoint (zusammen mit `embeddingApiUrl` erforderlich)                                                                     |

Empfohlene lokale Modelle:

| Modell                               | Dims | Hinweise                                           |
| ------------------------------------ | ---- | -------------------------------------------------- |
| `Xenova/nomic-embed-text-v1`         | 768  | Standard; mehrsprachig, 8192 Kontext; Mean-Pooling |
| `Xenova/jina-embeddings-v2-base-en`  | 768  | Nur Englisch, 8192 Kontext                         |
| `Xenova/jina-embeddings-v2-small-en` | 512  | Schneller, 8192 Kontext                            |
| `Xenova/all-MiniLM-L6-v2`            | 384  | Sehr schnell, 512 Kontext                          |
| `Xenova/all-mpnet-base-v2`           | 768  | Gute Qualität, 512 Kontext                         |
| `Xenova/bge-m3`                      | 1024 | Mehrsprachig; Auto-CLS-Pooling                     |
| `intfloat/multilingual-e5-large`     | 1024 | Auto-Präfixe `query:` / `passage:`                 |

Beispiel — Remote-OpenAI-Embeddings:

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "env://OPENAI_API_KEY",
  "embeddingModel": "text-embedding-3-small",
}
```

Beispiel — lokal bge-m3 (Pooling defaultet über Preset auf CLS; bei Bedarf überschreiben):

```jsonc
{
  "embeddingModel": "Xenova/bge-m3",
  // "embeddingPooling": "cls",
  // "embeddingDtype": "q8",
}
```

Änderungen an `embeddingModel`, Dimensionen, Pooling oder Task-Präfixen können erfordern, gespeicherte Memories neu zu embedden, damit Store- und Query-Vektoren ausgerichtet bleiben. Besser einmal ein Modell (und Pooling-/Präfix-Einstellungen) wählen und für ein gegebenes Datenverzeichnis dabei bleiben.

**Nicht unterstützt — Intel Mac (`darwin/x64`):** Lokale Persistenz erfordert `@tursodatabase/database`, das kein natives Intel-Mac-Binding veröffentlicht. Feste `onnxruntime-node`-Releases (`1.24.1+`, einschließlich des gepinnten `1.30.0`) fehlen ebenfalls unter darwin/x64. Apple-Silicon-Mac, Linux oder Windows nutzen, oder einen Remote-Endpoint über `embeddingApiUrl` + `embeddingApiKey` (Beispiel oben). Auf unterstützten Plattformen pinnt `opencode-mem` `onnxruntime-node@1.30.0` (Ort::Env-Teardown-Fix aus `1.24.1` / #225) und lädt Transformers über einen CJS-Resolve-Shim, damit verschachtelte OpenCode-Installs dieses Binding behalten. Transformers wird vor Installation dieses Shims auf einen absoluten Pfad aufgelöst, damit OpenCodes Bun-`--compile`-Host nicht mit `Cannot find module '@huggingface/transformers' from ''` scheitert. Nach dem Upgrade den verschachtelten Plugin-Cache von OpenCode löschen (`~/.cache/opencode/packages/opencode-mem@*`) und neu installieren.

### Speicher-Scope

- `scope: "project"`: nur das aktuelle Projekt abfragen. Das ist der Standard.
- `scope: "all-projects"`: `search` / `list` über alle Projekt-Shards abfragen.
- `memory.defaultScope` setzt den Standard-Query-Scope, wenn kein expliziter Scope angegeben ist.

### Web-UI HTTP Basic Auth

Wenn `webServerHost` auf etwas anderes als Loopback gesetzt ist (z. B. `0.0.0.0`), ist die Web-UI für jeden im Netzwerk erreichbar. Damit deine Memories nicht im LAN liegen, den Webserver über HTTP Basic Auth in derselben Config-Datei wie alles andere absichern:

```jsonc
{
  "webServerHost": "0.0.0.0", // optional: UI aus dem LAN erreichen
  "webServerAuthPassword": "pick-a-strong-one",
  "webServerAuthUsername": "admin", // optional, Standard ist der aktuelle OS-User
}
```

| Feld                    | Standard          | Wirkung                                                                                                                              |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `webServerAuthPassword` | _(leer)_          | Wenn gesetzt, verlangt der Server bei jedem Request HTTP-Basic-Auth-Credentials. Leer lassen für das standardmäßig offene Verhalten. |
| `webServerAuthUsername` | OS-User (`$USER`) | Vom Basic-Auth-Challenge geforderter Username.                                                                                       |

`webServerAuthPassword` akzeptiert dieselben Secret-Formate wie `memoryApiKey`:

- ein Literal-String (einfach, für persönliche Maschinen in Ordnung),
- `env://SOME_ENV_VAR`, um den Wert beim Start aus der Umgebung zu lesen,
- `file:///path/to/secret`, um ihn aus einer Datei zu lesen (`chmod 600` empfohlen — das Plugin warnt, wenn die Datei world-readable ist).

Der Browser zeigt seinen nativen Basic-Auth-Dialog und merkt sich die Credentials für die aktuelle Sitzung; alle Browserfenster zu schließen verwirft sie, sodass beim erneuten Öffnen des Browsers wieder angemeldet werden muss. Credentials werden mit einem Constant-Time-Check verglichen, und die nicht authentifizierte 401-Antwort trägt `Cache-Control: no-store`, damit kein Zwischen-Cache sie wiedergibt. CORS wird auch gelockert, sobald Auth an ist, sodass andere Tools im selben LAN nach Authentifizierung mit der API sprechen können.

### Gemeinsamen Projektspeicher über verschachtelte Repos teilen

Standardmäßig wird ein Projekt über sein umschließendes Git-Repository identifiziert, sodass jedes
physische Git-Repo einen eigenen isolierten Speicher erhält. Das ist falsch für
Multi-Repo-Workspaces — Bäume, die von Googles [`repo`](https://gerrit.googlesource.com/git-repo/+/HEAD/Docs/manual-repo.md)
verwaltet werden, Monorepos oder jedes Layout, in dem mehrere verschachtelte Git-Repositories zu einem
logischen Projekt gehören —, weil jedes Sub-Repository siloed wäre.

Lege eine leere Marker-Datei **`.opencode-mem-project`** an der Workspace-Wurzel ab:

```
my-workspace/
├── .opencode-mem-project   ← Workspace-Wurzel
├── kernel/                 (eigenes Git-Repo)
├── userspace/              (eigenes Git-Repo)
└── tools/                  (eigenes Git-Repo)
```

Jede Sitzung, die irgendwo unterhalb des Markers gestartet wird, löst dann auf diese
Wurzel auf und teilt einen Speicher, unabhängig davon, in welchem Sub-Repo das Arbeitsverzeichnis liegt:

```sh
touch ~/my-workspace/.opencode-mem-project
```

Der Marker wird durch Aufwärtslaufen vom Arbeitsverzeichnis gefunden, das jeder
Codepfad bereits übergibt (Arbeitsverzeichnis des Plugins, `process.cwd()` der Web-API),
sodass die Identität **verzeichnisgetrieben und prozessunabhängig** ist.
Sie stützt sich nicht auf Umgebungsvariablen oder einen globalen Config-Wert, die
hier unzuverlässig wären: opencode-mem läuft über mehrere opencode-Prozesse,
die einen einzelnen Webserver teilen, und nur einige dieser Prozesse tragen eine
gegebene Env-Var. Mit dem Marker wird die Projektwurzel immer davon abgeleitet, wo
die Sitzung tatsächlich läuft.

Der Marker hat Vorrang vor der Git-Erkennung. Ist er vorhanden, wird die
eigene Git-Remote des Sub-Repos absichtlich ignoriert (sie würde nur ein
verschachteltes Repository beschreiben). Ohne Marker bleibt das Verhalten unverändert (Git-basierte
Identität).

### Projektspeicher verschieben oder wiederherstellen

opencode-mem schlüsselt Projekt-Shards über einen Hash der Projektidentität. Das Verschieben eines
Repositories (OS-Migration, Pfad-Reorganisation, Wechsel von einem Windows-Mount
auf einen nativen Pfad) kann daher den alten Shard unter
`~/.opencode-mem/data/projects/` verwaisen lassen, während für den
neuen Pfad ein neuer leerer Shard angelegt wird.

Das sind OpenCode-`memory`-Tool-Aufrufe mit JSON-Argumenten, keine Befehle zum
Ausführen im Terminal. Die Issue-ähnliche Notation `memory migrate --from ...` entspricht
`memory({ mode: "migrate", fromPath: "..." })`.

**1. Lokaler Umzug, wenn du den alten Pfad noch kennst**

OpenCode im **neuen** Projektverzeichnis öffnen. Das Zielprojekt darf noch
keine Memories enthalten (Migration bricht bei Konflikt unverändert ab). Vor jeder Änderung die
erkannte Quelle, das Ziel und die Dateiaktionen prüfen:

```typescript
memory({ mode: "migrate", fromPath: "/old/path/to/project", dryRun: true });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
```

Zur Sicherheit lehnt die Migration eine Quelle ab, deren gespeichertes Projektverzeichnis noch
existiert. Wenn du eine aktive Quelle absichtlich verschieben willst, zuerst die Dry-Run-
Ausgabe prüfen und dann `allowLinkedSource: true` übergeben. Original-Quell-Shard-
Dateien bleiben als zeitgestempelte `*.pre-path-migrate-*.bak`-Backups erhalten.

**2. Alter Pfad ist weg — zuerst den verwaisten Shard finden**

```typescript
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromHash: "fa645294d88bbae2" });
```

`list-shards` meldet jeden Projekt-Hash, den gespeicherten `projectPath`, die Memory-Anzahl
und den Status (`current`, `linked`, `orphaned`, `missing-file`, `empty` oder
`ambiguous`). `fromHash` ist der 16-stellige hexadezimale Kleinbuchstaben-`scopeHash`,
den dieser Aufruf zurückgibt. Bevorzuge ihn, wenn das alte Verzeichnis nicht mehr existiert oder
mehrere Shards denselben gespeicherten Pfad enthalten, weil Git-basierte Identitäten
aus einem fehlenden Pfad nicht immer neu berechnet werden können.

**3. Maschinenübergreifendes Backup / Restore**

```typescript
// on the source machine / old checkout
memory({ mode: "export", outputPath: "./memories.json" });

// on the destination machine / new checkout
memory({ mode: "import", inputPath: "./memories.json", dryRun: true });
memory({ mode: "import", inputPath: "./memories.json" });
```

Export schreibt ein versioniertes JSON-Dokument ohne Vektoren. Import mappt die
Memories auf das aktuelle Projekt um und berechnet Embeddings mit dem aktuell
konfigurierten Modell neu. Import fügt Memories zu einem bestehenden Projekt hinzu, aber doppelte
Memory-IDs brechen den gesamten Import vor dem Schreiben ab; das unterscheidet sich von `migrate`,
das ein leeres Ziel verlangt.

Export-Dateien sind Klartext und können Memory-Inhalte, User-Namen/E-Mail-
Adressen, Repository-URLs und absolute Projektpfade enthalten. Sie wie andere
sensible Backups speichern und löschen, wenn sie nicht mehr benötigt werden. Vollständig private Einträge
werden ausgelassen, und Benutzerprofile sowie Prompt-Historie sind nicht enthalten. Das
Dokument enthält `schemaVersion: 1`; Imports lehnen neuere nicht unterstützte Schema-
Versionen ab, statt zu raten.

### Auto-Capture-KI-Provider

Auto-Capture führt eine Hintergrund-KI-Anfrage aus, um technische Arbeit zusammenzufassen und als Memory zu speichern. Es braucht eine der Provider-Konfigurationen unten.

**Empfohlen:** Einen Provider nutzen, der in opencode bereits authentifiziert ist und strukturierte Ausgabe unterstützt:

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

Das Plugin stellt strukturierte Output-Requests an die Session-API von opencode, statt Provider-Endpoints direkt aufzurufen, sodass opencode Auth, Token-Refresh und Provider-Routing besitzt. Der Provider-Name muss einem Eintrag aus `opencode providers list` entsprechen, und das gewählte Modell muss strukturierte JSON-Ausgabe über opencode unterstützen.

Optional eine Reasoning-Variante des Modells mit `"opencodeVariant": "xhigh"` pinnen (z. B. für grok-4.7). Sie gilt für die internen LLM-Aufrufe des Plugins (Auto-Capture-Zusammenfassungen, Profil-Lernen, Profil-Cleanup), auch wenn `opencodeModel` `"inherit"` ist, sodass Hintergrundarbeit ein anderes Reasoning-Level als die interaktive Sitzung nutzen kann.

Langsame Reasoning-Modelle (oder sehr große Profil-Prompts) können das Standard-Budget von 90 s für strukturierte Ausgabe überschreiten. `"opencodeTimeoutMs"` (Millisekunden) setzen, um es für interne Structured-Output-Aufrufe (Auto-Capture-Zusammenfassungen, Profil-Lernen) zu verlängern — z. B. `"opencodeTimeoutMs": 180000` für 3 Minuten. Werte werden auf 10000..600000 geklemmt; der Standard bleibt 90000. Numerische Strings werden coerced. Profil-Cleanup nutzt ein separates, längeres Timeout.

Unterstützte Provider: jeder von `opencode providers list` gelistete Provider (z. B. `anthropic`, `openai`, `github-copilot`, ...).

Wenn `opencodeProvider` und `opencodeModel` gesetzt sind, haben sie Vorrang vor den manuellen `memoryProvider`-Einstellungen unten.

**Sitzungsmodell folgen:** `"opencodeModel": "inherit"` setzen, um zur Aufrufzeit ein konkretes OpenCode-Modell statt einer gepinnten ID zu nutzen. Für **Auto-Capture** wird jeder Prompt über den `chat.params`-Hook aufgezeichnet und der Capture-Request wiederverwendet Provider/Modell dieses Prompts. Für **Profil-Lernen** und andere Structured-Output-Pfade (die nicht an eine einzelne User-Nachricht gebunden sind) fällt `inherit` auf das neueste Modell in der Recent-Liste von OpenCodes `model.json` zurück (bevorzugt den konfigurierten `opencodeProvider`). Das wörtliche Modell-ID `inherit` zu senden ist nie gültig und verursachte zuvor `ProviderModelNotFoundError: Model not found: <provider>/inherit` auf diesen Pfaden. `opencodeProvider` bleibt als normale Config-Gate erforderlich.

**Fallback:** Manuelle API-Konfiguration (wenn opencodeProvider nicht genutzt wird):

```jsonc
"memoryProvider": "openai-chat",
"memoryModel": "gpt-4o-mini",
"memoryApiUrl": "https://api.openai.com/v1",
"memoryApiKey": "sk-...",
```

**API-Key-Formate:**

```jsonc
"memoryApiKey": "sk-..."
"memoryApiKey": "file://~/.config/opencode/api-key.txt"
"memoryApiKey": "env://OPENAI_API_KEY"
```

Manuelle `memoryProvider`-Modi:

- `openai-chat`: OpenAI-Chat-Completions-kompatible API mit Tool-/Function-Calling. Kann mit kompatiblen Proxies wie LiteLLM nur funktionieren, wenn das gewählte Upstream-Modell und der Proxy Tool-Calls erhalten.
- `openai-responses`: OpenAI Responses API mit Function-Call-Ausgabe.
- `anthropic`: Anthropic Messages API mit Tool Use.
- `minimax`: MiniMax Anthropic-Messages-kompatibler Endpoint. `memoryApiUrl` auf den globalen Endpoint (`https://api.minimax.io`) oder den China-Endpoint (`https://api.minimaxi.com`) setzen; der Pfad `/anthropic/v1/messages` und der Header `x-api-key` werden automatisch angewendet. Aktuelle Modelle umfassen `MiniMax-M3` (1.000.000-Token-Kontext; adaptives oder deaktiviertes Thinking) und `MiniMax-M2.7` (204.800-Token-Kontext; Thinking immer an). `MiniMax-M3` unterstützt adaptives Thinking über `memoryExtraParams`.
- `orcarouter`: OpenAI-kompatibles Model-Gateway mit namenspaced Model-IDs. `memoryApiUrl` und `memoryModel` sind optional — sie defaulten auf `https://api.orcarouter.ai/v1` und `orcarouter/auto` (ein Routing-Alias, der pro Request ein fähiges Modell wählt). Wenn du `memoryModel` setzt, eine namenspaced ID wie `openai/gpt-5.5` oder `deepseek/deepseek-v4-flash` verwenden; OrcaRouter lehnt bare Modellnamen ab. Beispiel:
  ```jsonc
  "memoryProvider": "orcarouter",
  "memoryApiKey": "<OrcaRouter API key>",
  ```
  [OrcaRouter](https://www.orcarouter.ai) betreibt auf demselben Endpoint auch Gateway-Level-Zero-Trust-Security für KI-Agenten — prüft jeden Prompt/jede Response und steuert jeden Tool-Call auf Default-Deny-Basis, ohne Änderungen am Anwendungscode.
- `atlas-cloud`: OpenAI-kompatibles Chat-Completions-Preset für [Atlas Cloud](https://www.atlascloud.ai). `memoryApiUrl` und `memoryModel` sind optional — sie defaulten auf `https://api.atlascloud.ai/v1` und `deepseek-ai/deepseek-v4-pro`. Fehlt `memoryApiKey`, wird `ATLASCLOUD_API_KEY` aus der Umgebung verwendet. Beispiel:
  ```jsonc
  "memoryProvider": "atlas-cloud",
  "memoryApiKey": "env://ATLASCLOUD_API_KEY",
  ```
  Wenn dieser Provider gewählt ist, werden Auto-Capture- / Profil-Prompts, Modellantworten und relevanter Gesprächskontext an `https://api.atlascloud.ai` übertragen.

Fehlerbehebung:

- Auto-Capture-Fehler blockieren die manuelle Nutzung des `memory`-Tools nicht.
- Meldet Auto-Capture, dass ein Provider nicht verbunden ist, den Provider-Namen mit `opencode providers list` bestätigen und diesen Provider zuerst in opencode konfigurieren.
- Gibt ein Proxy oder Custom-Provider Klartext statt strukturierter/Tool-Ausgabe zurück, ein anderes Modell/einen anderen Provider wählen oder einen der manuellen Provider-Modi oben nutzen.
- Für Modelle, die `temperature` ablehnen, bei manueller API-Konfiguration `"memoryTemperature": false` hinzufügen.
- Für Modelle, die erzwungene Tool-Calls ablehnen (`tool_choice: "required"`, z. B. manche Thinking-Modi), bei `openai-chat` / `orcarouter` / `atlas-cloud` `"forceToolChoice": false` hinzufügen.
- Bei `opencodeProvider` / `opencodeModel` (z. B. DeepSeek V4 Thinking) sendet OpenCode weiterhin erzwungenes `tool_choice` für strukturierte Ausgabe. opencode-mem deaktiviert Thinking auf dem internen Agenten `opencode-mem-structured` (und wendet das in `chat.params` nach Variant-Merge erneut an), damit Auto-Capture und Profil-Lernen abschließen können. Dein interaktiver Chat-Agent bleibt unverändert. Scheitert Capture weiterhin mit einem Thinking-/`tool_choice`-Fehler, für `opencodeModel` ein Non-Thinking-Modell wählen oder einen vollständigen manuellen Fallback konfigurieren (`memoryModel` + `memoryApiUrl`).
- **`opencode-claude-auth` / Claude Code:** Auto-Capture nutzt OpenCode mit deinem authentifizierten `anthropic`-Provider. Erzwungenes `format: json_schema` loopt oft mit Claude-Auth, daher nutzt opencode-mem einen Auth-erhaltenden **Text-JSON**-Pfad für `opencodeProvider: "anthropic"` (keine erzwungenen `StructuredOutput`-Tools; Antwort wird mit Zod geparst). Ein Step-Watchdog bricht runaway interne Sitzungen nach 2 Schritten weiterhin ab. Scheitert Capture weiterhin, einen vollständigen manuellen Anthropic-API-Key-Fallback konfigurieren (`memoryProvider: "anthropic"` + `memoryModel` + `memoryApiUrl` + `memoryApiKey`) — Claude Pro/Max OAuth lässt sich außerhalb von OpenCode nicht wiederverwenden.
- **Nicht unterstützte Plattformen:** Intel Mac (`darwin/x64`) wird nicht unterstützt — `@tursodatabase/database` und feste `onnxruntime-node`-Releases (gepinnt `1.30.0`) liefern kein natives x64-Binding. Apple Silicon, Linux oder Windows nutzen, oder einen Remote-Embedding-Endpoint über `embeddingApiUrl` + `embeddingApiKey`. MLX wird nicht unterstützt.

## Öffentliche Subpath-Exports

Zusätzlich zum Haupt-Plugin-Entrypoint exponiert `opencode-mem` einen stabilen Subpath,
den andere opencode-Plugins direkt importieren können. Das vermeidet, Container-Tag-
Konventionen reverse-engineeren zu müssen, wenn Drittanbieter-Tools geschrieben werden, die
in denselben Speicher lesen oder schreiben.

### `opencode-mem/tags`

Kanonische Container-Tag-Helfer. Dieselben Funktionen, die opencode-mem selbst nutzt,
um auto-erfasste Memories zu scopen.

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

Von diesen Helfern erzeugte Tags entsprechen dem, was Auto-Capture schreibt, sodass Drittanbieter-
Plugins, die `POST /api/memories` aufrufen, in denselben Shards landen, die der Rest
des Systems bereits versteht. Handgemachte Tags, deren Substring nicht
`_project_` oder `_user_` ist, landen in Shadow-Shards, die `/api/stats` und
`/api/memories` stillschweigend herausfiltern — diese Helfer vermeiden diese Falle.

## Entwicklung & Beitrag

Lokal bauen und testen:

```bash
bun install
bun run build
bun run typecheck
bun run format
```

Dieses Projekt sucht aktiv Beiträge, um das maßgebliche Memory-Plugin für KI-Coding-Agenten zu werden. Ob du Bugs behebst, Features hinzufügst, Dokumentation verbesserst oder die Embedding-Modell-Unterstützung erweiterst — deine Beiträge sind entscheidend. Die Codebasis ist gut strukturiert und bereit für Erweiterungen. Bitte Issues mit den Vorlagen Issue oder Feature request öffnen und beim Einreichen eines PRs die Pull-Request-Vorlage ausfüllen — wir reviewen und mergen Beiträge zügig.

**README-Übersetzungen:** `README.md` (Englisch) ist die Quelle der Wahrheit. Wenn du dessen Inhalt änderst, aktualisiere die Schwesterdateien `README.de.md`, `README.zh.md`, `README.ar.md`, `README.tr.md` und `README.nl.md` entsprechend.

## Lizenz & Links

MIT License - siehe LICENSE-Datei

- **Repository**: https://github.com/tickernelz/opencode-mem
- **Issues**: https://github.com/tickernelz/opencode-mem/issues
- **OpenCode Platform**: https://opencode.ai

Inspiriert von [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
