# Vela 测试参考

这份文档说明 Vela 怎么测试、怎么验收一次改动、怎么新增测试。所有测试和测试辅助都放在 `test/` 下，接手的人（或 agent）从这里开始读。

## 目录

```
test/
  README.md              本文件
  support/vela.ts        createTestVela() 等测试辅助（只给测试用）
  fixtures/scenarios/    CLI 回放用的 faux 场景 JSON
  unit/<镜像 src 路径>/   单元测试，例如 src/agent/retry.ts → test/unit/agent/retry.test.ts
  e2e/                   整体流程：真实装配 + faux 模型
  live/                  真实模型冒烟测试，默认跳过
src/testing/
  faux.ts                脚本化 faux 模型（LanguageModelV4），CLI 的 VELA_MODEL=faux: 也用它
  faux-embedder.ts       确定性的离线 embedder
  demo-model.ts          关键词 demo 模型（VELA_MODEL=mock，只用于手动体验，测试不用）
```

faux 和 demo 模型在 `src/testing/` 而不在 `test/`，因为 CLI 运行时也要加载它们。

## 运行

| 命令 | 内容 | 耗时 |
|---|---|---|
| `bun run test` | unit + e2e，提交前跑这个 | 约 5 秒 |
| `bun run test:unit` | 只跑单元测试 | 约 1.5 秒 |
| `bun run test:e2e` | 只跑整体流程（含 CLI 子进程） | 约 4.5 秒 |
| `bun run test:live` | 真实模型，需要 `OPENAI_API_KEY`、`OPENAI_API_MODEL_NAME` | 取决于模型 |
| `bun test <文件或目录>` | 定向跑一部分 | |
| `bun run typecheck` | `tsc --noEmit`，必须 0 错误 | |
| `bun run lint` | `biome lint`，必须 0 error（warning 不挡；`app/`、`calculator/`、`sample/` 是演示文件，不参与 lint） | |

整套测试不访问网络、不需要任何环境变量。每个用例都在自己的临时目录里跑，互不影响，跑完自动删掉。

CI（`.github/workflows/ci.yml`）在每个 PR 和 main 的 push 上依次跑 `bun run test`、`bun run typecheck`、`bun run lint`，任何一步失败都会挡住 PR。`test/live/` 不在 CI 里跑。

## 分层

- **unit**：测单个模块的规则和边界（重试分类、循环检测、压缩切分、摘要校验、工具历史、安全规则……）。直接 new 出被测对象，模型用 faux。
- **e2e**：用 `createTestVela()` 装配一个和 CLI 完全相同的 Vela（`createVela()` + CLI 的斜杠命令分发器），只把模型换成 faux、目录换成临时目录，断言事件序列、模型收到的请求、落盘的文件。
- **e2e/cli.test.ts**：起真实的 `bun src/index.ts` 子进程，用 `VELA_MODEL=faux:<场景.json>` 回放，断言 stdout/stderr/退出码。
- **live**：真实模型，只验证“接得上”，不做细节断言。

改了什么就跑对应那层；改到 agent loop、装配、事件、上下文管理或 CLI 入口时跑全套 `bun run test`。

## faux 模型

```ts
import { createFauxModel, fauxText, fauxToolCall, fauxError, fauxStreamError, fauxHang, fauxSummary } from '../../src/testing/faux'

const model = createFauxModel({
  responses: [                                        // 主队列：streamText 按顺序消费
    fauxToolCall('read_file', { path: 'a.txt' }),     // 调一个工具
    [fauxToolCall('glob', {...}), fauxToolCall('grep', {...})], // 数组 = 同一次响应里多个工具调用
    (req) => fauxText(`你说：${req.lastUserText}`),    // 按请求动态生成
    fauxError('429 Too Many Requests'),               // 请求直接失败（也可传 Error，例如 provider 的 APICallError）
    fauxStreamError('ECONNRESET', '半截文本'),         // 流到一半出错
    fauxHang('思考中'),                                // 不结束，直到被 abort
    fauxText('x', { usage: { input: 900, output: 10 }, finishReason: 'length' }),
  ],
  generate: [fauxSummary()],  // generateText（上下文摘要）单独的队列；fauxSummary 生成能通过校验的摘要
  chunkSize: 8,               // 文本按 8 个字符一块流出
  cache: true,                // 模拟 prompt cache：system 不变时记 cacheRead
})

model.calls      // 每次请求：{ index, kind, system, prompt, tools, lastUserText, toolResults, responseFormat }
model.pending()  // 还没用掉的响应数
model.push(...)  // 追加响应
```

- 脚本用完还有请求时直接抛错：`faux: no scripted response for request #3 (stream)`，不会挂住。
- usage 默认按字符数估算，结果确定；需要精确数字时用 `usage` 覆盖。
- 响应本身是可 JSON 序列化的 `FauxResponse`（`text`、`reasoning`、`toolCalls`、`finishReason`、`usage`、`error`、`streamError`、`hang`），所以同一套写法可以存成场景文件给 CLI 回放。

## createTestVela()

```ts
import { cleanupTestVelas, createTestVela, captureConsole } from '../support/vela'

afterEach(cleanupTestVelas)   // 每个用到 createTestVela 的文件都要有

const t = createTestVela({
  responses: [...], generate: [...], faux: { cache: true },
  files: { 'src/a.ts': '...' },          // 预置到临时 cwd
  skills: [{ name, description, body }], // 写到 .skills/<name>/SKILL.md
  embedder: true,                        // 用 faux embedder 打开 RAG
  limits: { maxTurns: 3 },               // 覆盖上限；测试默认 retryBaseMs=0
  dataDir: '.vela-data', sessionId: 'a', cwd: existingDir, plugins: new Map(...),
})

await t.run('读一下 a.txt')       // = vela.run()
t.eventTypes()                    // ['turn_start', 'tool_call', ...]
t.eventsOf('tool_call')           // 某类事件，带类型
t.streamedText(); t.lastAssistantText(); t.messages
t.model.calls                     // 模型收到的请求
t.dispatch('/memory')             // 斜杠命令，返回 true/false/'async'
await t.command('/dream')         // 异步命令，等它结束
t.readFile('a.txt'); t.readData('.sessions/default.jsonl'); t.exists('knowledge.db')
await t.cleanup({ keepDir: true }) // 一般交给 cleanupTestVelas()
```

cleanup 时如果 faux 脚本没用完会报错，防止“以为走到了某一步其实没有”。确实不需要用完时传 `allowPendingResponses: true`。

斜杠命令会打印到终端，用 `captureConsole(() => ...)` 收集输出再断言，也让测试输出保持干净。

### 可调的上限（`src/limits.ts`）

`createVela({ limits })` 可以覆盖：`maxTurns`、`maxRetries`、`retryBaseMs`、`retryMaxMs`、`tokenBudget`、`microcompactThreshold`、`summaryThreshold`、`minMicroSavings`、`maxInputTokens`、`bashTimeoutMs`。默认值就是 CLI 一直用的值。测试用它把阈值调小，而不是构造巨大的输入；例如 `test/e2e/context.test.ts` 先量出空会话的请求大小，再把摘要阈值设在它上面一点。

## 当前覆盖的场景

| 文件 | 场景 |
|---|---|
| e2e/basic | 纯文本回复的事件序列与落盘；模型收到的 system/工具/用户消息；多轮对话带历史；工具调用后回答 |
| e2e/tools | 一次多个工具调用；write/edit 写入 cwd 并发 audit 事件；bash 在 cwd 运行并带时间戳 hook；危险 bash 被拒绝；工具报错回给模型；未知工具/参数不合法被拒绝并记录；deferred 工具经 tool_search 后才可用；guest 角色不能用 bash |
| e2e/resilience | 429/503 重试后成功；provider 的 APICallError 按 statusCode 判断是否重试；流中途断开后重试且不留半截回答；400 不重试并报真实原因；重试次数用尽；模型流式中 abort 后可继续；工具执行中 abort 记为 cancelled；并发 run 被拒绝；循环检测 warning（排在触发它的调用之后）→ critical；maxTurns；token 预算告警与停止；超过 maxInputTokens 不发请求 |
| e2e/context | 微压缩折叠旧工具结果；摘要压缩替换旧历史、保留近期消息、写盘并在恢复后生效；摘要不合格时停止且历史不变；`defend` 只做微压缩不付费摘要 |
| e2e/session | `--continue` 式恢复；空目录无会话；不同 sessionId 分开存；dataDir 与 cwd 分离；usage 日志；prompt cache 模拟 |
| e2e/memory | 通过工具保存记忆后下一轮 prompt 可见、重启后仍在；搜索记忆；缺字段时保存失败；read/delete 需要 filename |
| e2e/rag | 没有 embedder 时不注册 RAG 工具；相对 cwd 导入文档后搜索（离线）；空库提示；知识库跨重启保留 |
| e2e/commands | `/context` `/usage` `status`；`/plugin load/unload` 后模型立即能用插件工具；通道消息走同一模型和工具并回发 |
| e2e/cli | `-p` 单次模式回放场景；工具在进程 cwd 执行；`--continue`；模型错误退出码 1；缺参数退出码 2；`VELA_MODEL=mock`；交互模式输入一轮 + 斜杠命令 + exit；管道输入逐行执行并在 EOF 退出 |
| unit/commands | skill 激活/去重/并发锁、dream、memory、rag 命令（走真实装配） |
| unit/… | 其余模块级规则，见各文件 |

## 验收一次改动

1. 先写或改测试，让它表达期望的行为（修 bug 时先让它失败）。
2. 定向跑相关文件：`bun test test/unit/<模块> test/e2e/<场景>`。
3. 改到跨模块的东西（agent loop、`createVela`、事件、上下文、CLI）时跑 `bun run test`。
4. `bun run typecheck` 和 `bun run lint` 都要通过（CI 也会跑）。
5. 涉及真实模型行为（provider、usage 字段、工具调用格式）时，有条件就跑一次 `bun run test:live`。
6. 改了事件、faux 接口或测试约定时，同步更新本文件。

## 怎么新增测试

- **新模块或新规则** → `test/unit/<与 src 相同的路径>.test.ts`。
- **新功能的整体行为** → 在 `test/e2e/` 里找对应主题的文件加用例；主题不存在时新建一个文件，并把它加进上面的覆盖表。
- **线上遇到的问题**：把模型当时的输出写成 faux 脚本复现。只需要 CLI 复现时，写一个 `test/fixtures/scenarios/<名字>.json`，用 `VELA_MODEL=faux:test/fixtures/scenarios/<名字>.json bun run src/index.ts -p "..."` 手动跑，再在 `e2e/cli.test.ts` 里加用例。
- **新事件类型**：在 e2e 里断言它出现在正确的位置（`t.eventTypes()`）。
- **需要等异步命令**：用 `t.command()`，不要写 `while (...) await Bun.sleep()` 轮询；必须轮询时以 1ms 为间隔并有明确的退出条件。

约定：

- 不访问网络，不依赖环境变量；需要 embedding 用 `embedder: true`。
- 不用 `process.chdir`，路径都相对 `t.cwd`。
- 断言事件和数据，而不是终端输出；只有测试命令本身的输出时才用 `captureConsole`。
- 不写固定的 sleep 等待；需要“进行中”状态时用 `fauxHang()` 或在工具里用 Promise 控制时机。
- 一个用例只验证一件事，名字写清楚期望的行为。

## 已知问题

暂无。发现问题时先写一个能复现的 faux 场景，修不了的写在这里，并在测试里按现状断言。
