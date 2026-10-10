# OpenCode Memory

[![npm version](https://img.shields.io/npm/v/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![npm downloads](https://img.shields.io/npm/dm/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![license](https://img.shields.io/npm/l/opencode-mem.svg)](https://www.npmjs.com/package/opencode-mem)
[![GitHub stars](https://img.shields.io/github/stars/tickernelz/opencode-mem.svg)](https://github.com/tickernelz/opencode-mem)

![OpenCode Memory Banner](.github/pics/banner.png)

语言: [🇬🇧](./README.md) | [🇩🇪](./README.de.md) | **🇨🇳** | [🇸🇦](./README.ar.md) | [🇹🇷](./README.tr.md) | [🇳🇱](./README.nl.md)

面向 AI 编程代理的持久记忆系统，基于本地向量数据库技术，实现跨会话的长期上下文保留。

## 核心功能

本地 Turso/libSQL 数据库与原生向量搜索、持久化项目记忆、自动用户画像学习、统一的记忆–提示时间线、功能完整的 Web UI、基于提示的智能记忆提取、多提供商 AI 支持（OpenAI、Anthropic）、12+ 本地嵌入模型、智能去重，以及内置隐私保护。

## 前置要求

本插件使用嵌入式 Turso（`@tursodatabase/database`），配合 `F32_BLOB` 向量与通过 `vector_distance_cos` 的精确余弦搜索。无需单独的向量数据库或自定义 SQLite 构建。

**推荐运行时：**

- Bun
- 标准 OpenCode 插件环境
- 若使用默认本地嵌入模型，首次使用时需要联网，因为模型由 `@huggingface/transformers` 下载。
- 对于源码/开发安装，请在构建或测试前运行 `bun install`。已发布的插件包会通过 OpenCode 自动安装其运行时依赖。

**CI 已测试平台：** Linux、Windows，以及 Apple Silicon 上的 macOS 15 / macOS 26（`darwin/arm64`）。**不支持 Intel Mac（`darwin/x64`）** — `@tursodatabase/database` 与固定版本的 `onnxruntime-node` 发行版均不提供 x64 原生绑定。更旧的 macOS 版本并未被该矩阵排除；它们只是不在当前 GitHub 托管的 runner 集合内。

**说明：**

- 向量嵌入直接存储并在 Turso 中搜索；插入时以 `F32_BLOB` 向量存储，用于精确余弦排序。
- 向量搜索通过 `vector_distance_cos` 使用精确余弦距离（无 DiskANN / 近似索引）；在提供查询字符串时可选用关键词混合排序（`@tursodatabase/database` 不附带 FTS5）。
- 会话查找使用已索引的 `session_id` 列（在 schema v2 上从 `metadata.sessionID` 回填）。
- 自动捕获与用户画像学习需要能返回结构化/工具调用输出的 AI 提供商。即使未配置自动捕获提供商，记忆的搜索/添加/列表仍可正常工作。

### 硬件 / 资源预期

opencode-mem **不**需要 GPU。本地嵌入通过 `@huggingface/transformers` 与 ONNX 在 CPU 上运行（没有 MLX 后端）。不需要额外的 VRAM。

| 工作负载                                              | 典型额外资源                                                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **本地嵌入**（默认 `Xenova/nomic-embed-text-v1`）     | 模型加载期间约 **0.5–2 GB RAM**，取决于所选 Hugging Face id。首次使用会下载模型；磁盘缓存在 `{storagePath}/.cache`（默认 `~/.opencode-mem/data/.cache`），每个模型通常为 **数百 MB 至约 1–2 GB**。 |
| **远程嵌入**（`embeddingApiUrl` + `embeddingApiKey`） | 本地 ML RAM 可忽略不计 — 仅有插件 + Turso 开销。                                                                                                                                                   |
| **数据库 / 插件**                                     | Turso/libSQL 存储在 `storagePath` 下的磁盘上。体积随存储的记忆数量增长，与 GPU 内存无关。                                                                                                          |

上述平台限制仍适用（不支持 Intel Mac `darwin/x64`；请使用 Apple Silicon、Linux、Windows，或远程嵌入端点）。参见[选择 / 配置嵌入模型](#选择--配置嵌入模型)。

### 从旧版 SQLite 分片升级

启动时会恢复中断的重新嵌入交换、将 libSQL DiskANN 索引转换为当前 Turso 引擎，然后验证或升级旧版分片 schema。即使存储已有完成的旧版迁移标记，引擎转换仍会运行，并在不重新嵌入的情况下保留已存储向量。每个转换后的数据库会备份为 `<database>.pre-tursodb-<timestamp>.bak`。

在 macOS 与 Linux 上，多个 OpenCode 会话可通过 Turso 的实验性 `multiprocess_wal` 共享同一 `storagePath`（每个进程必须使用相同模式 — 升级后请重启所有会话）。在 Windows 上引擎会拒绝该标志，因此同一时间只能有一个 OpenCode 会话拥有记忆数据库。

升级后首次启动时，opencode-mem 会自动将现有记忆分片数据库迁移为原生 Turso/libSQL 向量格式：

- 每个分片在重写前备份为 `<shard>.db.legacy.bak`
- 进度按分片记录在 `<shard>.db.turso-migrate.json`
- 仅在所有分片验证成功后才写入全局标记 `.turso-migrated`
- 迁移期间请勿对同一 `storagePath` 运行多个 OpenCode 实例；锁文件（`.turso-migrate.lock`）可防止并发迁移
- 手动维度迁移使用 `.turso-operation.lock`；在迁移完成前，其他插件进程会拒绝新的记忆写入

若迁移被中断，下次启动会自动从备份恢复。

若分片变得不兼容（例如更改 `embeddingDimensions` 之后），写入会被阻止，且原始数据库保持不变。请使用 Web UI 的重新嵌入迁移来构建并验证替换项，然后再交换到位。先前的分片仍可作为 `<shard>.db.pre-reembed-<pid>-<timestamp>.bak` 使用。

## Schema 迁移

本地 Turso 分片与辅助数据库（`metadata.db`、`user-prompts.db`、`user-profiles.db`、`ai-sessions.db`）通过 `src/services/turso/schema-migrations.ts` 中按序的 `PRAGMA user_version` 迁移进行升级。迁移是幂等的：启动插件时仅应用待处理的版本。

## 快速开始

对于 OpenCode v2，将包添加到原生 `plugins` 列表：

```jsonc
{
  "plugins": ["opencode-mem@latest"],
}
```

OpenCode 也会自动加载该包的 `./tui` 配套组件，以便
自动捕获 / 画像 / 错误 toast 能在 TUI 中渲染（服务器插件
无法直接调用 `ui.toast`）。你无需在
`plugins` 中添加第二条条目。若你对远程 OpenCode 服务器运行仅 CLI 的 TUI，
请在该 CLI 的插件列表中注册 `opencode-mem/tui`（例如
`cli.json`），以便配套组件可以订阅 toast RPC 事件。

对于 OpenCode v1，将默认入口点添加到配置
`~/.config/opencode/opencode.json`：

```jsonc
{
  "plugin": ["opencode-mem@latest"],
}
```

使用 `@latest`（或 semver 范围）且 `opencode-mem.jsonc` 中 `autoUpdate: true`（默认）时，当有更新的 npm 发布可用时，插件会清除 OpenCode 的缓存安装并提示你重启。像 `opencode-mem@2.26.0` 这样的固定版本永远不会自动更新。

### OpenCode v2 上的自动记忆上下文

v2 插件通过模型的系统上下文提供自动记忆上下文。
这些块不会添加到已编写的用户提示中，也不会存储在聊天记录中。
使用 `chatMessage.injectOn: "first"`（默认）时，会话的初始上下文会
跨用户轮次与模型步骤保留。使用 `"always"` 时，它会在每次
已编写的用户轮次上刷新。

在主机或插件重启后，已恢复的会话会在其
下一次模型请求时从当前记忆存储重建上下文，即使没有新的用户提示到达。
重建的上下文可能因记忆与画像的演变而与原先不同。
恢复不会捕获合成用户提示，也不会在 OpenCode 插件存储中存储
记忆文本的第二份副本。压缩会使缓存的自动
上下文失效；现有的压缩记忆恢复也会继续运行。

### 使用本地检出

要从本地源码检出而非 npm 发布版运行插件，请在检出目录中执行 `bun install && bun run build`，然后将 `plugins` 列表指向该检出目录：

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-mem"],
}
```

请指向包根目录，而非 `dist/` 或单个文件。OpenCode 通过回退到 `<directory>/index` 解析目录插件（当前版本上，OpenCode 对路径规格不会读取 `package.json` 的 `exports`/`main`），因此本仓库提供一个精简的根目录 `index.js`，从 `dist/plugin.js` 重新导出已构建的 v2 入口点，以及一个根目录 `tui.js`，重新导出 `dist/tui.js` 供 TUI 配套使用。指向文件的路径会被拒绝（`configured plugin path must be a directory`），没有根目录 `index.js` 的目录会被静默跳过。

### 可选的静态数据库加密

在 `~/.config/opencode/opencode-mem.jsonc` 中为本地 Turso 分片启用 AES-256-GCM 加密：

```jsonc
{
  "databaseEncryptionEnabled": true,
}
```

首次启动时，插件会创建 `~/.config/opencode/opencode-mem-db.key`（32 字节十六进制密钥，`chmod 600`）并迁移现有明文分片。若你自行管理密钥，可用 `"databaseEncryptionKey": "env://OPENCODE_MEM_DB_KEY"` 或 `"file://~/path/to.key"` 覆盖。丢失密钥意味着无法打开已加密的数据库。

**Windows：** 使用 `%USERPROFILE%\.config\opencode\opencode.json`（例如 `C:\Users\<you>\.config\opencode\opencode.json`）。本插件**不会**从 `%APPDATA%` 或 `%LOCALAPPDATA%` 读取其 OpenCode 插件条目 — 请将文件放在用户配置文件下的 `.config\opencode`，然后重启 OpenCode。若插件未出现，请确认该路径并再次重启。

插件会在下次启动时自动下载。

## 日常使用方式

你**不必**要求 OpenCode“记住”某些内容才能让插件工作。在默认设置下，记忆会随着你的工作逐步积累。

### 典型日常流程

1. 启用插件（参见[快速开始](#快速开始)）并重启 OpenCode。
2. 为自动捕获配置 AI 提供商 — 推荐：`opencodeProvider` + `opencodeModel`（或 `"opencodeModel": "inherit"`）。详情见[自动捕获 AI 提供商](#自动捕获-ai-提供商)。
3. 在 OpenCode 中正常工作。当会话空闲时，自动捕获会提取值得记住的技术上下文并存储。
4. 在后续会话中，相关记忆会被注入上下文（参见 `chatMessage` / 压缩设置）。可在 `http://127.0.0.1:4747` 的 Web UI 中浏览或编辑它们。
5. 当你希望立即存储或检索某些内容时，使用 `memory` 工具（参见[使用示例](#使用示例)）。

### 自动与手动记忆

| 方式                                             | 何时运行                 | 你需要做什么                                                                               |
| ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------ |
| **自动捕获**（`autoCaptureEnabled: true`，默认） | 会话空闲后的对话轮次之后 | 无需操作 — 提取是自动的                                                                    |
| **手动** `memory` 工具 / 命令                    | 按需                     | `add`、`search`、`list`、`profile`、`forget`、`list-shards`、`migrate`、`export`、`import` |

即使自动捕获未配置提供商，手动搜索/添加/列表仍可工作。自动捕获与用户画像学习需要能返回结构化/工具调用输出的提供商。

### 记忆 vs AGENTS.md / 项目文档

| 存入**记忆**                                  | 存入 **AGENTS.md** / 静态文档        |
| --------------------------------------------- | ------------------------------------ |
| 项目特定决策、缺陷模式、“我们试过 X 但失败了” | 很少变化的稳定规则与工作流           |
| 跨会话发现的用户偏好                          | 始终生效的编码约定与流程             |
| 应跟随你跨聊天的事实                          | 无论检索如何、每个代理都应看到的指令 |

经验法则：若是持久的项目指令，放入 AGENTS.md；若是从实际工作中增长的上下文，让记忆（或自动捕获）来保存。

### 基于提示的智能记忆提取

功能列表中的这一说法即**自动捕获**：对话结束后，后台 AI 请求会总结技术工作并将其保存为记忆。你无需特殊提示。设置了 `opencodeProvider` / `opencodeModel` 时使用它们，否则回退到手动的 `memoryProvider`。

### 用户画像

**用户画像**是一份独立的、跨项目的关于你工作方式的摘要（偏好、习惯）。它按间隔更新（`userProfileAnalysisInterval`，默认每分析 10 条提示），显示在 Web UI 的画像视图中，并可通过 `memory({ mode: "profile" })` 读取。正常使用时你无需手动填充 — 当提供商就绪时，画像学习会填充它。输出语言遵循 `autoCaptureLanguage`（默认 `"auto"`，镜像你提示的语言），与自动捕获记忆使用相同设置。

**“No profile found. Keep chatting to build your profile.”** 是预期的空状态，而非崩溃。画像学习需要：

1. 自动捕获正在运行且提供商可达（`opencodeProvider` + `opencodeModel`，或带有 `memoryModel` + `memoryApiUrl` 的完整手动回退）。
2. 自上次分析以来有足够的会话提示 — 至少 `userProfileAnalysisInterval`（默认 **10**）。
3. 该提供商支持结构化/工具调用输出（与自动捕获相同要求）。

若你已聊了一段时间仍看到该消息，请检查日志中自动捕获是否真正在触发，以及已配置的提供商是否成功（当提供商出错时，失败的画像分析不再隐藏在通用空状态之后）。

### Web UI

打开 `http://127.0.0.1:4747` 以浏览记忆–提示时间线、检查捕获内容并管理用户画像。若将服务器绑定到回环以外，参见 [Web UI HTTP Basic Auth](#web-ui-http-basic-auth)。

## 使用示例

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

在 `http://127.0.0.1:4747` 访问 Web 界面，进行可视化的记忆浏览与管理。

**网络绑定安全：** 除非你有意暴露 UI，否则请将 `webServerHost` 保持在 `127.0.0.1`。绑定到 `0.0.0.0`（或任何非回环主机）需要 `webServerApiToken`；所有 `/api/*` 请求随后必须发送 `Authorization: Bearer <token>` 或 `X-Opencode-Mem-Token`。使用 `?apiToken=<token>` 打开 UI，以便浏览器存储并发送它。

维度迁移会先生成每个新嵌入，将它们导入临时索引分片，验证行数，然后才替换原始文件。失败的迁移会保持源分片不变。

## 配置要点

在 `~/.config/opencode/opencode-mem.jsonc` 配置：

**Windows：** `%USERPROFILE%\.config\opencode\opencode-mem.jsonc`（与上述相同的 `.config\opencode` 目录 — 不是 AppData）。默认存储解析为 `%USERPROFILE%\.opencode-mem\data`（`~` 形式在 Windows 上也会展开为你的用户主目录）。

插件在首次启动时会在此路径创建完整的注释模板。有关每项设置与注释，参见 [`opencode-mem.example.jsonc`](opencode-mem.example.jsonc)。

### 聊天消息捕获与注入（`chatMessage`）

这些设置位于 `~/.config/opencode/opencode-mem.jsonc` 中的 `chatMessage` 键下：

| 选项                                                   | 默认值           | 作用                                                                                                                                                                                            |
| ------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                              | `true`           | 捕获已编写的用户提示并注入记忆上下文。                                                                                                                                                          |
| `injectOn`                                             | `"first"`        | 在会话的第一条用户消息上注入记忆上下文，或在每次已编写轮次上使用 `"always"`。                                                                                                                   |
| `maxMemories` / `excludeCurrentSession` / `maxAgeDays` | `3` / `true` / — | 注入上下文保留多少条记忆、是否排除当前会话中捕获的记忆，以及可选的天数年龄截止。                                                                                                                |
| `filterInjectedPrompts`                                | `true`           | 跳过由主机或其他 OpenCode 插件注入的提示文本（系统提醒、编排指令、后台任务通知），以免将其当作用户亲自输入而存储。                                                                              |
| `injectionMarkers`                                     | 内置             | 识别注入块的额外标记；添加到内置列表，永不替换它。                                                                                                                                              |
| `captureChildSessions`                                 | `false`          | 捕获编排器子会话的提示（带有 `parentID` 的会话，例如 OpenCode 任务/子代理子会话）。其“用户”消息由父代理写入，而非你本人，因此默认不会存储、自动捕获、用于画像学习，也不会获得注入的记忆上下文。 |

### 选择 / 配置嵌入模型

嵌入为记忆与用户画像提供相似性搜索能力。在同一文件中配置（`~/.config/opencode/opencode-mem.jsonc`）。**没有 MLX 后端** — 本地嵌入使用带 ONNX 的 `@huggingface/transformers`，而非 Apple MLX。

**本地（默认）：** 仅设置 `embeddingModel`。首次使用时模型从 Hugging Face 下载并缓存在 `{storagePath}/.cache`（默认 `~/.opencode-mem/data/.cache`）下。

**远程（OpenAI 兼容）：** 同时设置 `embeddingApiUrl` 与 `embeddingApiKey`。插件随后使用 Bearer 令牌调用 `{embeddingApiUrl}/embeddings`。`embeddingApiKey` 接受与 `memoryApiKey` 相同的密钥格式（`literal`、`env://…`、`file://…`）。

| 键                         | 作用                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `embeddingModel`           | Hugging Face id（本地）或 API 模型名（远程）。默认：`Xenova/nomic-embed-text-v1`                            |
| `embeddingDimensions`      | 可选覆盖；通常可省略 — 维度从内置映射查找                                                                   |
| `embeddingPooling`         | 本地池化：`"mean"`（默认）、`"cls"` 或 `"last_token"`。未设置 → 小型已知模型预设或 `"mean"`                 |
| `embeddingQueryPrefix`     | 查询任务嵌入的前缀。未设置 → 模型预设，或在 `embeddingUseTaskPrefixes` 为 true 时使用 Nomic。显式 `""` 禁用 |
| `embeddingDocumentPrefix`  | 文档任务嵌入的前缀（与 `embeddingQueryPrefix` 相同的解析规则）                                              |
| `embeddingUseTaskPrefixes` | 当自定义/预设前缀未设置时，可选启用 Nomic 的 `search_query:` / `search_document:` 前缀。默认 `false`        |
| `embeddingDtype`           | 可选的本地 ONNX dtype 覆盖（例如 `"q8"`、`"fp32"`）。设置后会传给 transformers.js 的 `pipeline({ dtype })`  |
| `embeddingApiUrl`          | OpenAI 兼容嵌入 API 的基础 URL（末尾路径不超过 `/v1`）                                                      |
| `embeddingApiKey`          | 该端点的 API 密钥（需与 `embeddingApiUrl` 一起设置）                                                        |

推荐的本地模型：

| 模型                                 | 维度 | 说明                                 |
| ------------------------------------ | ---- | ------------------------------------ |
| `Xenova/nomic-embed-text-v1`         | 768  | 默认；多语言，8192 上下文；mean 池化 |
| `Xenova/jina-embeddings-v2-base-en`  | 768  | 仅英语，8192 上下文                  |
| `Xenova/jina-embeddings-v2-small-en` | 512  | 更快，8192 上下文                    |
| `Xenova/all-MiniLM-L6-v2`            | 384  | 非常快，512 上下文                   |
| `Xenova/all-mpnet-base-v2`           | 768  | 质量较好，512 上下文                 |
| `Xenova/bge-m3`                      | 1024 | 多语言；自动 CLS 池化                |
| `intfloat/multilingual-e5-large`     | 1024 | 自动 `query:` / `passage:` 前缀      |

示例 — 远程 OpenAI 嵌入：

```jsonc
{
  "embeddingApiUrl": "https://api.openai.com/v1",
  "embeddingApiKey": "env://OPENAI_API_KEY",
  "embeddingModel": "text-embedding-3-small",
}
```

示例 — 本地 bge-m3（池化通过预设默认为 CLS；如需可覆盖）：

```jsonc
{
  "embeddingModel": "Xenova/bge-m3",
  // "embeddingPooling": "cls",
  // "embeddingDtype": "q8",
}
```

更改 `embeddingModel`、维度、池化或任务前缀可能需要对已存储的记忆重新嵌入，以使存储与查询向量保持对齐。建议为给定数据目录选定一次模型（以及池化/前缀设置）并坚持使用。

**不支持 — Intel Mac（`darwin/x64`）：** 本地持久化需要 `@tursodatabase/database`，其不发布 Intel Mac 原生绑定。固定版本的 `onnxruntime-node` 发行版（`1.24.1+`，包括固定的 `1.30.0`）也缺少 darwin/x64。请使用 Apple Silicon Mac、Linux 或 Windows，或通过 `embeddingApiUrl` + `embeddingApiKey` 使用远程端点（见上方示例）。在受支持平台上，`opencode-mem` 固定 `onnxruntime-node@1.30.0`（来自 `1.24.1` / #225 的 Ort::Env 拆卸修复），并通过 CJS 解析 shim 加载 transformers，以便 OpenCode 嵌套安装保留该绑定。在安装该 shim 之前，transformers 会解析为绝对路径，以免 OpenCode 的 Bun `--compile` 主机因 `Cannot find module '@huggingface/transformers' from ''` 而失败。升级后，请清除 OpenCode 的嵌套插件缓存（`~/.cache/opencode/packages/opencode-mem@*`）并重新安装。

### 记忆范围

- `scope: "project"`：仅查询当前项目。这是默认值。
- `scope: "all-projects"`：跨所有项目分片查询 `search` / `list`。
- `memory.defaultScope` 在未提供显式范围时设置默认查询范围。

### Web UI HTTP Basic Auth

当 `webServerHost` 设置为回环以外的任何值（例如 `0.0.0.0`）时，网络上的任何人都可以访问 Web UI。为避免记忆暴露在局域网中，请通过用于其他一切的同一配置文件，用 HTTP Basic Auth 保护 Web 服务器：

```jsonc
{
  "webServerHost": "0.0.0.0", // optional: reach the UI from the LAN
  "webServerAuthPassword": "pick-a-strong-one",
  "webServerAuthUsername": "admin", // optional, defaults to the current OS user
}
```

| 字段                    | 默认值             | 效果                                                                            |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `webServerAuthPassword` | _(空)_             | 设置后，服务器会在每个请求上要求 HTTP Basic Auth 凭据。留空以保持默认开放行为。 |
| `webServerAuthUsername` | OS 用户（`$USER`） | Basic Auth 质询所需的用户名。                                                   |

`webServerAuthPassword` 接受与 `memoryApiKey` 相同的密钥格式：

- 字面字符串（简单，适合个人机器），
- `env://SOME_ENV_VAR` 在启动时从环境拉取值，
- `file:///path/to/secret` 从文件读取（推荐 `chmod 600` — 若文件全局可读，插件会发出警告）。

浏览器会弹出其原生 Basic Auth 对话框，并在当前会话中记住凭据；关闭所有浏览器窗口会丢弃它们，因此重新打开浏览器需要再次登录。凭据以恒定时间比较进行比对，未认证的 401 响应带有 `Cache-Control: no-store`，因此中间缓存不会重放它。启用认证后 CORS 也会放宽，以便同一局域网上的其他工具在认证后可以访问 API。

### 在嵌套仓库间共享同一项目记忆

默认情况下，项目由其包围的 git 仓库标识，因此每个
物理 git 仓库都有自己独立的记忆存储。这对
多仓库工作区是错误的 — 由 Google [`repo`](https://gerrit.googlesource.com/git-repo/+/HEAD/Docs/manual-repo.md)
管理的树、单体仓库，或任何多个嵌套 git 仓库属于同一
逻辑项目的布局 — 因为每个子仓库都会被隔离。

在工作区根目录放置一个空的 **`.opencode-mem-project`** 标记文件：

```
my-workspace/
├── .opencode-mem-project   ← workspace root
├── kernel/                 (own git repo)
├── userspace/              (own git repo)
└── tools/                  (own git repo)
```

然后，在标记下方任意位置启动的每个会话都会解析到该
根目录并共享一个记忆存储，无论工作目录位于哪个子仓库：

```sh
touch ~/my-workspace/.opencode-mem-project
```

标记通过从每条代码路径已经传入的工作目录向上遍历来查找
（插件的工作目录、Web API 的
`process.cwd()`），因此身份是**目录驱动且与进程无关**的。
它不依赖环境变量或全局配置值，在这里这些会
不可靠：opencode-mem 跨多个共享单个 Web 服务器的
opencode 进程运行，而这些进程中只有一部分携带给定
环境变量。有了标记，项目根始终从会话实际
运行的位置派生。

标记优先于 git 检测。存在时，
子仓库自己的 git remote 会被有意忽略（它只会描述一个
嵌套仓库）。没有标记时，行为不变（基于 git 的
身份）。

### 迁移或恢复项目记忆

opencode-mem 按项目身份的哈希为项目分片建立键。移动
仓库（操作系统迁移、路径重组、从 Windows 挂载切换到
原生路径）因此可能使旧分片在
`~/.opencode-mem/data/projects/` 下成为孤立，同时为新路径创建新的空分片。

这些是带有 JSON 参数的 OpenCode `memory` 工具调用，而非在
终端中运行的命令。Issue 风格的 `memory migrate --from ...` 记法对应
`memory({ mode: "migrate", fromPath: "..." })`。

**1. 你仍知道旧路径时的本地移动**

在**新**项目目录中打开 OpenCode。目标项目不得
已包含记忆（冲突时迁移会中止且保持不变）。在更改任何内容之前预览
检测到的源、目标与文件操作：

```typescript
memory({ mode: "migrate", fromPath: "/old/path/to/project", dryRun: true });
memory({ mode: "migrate", fromPath: "/old/path/to/project" });
```

为安全起见，若源的已存储项目目录仍然存在，迁移会拒绝。若你有意移动活动源，请先检查 dry-run
输出，然后传入 `allowLinkedSource: true`。原始源分片
文件会保留为带时间戳的 `*.pre-path-migrate-*.bak` 备份。

**2. 旧路径已消失 — 先发现孤立分片**

```typescript
memory({ mode: "list-shards" });
memory({ mode: "migrate", fromHash: "fa645294d88bbae2" });
```

`list-shards` 报告每个项目哈希、已存储的 `projectPath`、记忆数量，
以及状态（`current`、`linked`、`orphaned`、`missing-file`、`empty` 或
`ambiguous`）。`fromHash` 是此调用返回的 16 字符小写十六进制 `scopeHash`。
当旧目录不再存在或
多个分片包含相同已存储路径时优先使用它，因为基于 git 的身份
并不总能从缺失路径重新计算。

**3. 跨机器备份 / 恢复**

```typescript
// on the source machine / old checkout
memory({ mode: "export", outputPath: "./memories.json" });

// on the destination machine / new checkout
memory({ mode: "import", inputPath: "./memories.json", dryRun: true });
memory({ mode: "import", inputPath: "./memories.json" });
```

导出写入不含向量的版本化 JSON 文档。导入会将
记忆重新映射到当前项目，并用当前配置的模型重新计算嵌入。导入会向现有项目添加记忆，但重复的
记忆 ID 会在写入前中止整个导入；这与 `migrate` 不同，
后者要求目标为空。

导出文件是明文的，可能包含记忆内容、用户名/电子
邮件地址、仓库 URL 与绝对项目路径。请像对待其他
敏感备份一样存储它们，并在不再需要时删除。完全私有的条目
会被省略，且不包含用户画像与提示历史。该
文档包含 `schemaVersion: 1`；导入会拒绝较新的不支持 schema
版本，而非猜测。

### 自动捕获 AI 提供商

自动捕获运行后台 AI 请求以总结技术工作并将其保存为记忆。它需要以下提供商配置之一。

**推荐：** 使用已在 opencode 中认证且支持结构化输出的提供商：

```jsonc
"opencodeProvider": "anthropic",
"opencodeModel": "claude-haiku-4-5-20251001",
```

插件向 opencode 的会话 API 发出结构化输出请求，而非直接调用提供商端点，因此由 opencode 拥有认证、令牌刷新与提供商路由。提供商名称必须与 `opencode providers list` 中的条目匹配，且所选模型必须通过 opencode 支持结构化 JSON 输出。

可选地用 `"opencodeVariant": "xhigh"` 固定模型推理变体（例如用于 grok-4.7）。它会应用于插件的内部 LLM 调用（自动捕获摘要、画像学习、画像清理），包括当 `opencodeModel` 为 `"inherit"` 时，以便后台工作可以使用与交互式会话不同的推理级别。

慢速推理模型（或非常大的画像提示）可能超过默认的 90 秒结构化输出预算。设置 `"opencodeTimeoutMs"`（毫秒）可为内部结构化输出调用（自动捕获摘要、画像学习）延长 — 例如 `"opencodeTimeoutMs": 180000` 表示 3 分钟。值钳制在 10000..600000；默认保持 90000。数字字符串会被强制转换。画像清理使用单独的、更长的超时。

支持的提供商：`opencode providers list` 列出的任何提供商（例如 `anthropic`、`openai`、`github-copilot` 等）。

若设置了 `opencodeProvider` 与 `opencodeModel`，它们优先于下方的手动 `memoryProvider` 设置。

**跟随会话模型：** 设置 `"opencodeModel": "inherit"` 以在调用时使用具体的 OpenCode 模型，而非固定 id。对于**自动捕获**，每个提示通过 `chat.params` 钩子记录，捕获请求重用该提示的提供商/模型。对于**画像学习**及其他结构化输出路径（不绑定到单条用户消息），`inherit` 回退到 OpenCode `model.json` 最近列表中的最新模型（优先使用已配置的 `opencodeProvider`）。发送字面模型 id `inherit` 永远无效，此前会在这些路径上导致 `ProviderModelNotFoundError: Model not found: <provider>/inherit`。`opencodeProvider` 仍作为正常配置门控是必需的。

**回退：** 手动 API 配置（若不使用 opencodeProvider）：

```jsonc
"memoryProvider": "openai-chat",
"memoryModel": "gpt-4o-mini",
"memoryApiUrl": "https://api.openai.com/v1",
"memoryApiKey": "sk-...",
```

**API 密钥格式：**

```jsonc
"memoryApiKey": "sk-..."
"memoryApiKey": "file://~/.config/opencode/api-key.txt"
"memoryApiKey": "env://OPENAI_API_KEY"
```

手动 `memoryProvider` 模式：

- `openai-chat`：兼容 OpenAI Chat Completions、带工具/函数调用的 API。仅当所选上游模型与代理保留工具调用时，这可与兼容代理（如 LiteLLM）一起工作。
- `openai-responses`：带函数调用输出的 OpenAI Responses API。
- `anthropic`：带工具使用的 Anthropic Messages API。
- `minimax`：MiniMax Anthropic Messages 兼容端点。将 `memoryApiUrl` 设置为全球端点（`https://api.minimax.io`）或中国端点（`https://api.minimaxi.com`）；`/anthropic/v1/messages` 路径与 `x-api-key` 标头会自动应用。当前模型包括 `MiniMax-M3`（1,000,000-token 上下文；自适应或禁用思考）与 `MiniMax-M2.7`（204,800-token 上下文；始终开启思考）。`MiniMax-M3` 通过 `memoryExtraParams` 支持自适应思考。
- `orcarouter`：带命名空间模型 ID 的 OpenAI 兼容模型网关。`memoryApiUrl` 与 `memoryModel` 可选 — 它们默认为 `https://api.orcarouter.ai/v1` 与 `orcarouter/auto`（按请求选择有能力模型的路由别名）。若设置 `memoryModel`，请使用命名空间 ID，例如 `openai/gpt-5.5` 或 `deepseek/deepseek-v4-flash`；OrcaRouter 拒绝裸模型名。示例：
  ```jsonc
  "memoryProvider": "orcarouter",
  "memoryApiKey": "<OrcaRouter API key>",
  ```
  [OrcaRouter](https://www.orcarouter.ai) 还在同一端点上为 AI 代理运行网关级零信任安全 — 默认拒绝基础上筛选每个提示/响应并治理每个工具调用，无需更改应用代码。
- `atlas-cloud`：面向 [Atlas Cloud](https://www.atlascloud.ai) 的 OpenAI 兼容 Chat Completions 预设。`memoryApiUrl` 与 `memoryModel` 可选 — 它们默认为 `https://api.atlascloud.ai/v1` 与 `deepseek-ai/deepseek-v4-pro`。若省略 `memoryApiKey`，则使用环境中的 `ATLASCLOUD_API_KEY`。示例：
  ```jsonc
  "memoryProvider": "atlas-cloud",
  "memoryApiKey": "env://ATLASCLOUD_API_KEY",
  ```
  选择此提供商时，自动捕获 / 画像提示、模型响应与相关对话上下文会传输到 `https://api.atlascloud.ai`。

故障排除：

- 自动捕获失败不会阻止手动 `memory` 工具使用。
- 若自动捕获报告提供商未连接，请用 `opencode providers list` 确认提供商名称，并先在 opencode 中配置该提供商。
- 若代理或自定义提供商返回纯文本而非结构化/工具输出，请选择另一模型/提供商，或使用上方手动提供商模式之一。
- 对于拒绝 `temperature` 的模型，在使用手动 API 配置时添加 `"memoryTemperature": false`。
- 对于拒绝强制工具调用（`tool_choice: "required"`，例如某些思考模式）的模型，在使用 `openai-chat` / `orcarouter` / `atlas-cloud` 时添加 `"forceToolChoice": false`。
- 对于 `opencodeProvider` / `opencodeModel`（例如 DeepSeek V4 thinking），OpenCode 仍会为结构化输出发送强制的 `tool_choice`。opencode-mem 在内部 `opencode-mem-structured` 代理上禁用思考（并在变体合并后在 `chat.params` 中重新应用），以便自动捕获与画像学习可以完成。你的交互式聊天代理不变。若捕获仍因 thinking/`tool_choice` 错误失败，请为 `opencodeModel` 选择非思考模型，或配置完整的手动回退（`memoryModel` + `memoryApiUrl`）。
- **`opencode-claude-auth` / Claude Code：** 自动捕获使用带有你已认证 `anthropic` 提供商的 OpenCode。强制的 `format: json_schema` 常与 Claude-auth 循环，因此 opencode-mem 对 `opencodeProvider: "anthropic"` 使用保留认证的 **text-JSON** 路径（无强制 `StructuredOutput` 工具；用 Zod 解析回复）。步骤看门狗仍会在 2 步后中止失控的内部会话。若捕获仍失败，请配置完整的手动 Anthropic API 密钥回退（`memoryProvider: "anthropic"` + `memoryModel` + `memoryApiUrl` + `memoryApiKey`）— Claude Pro/Max OAuth 无法在 OpenCode 外重用。
- **不支持的平台：** 不支持 Intel Mac（`darwin/x64`） — `@tursodatabase/database` 与固定版本的 `onnxruntime-node` 发行版（固定 `1.30.0`）不提供 x64 原生绑定。请使用 Apple Silicon、Linux 或 Windows，或通过 `embeddingApiUrl` + `embeddingApiKey` 使用远程嵌入端点。不支持 MLX。

## 公共子路径导出

除了主插件入口外，`opencode-mem` 还暴露一个稳定的子路径，
其他 opencode 插件可直接导入。这避免了在编写读写同一记忆存储的第三方工具时，
不得不逆向工程容器标签约定。

### `opencode-mem/tags`

规范的容器标签辅助函数。与 opencode-mem 自身用于
限定自动捕获记忆范围的相同函数。

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

这些辅助函数产生的标签与自动捕获写入的匹配，因此调用 `POST /api/memories` 的第三方
插件会落入系统其余部分已理解的同一分片。手工制作的标签若子串不是
`_project_` 或 `_user_`，会落入 `/api/stats` 与
`/api/memories` 静默过滤掉的影子分片 — 使用这些辅助函数可避免该陷阱。

## 开发与贡献

本地构建与测试：

```bash
bun install
bun run build
bun run typecheck
bun run format
```

本项目积极寻求贡献，以成为 AI 编程代理的权威记忆插件。无论你是修复缺陷、添加功能、改进文档，还是扩展嵌入模型支持，你的贡献都至关重要。代码库结构良好，已准备好增强。请使用 Issue 或 Feature request 模板提出问题，并在提交 PR 时填写 pull request 模板 — 我们会快速审查并合并贡献。

**README 翻译：** `README.md`（英文）为唯一权威来源。更改其内容时，请同步更新同级文件 `README.de.md`、`README.zh.md`、`README.ar.md`、`README.tr.md` 和 `README.nl.md`。

## 许可证与链接

MIT License - 参见 LICENSE 文件

- **仓库**：https://github.com/tickernelz/opencode-mem
- **Issues**：https://github.com/tickernelz/opencode-mem/issues
- **OpenCode 平台**：https://opencode.ai

灵感来自 [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
