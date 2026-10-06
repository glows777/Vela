# Vela 重构交接文档（HANDOFF）

每个线程开工前先读这份文档；结束时更新自己那一节和“下一步”。
仓库：`glows777/Vela`（未开源，Liam 想打磨后再开源）。参考设计：pi-mono（badlogic/pi-mono）。

## 组织方式（Liam，2026-10-06）

- 一个线程只做一个任务，按顺序推进；线程之间靠这份文档同步上下文。
- 每一项先在线程里讨论、Liam 同意后再写代码。

## 约定的顺序

| 步骤 | 内容 | 详细讨论稿 | 状态 |
|---|---|---|---|
| 0 | 最小接缝：`createVela()` 装配、路径从 dataDir 派生、工具 cwd、embedder 可选、agentLoop 发事件 | [00-seams.md](00-seams.md) | ✅ 已完成，草稿 PR #1 |
| 3 | 脚本化 faux 模型 + `createTestVela()` + e2e/单测分层（Liam：最重要，后面都围绕它设计） | [03-mock-model-testing.md](03-mock-model-testing.md) | 下一步 |
| 1 | 完整拆成 SDK（session API、事件流、core/cli 分层） | [01-sdk-split.md](01-sdk-split.md) | 待讨论 |
| 4 | 统一数据目录 + 配置文件入口 | 待写 | 待讨论 |
| 2 | CLI/TUI 友好输出（消费事件流） | 待写 | 待讨论 |

## 已定的决定

- 顺序如上：先接缝，再 mock 测试，再 SDK，再配置/数据目录，最后 TUI。
- 第 0 步的三个问题（Liam 同意推荐项）：
  1. 文件/搜索/bash 工具相对 `cwd` 参数解析，不用 `process.chdir`。
  2. `dataDir` 默认等于 cwd，这一步数据位置不变（最终位置留给第 4 项）。
  3. `createVela` 的 `model` 必填，读环境变量留在 CLI。
- 讨论稿里提出、尚未拍板（留给对应步骤）：
  - 第 3 项：faux 做在 AI SDK `LanguageModelV4` 层；保留关键词 demo 模型作为 `--model mock`。
  - 第 1 项：先单包 + `exports`，不拆 monorepo；斜杠命令留在 CLI，SDK 只提供数据。
  - 第 4 项：数据放项目内 `.vela/` 还是全局 `~/.vela/projects/<名>/`（线程里有一张选项卡，推荐项目内 `.vela/`，未回复）。

## 第 0 步做了什么

- 分支 `claude/vela-sdk-refactor-d1brzx`，草稿 PR https://github.com/glows777/Vela/pull/1
- `src/app.ts`：`createVela({ model, cwd?, dataDir?, sessionId?, embedder?, onEvent? })`，返回 `registry / builder / tracker / contextManager / memoryStore / vectorStore / skillLoader / gateway / pluginManager / busy …`，以及 `run(input, { signal })`、`resume()`、`abort()`、`commandContext(ask)`、`setEventListener()`、`dispose()`。
- `src/agent/events.ts`：`VelaEvent`（turn_start、text_delta、tool_call、tool_result、tool_error、loop_detected、retry、usage、budget_warning、turn_end、agent_end{reason}、context、session_save_failed）。
- `agentLoop` 新增 `onEvent`，自身不再打印；`ContextManager` 第 4 个构造参数是事件回调；`CommandContext.onEvent` 传给 skill/dream 里的 agentLoop；`ChannelGateway` 新增 `createTracker` / `onEvent`。
- `src/cli/print-event.ts`：按旧格式打印事件，终端效果不变。
- `src/index.ts`：只剩 CLI（读 env 建模型/embedder、readline、命令分发、插件加载、MCP 代码原样保留但仍未启用）。`VELA_MODEL=mock` 用 `src/mock.ts`；`VELA_DEBUG=1` 才打印每轮 system prompt。
- `createCoreTools({ cwd })`（`src/tools/index.ts`），旧的 `readFileTool` 等常量保留。
- `LoopDetector` 类：每次 agentLoop 独立实例（旧的模块级函数保留作兼容）。
- `src/testing/harness.ts` 改为基于 `createVela()`；新增 `test/e2e/smoke.test.ts`（用 `MockLanguageModelV4` 手写脚本，第 3 项会换成 faux）。
- `.env.example` 修正 `EMBEDING_*` → `EMBEDDING_*`。
- 验证：`bun test` 128 pass / 0 fail；`tsc` 无新增错误（main 上原有 10 个）。

## 留给第 1 项（第 0 步评审时发现，Liam 2026-10-06 定为第 1 步处理）

- 事件协议不对称：token 超预算退出时 agentLoop 不发 `turn_end`，直接发 `agent_end{reason:'budget'}`（`src/agent/index.ts` 里预算判断在 `turn_end` 之前）。第 1 项定事件协议时统一：每轮都有 `turn_end`，或者在文档里写明哪些结束原因没有。
- `src/app.ts` 的 audit hook（`write_file` / `edit_file` 时 `console.log('[audit] ...')`）还在核心里直接打印，第 1 项改成发事件，由 CLI 打印。

## 留给下一步（第 3 项）的事项

- 新线程需要基于第 0 步的分支（或等 PR #1 合并后基于 main）开新分支。
- 把 `test/e2e/smoke.test.ts` 里的 `scriptedModel()` 升级为 `src/testing/faux.ts`；把各测试里手写的 `MockLanguageModelV4` 样板逐步迁移。
- `src/mock.ts` 仍有模块级状态（`retryTestCount`、`lastPrefixHash`、`cacheEnabled`），`/cache on|off` 命令依赖它。
- 仍直接 `console.log` 的核心模块：`app.ts` 里的 audit hook、`plugins/manager.ts`、`channels/gateway.ts`、`tools/registry.ts`、`prompt/pipelins.ts`、各斜杠命令（留给第 1 项）。
- RAG 需要确定性的 faux embedder 才能离线跑 e2e。
- 管道输入时 CLI 会在 `ask()` 注册前读到 EOF 直接退出（原有行为）；第 3 项的 CLI e2e 用 `-p` 模式时要处理。
