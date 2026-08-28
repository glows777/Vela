# Vela — 终端 AI Agent / Terminal AI Agent

> **Vela** 是一个基于 **Bun + TypeScript + AI SDK v7** 构建的终端交互式 AI Agent：多轮工具调用、MCP 扩展、跨会话记忆、RAG 知识库、上下文防御与压缩、Token 成本追踪，开箱即用。
>
> **Vela** is a terminal-interactive AI agent built with **Bun + TypeScript + AI SDK v7** — featuring multi-turn tool calling, MCP extension, cross-session memory, a RAG knowledge base, context defense & compaction, and token cost tracking.

```
┌─────────────────────────────────────────────────────────────┐
│  $ vela                                                  │
│  ───────────────────────────────────────────────────────  │
│  You: 总结 docs/ 目录下的部署文档                            │
│  Vela: [rag_search] 检索到 5 个相关片段…                    │
│        [read_file] docs/deployment-guide.md               │
│        ✅ 部署要点：1) 环境变量 2) 数据库迁移 3) 回滚策略     │
│  [Token] ~12,340 tokens (6%)   [Cost] $0.0031             │
└─────────────────────────────────────────────────────────────┘
```

---

## 📑 目录 / Table of Contents

- [✨ 功能特性 / Features](#-功能特性--features)
- [🚀 快速开始 / Quick Start](#-快速开始--quick-start)
- [🧭 使用指南 / Usage](#-使用指南--usage)
- [🏗️ 架构 / Architecture](#️-架构--architecture)
- [⚙️ 配置 / Configuration](#️-配置--configuration)
- [🛠️ 开发 / Development](#️-开发--development)
- [❓ 常见问题 / FAQ](#-常见问题--faq)
- [🧱 技术栈 / Tech Stack](#-技术栈--tech-stack)
- [📄 License](#-license)

---

## ✨ 功能特性 / Features

| 特性 / Feature | 说明 / Description |
|---|---|
| 🤖 多轮工具调用 Agent | 9 个核心工具 + RAG/记忆工具 + MCP 扩展 + 延迟工具搜索（`tool_search`）<br>9 core tools + RAG/memory tools + MCP + deferred tool search (`tool_search`) |
| 📚 **RAG 知识库** | `rag_ingest` 导入文档自动分块，`rag_search` 向量+关键词混合检索（sqlite-vec + FTS5）<br>Chunk documents via `rag_ingest`; hybrid vector+keyword retrieval via `rag_search` |
| 🧠 跨会话记忆 | Markdown 存储 + 索引 + 搜索，四类记忆（user / feedback / project / reference）<br>Markdown-backed memory with index & search (4 types) |
| 🛡️ 上下文防御 | 工具结果自动截断（Head/Tail 60/40）、过期结果 TTL 清理、Token 估算<br>Dynamic tool-result truncation, TTL pruning, token estimation |
| 🧹 上下文压缩 | microcompact 清理旧工具结果 + LLM 摘要压缩，长对话不爆上下文<br>microcompact + LLM summarization keep long chats within context |
| 💰 Token 成本追踪 | 9 家模型价格表 + prompt cache 分项计费（miss / read / write）<br>9-model pricing table + prompt-cache-aware cost tracking |
| 🔁 循环检测 & 重试 | 重复调用 / ping-pong / 全局熔断三种检测；指数退避 + 抖动重试<br>Loop detection (repeat / ping-pong / circuit breaker) + backoff retry |
| 📂 会话持久化 | JSONL checkpoint 存储，随时断点续聊<br>JSONL checkpoints for resumable sessions |
| 🖥️ 可视化调试 | `/context` 256 格 Token 分布矩阵、`/usage` 计费视图<br>256-cell context matrix (`/context`), usage view (`/usage`) |

---

## 🚀 快速开始 / Quick Start

### 环境要求 / Requirements

- [Bun](https://bun.sh) ≥ 1.4
- 一个 OpenAI 兼容的 API（`OPENAI_API_KEY`）

### 安装 / Install

```bash
bun install
cp .env.example .env   # 填入 OPENAI_API_KEY
```

### 运行 / Run

```bash
bun run dev            # watch 模式，代码变更自动重启
bun run src/index.ts   # 直接运行
```

> **没有 API Key？** 取消 `src/index.ts` 中 `// const model = createMockModel();` 的注释，即可用内置 Mock 模型离线运行（模拟 prompt cache 行为）。
>
> **No API key?** Uncomment `// const model = createMockModel();` in `src/index.ts` to run offline with the built-in mock model.

---

## 🧭 使用指南 / Usage

### 斜杠命令 / Slash Commands

| 命令 / Command | 说明 / Description |
|---|---|
| `/context` | 查看上下文 Token 分布矩阵 / context matrix visualization |
| `/usage` | 查看 Token 消耗与预估成本 / token usage & estimated cost |
| `/memory` | 列出所有记忆 / list memory entries |
| `/memory search <q>` | 搜索记忆 / search memory |
| `/cache on` / `/cache off` | 开关 Mock 模型 cache 模拟 / toggle mock cache simulation |
| `sim` | 注入模拟长对话（调试压缩用）/ inject simulated long conversation |

### 内置工具 / Built-in Tools

| 工具 / Tool | 说明 / Description |
|---|---|
| `read_file` / `write_file` / `edit_file` | 文件读写与精确编辑 / file read, write, precise edit |
| `list_directory` / `grep` / `glob` | 目录列举、正则搜索、模式匹配 / listing, regex search, glob |
| `bash` | 执行 shell 命令 / run shell commands |
| `web_fetch` | 抓取网页并转 Markdown / fetch web page to Markdown |
| `web_search` | 互联网搜索（Tavily / Serper）/ web search |
| `rag_ingest` | 导入文档到知识库（自动分块 + 向量化）/ ingest docs into KB |
| `rag_search` | 从知识库混合检索相关片段 / hybrid search over KB |
| `memory` | 跨会话记忆管理（save / list / search / read / delete）|
| `tool_search` | 搜索延迟加载的工具（如 MCP 工具）/ search deferred tools |

### MCP 扩展 / MCP Extension

通过官方 `@modelcontextprotocol/client` 接入 MCP Server（stdio 传输），例如 GitHub MCP Server。MCP 工具自动注册，也可通过 `tool_search` 延迟发现。连接使用指数退避重连（30s → 最大 5min）。

MCP servers (stdio) via the official `@modelcontextprotocol/client` — e.g. GitHub. Tools auto-register, discoverable via `tool_search`; exponential-backoff reconnect.

---

## 🏗️ 架构 / Architecture

```
src/
├── index.ts                # 入口：CLI、MCP 连接、命令分发 / entry: CLI, MCP, dispatcher
├── agent/
│   ├── index.ts            # agentLoop：多轮工具调用主循环 / main loop (MAX_TURN=15)
│   ├── retry.ts            # 指数退避 + 抖动重试 / exponential backoff with jitter
│   └── loop-detection.ts   # 重复 / ping-pong / 熔断检测 / loop detection
├── tools/
│   ├── index.ts            # 9 个核心工具汇总 / core tools
│   ├── registry.ts         # 工具注册表 + MCP 集成 / registry & MCP integration
│   ├── file.ts / search.ts / shell.ts / web.ts
│   ├── rag.ts              # rag_ingest / rag_search 工具
│   ├── memory-tool.ts      # memory 工具
│   └── tool-search.ts      # 延迟工具搜索 / deferred tool search
├── rag/
│   ├── chunker.ts          # 文档分块（段落 → 256 token/块）/ chunking
│   ├── embedder.ts         # OpenAI embedding（128 维 + 缓存）/ embeddings
│   ├── sqllite-store.ts    # sqlite-vec + FTS5 双路存储与混合检索 / vector+keyword store
│   └── search.ts           # 分数归一化 + MMR 去重 / score fusion & MMR
├── context/
│   ├── defense.ts          # 3 层防御：截断 → TTL → Token 估算 / context defense
│   ├── compressor.ts       # microcompact + LLM 摘要压缩 / compaction
│   └── view.ts             # 上下文矩阵渲染 / matrix renderer
├── memory/                 # Markdown 记忆存储 + 索引 + 搜索 / memory store
├── session/                # JSONL 会话 checkpoint / session persistence
├── usage/tracker.ts        # Token 追踪 + 9 家模型价格表 / token tracker & pricing
├── prompt/                 # System Prompt 片段 + 可插拔流水线 / prompt pipeline
├── commands/               # 斜杠命令（context / usage / memory / debug）
└── mock.ts                 # Mock 模型（模拟 prompt cache）/ mock model
```

### 请求流程 / Request Flow

```
用户输入 → 命令分发（斜杠命令优先）
  → PromptPipeline 构建 System Prompt（core rules + 记忆 + 会话信息）
  → agentLoop 多轮循环：
      流式调用模型 → 需要工具？→ 执行工具（并发控制 + 结果截断）
      → 检测循环 / 预算超限？→ 结束
  → 上下文防御（截断 + TTL）→ 会话 checkpoint 持久化 → Token 统计
```

### RAG 检索管线 / RAG Pipeline

```
rag_ingest: 文档 → chunker 分块(256 token) → embedder(128 维) → sqlite-vec + FTS5 双写
rag_search: 查询 → embedding → 向量检索(0.7) + FTS5 关键词(0.3) → 归一化合并 → MMR 去重(λ=0.7) → top-k
```

---

## ⚙️ 配置 / Configuration

### 环境变量 / Environment Variables

| 变量 / Variable | 必填 / Required | 说明 / Notes |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | OpenAI 兼容 API Key |
| `OPENAI_API_MODEL_NAME` | ✅ | 模型名，如 `gpt-5` |
| `OPENAI_API_BASE_URL` | ❌ | 自定义 Base URL（代理 / 兼容服务）|
| `TAVILY_API_KEY` / `SERPER_API_KEY` | ❌ | Web 搜索（二选一，自动检测）|
| `GITHUB_PERSONAL_ACCESS_TOKEN` | ❌ | GitHub MCP Server（stdio）|
| `EMBEDING_MODEL_KEY` / `EMBEDING_MODEL` / `EMBEDING_MODEL_BASE_URL` | ❌ | RAG embedding 模型配置 |

### 调参参考 / Tuning Reference

| 参数 / Parameter | 位置 / Location | 默认值 / Default | 说明 / Notes |
|---|---|---|---|
| `MAX_TURN` | `src/agent/index.ts` | 15 | 单轮最大工具调用轮数 / max tool-call turns |
| `TOKEN_BUDGET` | `src/agent/index.ts` | 200,000 | 单轮 Token 预算，超限强制结束 / token budget |
| `MAX_RETRIES` | `src/agent/index.ts` | 3 | 单步最大重试次数 / max retries per step |
| 循环检测阈值 | `src/agent/loop-detection.ts` | warning 10 / critical 20 / breaker 30 | 滑动窗口阈值 / sliding-window thresholds |
| `DEFAULT_MAX_RESULT_CHARS` | `src/tools/registry.ts` | 3000 | 工具结果默认截断长度 / default truncation |
| 模型价格表 | `src/usage/tracker.ts` | — | 9 家模型 prompt cache 计费 / pricing table |

---

## 🛠️ 开发 / Development

```bash
bun run dev       # watch 模式运行 / run with watch
bun run lint      # Biome 代码检查 / lint
bun run lint:fix  # 自动修复 / auto-fix
bun test          # 运行测试（Bun 内置）/ run tests
```

项目使用 [Biome](https://biomejs.dev) 做 lint/format，配置见 `biome.json`。新增模块时遵循现有目录约定（`src/<domain>/` + 对应测试文件）。

---

## ❓ 常见问题 / FAQ

**Q: 没有 OpenAI API Key 能体验吗？**
可以。取消 `src/index.ts` 中 `createMockModel()` 的注释即可离线运行，Mock 模型会模拟 prompt cache 行为。

**Q: RAG 提示"未找到支持 sqlite-vec 的 SQLite 动态库"？**
macOS 执行 `brew install sqlite`，Linux 确认系统 `libsqlite3` 存在。Vela 会自动探测常见路径。

**Q: MCP Server 连不上？**
Vela 使用指数退避自动重连（30s → 最大 5min）。检查 token 与 stdio 命令配置，GitHub MCP 需要 `GITHUB_PERSONAL_ACCESS_TOKEN`。

**Q: 上下文爆了 / 对话太长？**
系统会自动 microcompact 清理旧工具结果并用 LLM 摘要压缩；也可用 `/context` 查看 Token 分布，`TOKEN_BUDGET` 超限会强制结束本轮。

**Q: 知识库是空的？**
先调用 `rag_ingest` 导入文档（如 `docs/*.md`），再 `rag_search` 检索。数据存在 `knowledge.db`。

---

## 🧱 技术栈 / Tech Stack

- **Bun** — 运行时 / 包管理 / 测试（替代 Node.js + npm + vitest）
- **TypeScript** — 语言（strict 模式）
- **AI SDK v7**（`ai` + `@ai-sdk/openai`）— 模型调用与工具编排
- **MCP Client**（`@modelcontextprotocol/client`）— MCP 工具接入
- **sqlite-vec + FTS5** — RAG 向量存储与关键词检索
- **zod** — 工具参数校验
- **turndown** — HTML → Markdown 转换（web_fetch）
- **Biome** — lint / format

---

## 📄 License

Private project — 内部项目。
