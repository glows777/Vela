# Vela — 终端 AI Agent / Terminal AI Agent

> **Vela** 是一个基于 **Bun + TypeScript + AI SDK** 构建的终端交互式 AI Agent（CLI 助手），具备多轮工具调用、MCP 扩展、跨会话记忆、上下文防御与压缩、Token 成本追踪等能力。
>
> **Vela** is a terminal-interactive AI agent (CLI assistant) built with **Bun + TypeScript + AI SDK**. It features multi-turn tool calling, MCP extension, cross-session memory, context defense & compaction, and token cost tracking.

---

## ✨ 功能特性 / Features

| 特性 / Feature | 说明 / Description |
|---|---|
| 🤖 多轮工具调用 Agent | 内置 9 个工具 + MCP 扩展 + 延迟工具搜索（`tool_search`）<br>Multi-turn tool-calling loop (max 15 turns) with 9 built-in tools + MCP + deferred tool search |
| 🛡️ 上下文防御 | 超大工具结果自动截断（Head/Tail 60/40）、过期结果 TTL 清理、Token 估算<br>Dynamic tool-result truncation, TTL pruning of stale results, token estimation |
| 🧠 上下文压缩 | microcompact 清理旧工具结果 + LLM 摘要压缩，长对话不爆上下文<br>microcompact clears old tool results; LLM summarization keeps long conversations within context |
| 💾 记忆系统 | 跨会话持久记忆（用户偏好 / 项目知识 / 参考信息），Markdown 存储 + 索引 + 搜索<br>Cross-session persistent memory (user / project / reference), Markdown-backed with index & search |
| 📂 会话持久化 | JSONL checkpoint 存储，随时断点续聊<br>JSONL checkpoint storage for resumable sessions |
| 💰 Token 成本追踪 | 多模型价格表 + prompt cache 分项计费（miss / read / write）<br>Multi-model price table + prompt-cache-aware cost tracking (miss / read / write) |
| 🔁 循环检测 & 重试 | 重复调用 / ping-pong / 全局熔断三种检测器；指数退避 + 抖动重试<br>Loop detection (repeat / ping-pong / circuit breaker) + exponential backoff with jitter |
| 🖥️ 可视化调试 | `/context` 256 格 Token 分布矩阵图、`/usage` 计费视图<br>256-cell context matrix (`/context`), usage view (`/usage`) |

---

## 🚀 快速开始 / Quick Start

### 环境要求 / Requirements

- [Bun](https://bun.sh) ≥ 1.3
- 一个 OpenAI 兼容的 API（`OPENAI_API_KEY`）

### 安装 / Install

```bash
bun install
```

### 配置环境变量 / Environment Variables

复制 `.env.example` 并填写（`.env` 已被 gitignore，不会入库）：

```bash
cp .env.example .env
```

| 变量 / Variable | 必填 / Required | 说明 / Notes |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | OpenAI 兼容 API 密钥 / API key |
| `OPENAI_API_MODEL_NAME` | ✅ | 模型名，如 `gpt-5` / model name |
| `OPENAI_API_BASE_URL` | ❌ | 自定义 Base URL（代理 / 兼容服务），缺省为官方端点 |
| `TAVILY_API_KEY` / `SERPER_API_KEY` | ❌ | Web 搜索服务，二选一即可，`web_search` 自动检测 |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | ❌ | GitHub MCP Server（stdio 传输）|

> **搜索服务**：`web_search` 工具会自动检测 `TAVILY_API_KEY` 或 `SERPER_API_KEY`，配置任一即可。
>
> **Web search**: the `web_search` tool auto-detects `TAVILY_API_KEY` or `SERPER_API_KEY` — configure either one.

### 运行 / Run

```bash
bun run dev        # watch 模式，代码变更自动重启 / watch mode with auto-restart
bun run src/index.ts  # 直接运行 / direct run
```

> **无 API Key 开发调试**：可将 `src/index.ts` 中 `// const model = createMockModel();` 取消注释，使用内置 Mock 模型（模拟 prompt cache 行为）离线运行。
>
> **No API key?** Uncomment `// const model = createMockModel();` in `src/index.ts` to run offline with the built-in mock model (simulates prompt-cache behavior).

---

## 🧭 使用指南 / Usage Guide

### 斜杠命令 / Slash Commands

| 命令 / Command | 说明 / Description |
|---|---|
| `/context` | 查看上下文窗口 Token 分布矩阵图 / context matrix visualization |
| `/usage` | 查看 Token 消耗与预估成本 / token usage & estimated cost |
| `/memory` | 列出所有记忆 / list all memory entries |
| `/memory search <q>` | 搜索记忆 / search memory |
| `/cache on` / `/cache off` | 开启 / 关闭 Mock 模型的 cache 模拟 / toggle mock cache simulation |
| `sim` | 注入模拟长对话（调试上下文压缩用）/ inject simulated long conversation |

### 内置工具 / Built-in Tools

| 工具 / Tool | 说明 / Description |
|---|---|
| `read_file` / `write_file` / `edit_file` | 文件读写与精确编辑 / file read, write, precise edit |
| `list_directory` / `grep` / `glob` | 目录列举、正则搜索、模式匹配 / directory listing, regex search, glob |
| `bash` | 执行 shell 命令 / run shell commands |
| `web_fetch` | 抓取网页并转 Markdown / fetch web page to Markdown |
| `web_search` | 互联网搜索（Tavily / Serper）/ web search |
| `tool_search` | 搜索延迟加载的工具（MCP 工具不在列表时使用）/ search deferred tools (e.g. MCP) |
| `memory` | 跨会话记忆管理（save / list / search / read / delete）/ cross-session memory management |

### MCP 扩展 / MCP Extension

通过官方 `@modelcontextprotocol/client` 接入 MCP Server（stdio 传输），例如 GitHub MCP Server。MCP 工具会自动注册到工具列表，也可通过 `tool_search` 延迟发现。当前 GitHub 连接代码处于开发中（见 `src/index.ts`）。

MCP servers (stdio transport) are supported via the official `@modelcontextprotocol/client` — e.g. GitHub MCP Server. MCP tools auto-register into the tool list and can also be discovered on demand via `tool_search`. GitHub integration is currently under development (see `src/index.ts`).

#### 实操：接入 GitHub MCP Server / Example: GitHub MCP

```bash
# 1. 创建 GitHub Personal Access Token（需 repo / read:org 权限）
#    https://github.com/settings/tokens
# 2. 写入 .env
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx
# 3. 启动 Vela（需要本机可执行 npx）
bun run dev
```

启动时 Vela 会通过 `npx @modelcontextprotocol/server-github`（stdio）连接 GitHub MCP Server，并把注册到的工具并入工具列表；连接失败会自动指数退避重试（初始 30s → 最大 5min）。未配置 Token 时跳过连接并使用 Mock MCP，不影响主流程。

On startup, Vela connects to the GitHub MCP Server via `npx @modelcontextprotocol/server-github` (stdio) and merges its tools into the registry; failures retry with exponential backoff (30s → 5min max). Without a token, it skips the connection and uses a Mock MCP, so the main flow is unaffected.

---

## 🏗️ 架构 / Architecture

```
src/
├── index.ts                 # CLI 入口：readline 主循环、模型初始化、命令分发 / entrypoint
├── agent/
│   ├── index.ts             # Agent 循环（MAX_TURN=15、Token 预算 200k）/ agent loop
│   ├── loop-detection.ts    # 循环检测（重复 / ping-pong / 熔断）/ loop detection
│   └── retry.ts             # 可重试错误 + 指数退避 / retry with exponential backoff
├── tools/
│   ├── registry.ts          # 工具注册表、读写锁并发控制、结果截断 / tool registry & concurrency
│   ├── file.ts / shell.ts   # 文件 & shell 工具 / file & shell tools
│   ├── search.ts            # grep / glob / list_directory / search tools
│   ├── web.ts               # web_fetch / web_search（Tavily / Serper）
│   ├── tool-search.ts       # 延迟工具搜索 / deferred tool search
│   ├── memory-tool.ts       # 记忆系统工具 / memory tool
│   └── index.ts             # 内置工具汇总 / built-in tools
├── prompt/
│   ├── index.ts             # System Prompt 片段（core rules 等）/ prompt fragments
│   └── pipelins.ts          # PromptPipeline 可插拔流水线 / pluggable prompt pipeline
├── context/
│   ├── defense.ts           # 3 层防御：截断 → TTL 裁剪 → Token 估算 / context defense
│   ├── compressor.ts        # microcompact + LLM 摘要压缩 / context compaction
│   ├── view.ts              # 上下文矩阵图渲染 / context matrix renderer
│   └── tool-result-output.ts # 工具结果输出归一化 / tool result normalization
├── memory/                  # Markdown 记忆存储 + 索引 + 搜索 / memory store
├── session/                 # JSONL 会话 checkpoint / session persistence
├── usage/
│   └── tracker.ts           # Token 追踪 + 多模型价格表 + cache 计费 / token tracker & pricing
├── commands/                # 斜杠命令（context / usage / memory / debug）
├── mock.ts                  # Mock 模型（模拟 prompt cache）/ mock model
└── ai-sdk-v6.test.ts        # 测试 / tests
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

```
user input → command dispatch (slash commands take priority)
  → PromptPipeline builds system prompt (rules + memory + session info)
  → agentLoop multi-turn loop:
      stream model → need tools? → execute tools (concurrency + truncation)
      → loop detected / budget exceeded? → end
  → context defense (truncate + TTL) → session checkpoint → token stats
```

---

## 🧪 测试 / Testing

```bash
bun test
```

| 测试文件 / File | 覆盖内容 / Coverage |
|---|---|
| `src/ai-sdk-v6.test.ts` | AI SDK v6 usage 归一化 + Mock 模型下完整 agent 循环 / usage normalization & full agent loop on mock |
| `src/openai-cache-usage.test.ts` | OpenAI prompt cache 计费字段（miss / read / write）/ cache billing fields |
| `src/agent/loop-detection.test.ts` | 循环检测（重复调用 / ping-pong / 熔断）/ loop detection detectors |

---

## 📁 其他目录 / Misc Directories

| 目录 / Dir | 说明 / Notes |
|---|---|
| `app/` | 计算器 demo 页面（与 `calculator/` 内容一致，疑似冗余）/ calculator demo page (identical to `calculator/`, likely redundant) |
| `calculator/` | 计算器 demo 页面 / calculator demo page |
| `sample/` | 带 TODO/FIXME 的示例代码，供代码分析 / 工具演示用 / sample code with intentional TODO/FIXME for tool demos |
| `.sessions/` | 运行时会话 checkpoint（JSONL，已 gitignore）/ runtime session checkpoints (gitignored) |
| `.usage/` | 运行时 Token 用量记录（JSONL，未忽略，建议加入 .gitignore）/ runtime usage records (JSONL, not gitignored — consider adding) |

---

## ⚙️ 配置说明 / Configuration Reference

| 参数 / Parameter | 位置 / Location | 默认值 / Default | 说明 / Notes |
|---|---|---|---|
| `MAX_TURN` | `src/agent/index.ts` | 15 | Agent 单轮对话最大工具调用轮数 / max tool-call turns per exchange |
| `TOKEN_BUDGET` | `src/agent/index.ts` | 200,000 | 单轮 Token 预算，超限强制结束 / per-exchange token budget |
| `MAX_RETRIES` | `src/agent/index.ts` | 3 | 单步最大重试次数 / max retries per step |
| 循环检测阈值 | `src/agent/loop-detection.ts` | warning 10 / critical 20 / breaker 30 | 重复调用滑动窗口阈值 / sliding-window thresholds |
| MCP 重试 | `src/index.ts` | 初始 30s → 最大 5min | 指数退避连接 MCP / MCP reconnect backoff |
| `DEFAULT_MAX_RESULT_CHARS` | `src/tools/registry.ts` | 3000 | 工具结果默认截断长度 / default tool-result truncation |
| 模型价格表 | `src/usage/tracker.ts` | — | 7 家模型 prompt cache 计费规则 / pricing for 7 model families |

---

## 🛠️ 技术栈 / Tech Stack

- **Bun** — 运行时 / 包管理 / 测试（替代 Node.js + npm + vitest）
- **TypeScript** — 语言 / language（strict 模式）
- **AI SDK v7**（`ai` + `@ai-sdk/openai`）— 模型调用与工具编排
- **MCP Client**（`@modelcontextprotocol/client`）— MCP 工具接入
- **zod** — 工具参数校验 / tool parameter validation
- **turndown** — HTML → Markdown 转换（web_fetch）
- **Biome** — lint / format

---

## 📄 License

Private project — 内部项目。
