# Vela 测试参考

这份文档说明 Vela 怎么测试、怎么验收一次改动、怎么新增测试。所有测试和测试辅助都放在 `test/` 下，接手的人（或 agent）从这里开始读。

## 目录

```
test/
  README.md              本文件
  support/vela.ts        vela/testing 的 createTestVela() 加上 CLI 斜杠命令分发器、captureConsole（只给测试用）
  fixtures/scenarios/    CLI 回放用的 faux 场景 JSON
  unit/<镜像 src 路径>/   单元测试，例如 src/agent/retry.ts → test/unit/agent/retry.test.ts
  e2e/                   整体流程：真实装配 + faux 模型
  live/                  真实模型冒烟测试，默认跳过
src/testing/             公开为 `vela/testing`（package.json exports）
  index.ts               对外导出
  faux.ts                脚本化 faux 模型（LanguageModelV4），CLI 的 VELA_MODEL=faux: 也用它
  faux-embedder.ts       确定性的离线 embedder
  test-vela.ts           createTestVela()：临时目录 + faux 模型装配一个真实 Vela
  record.ts              recordModel()：把真实模型的响应录成 faux 场景（CLI 的 VELA_RECORD）
  replay.ts              replayScenario()：按录下的输入把场景重跑一遍
  demo-model.ts          关键词 demo 模型（VELA_MODEL=mock，只用于手动体验，测试不用）
```

faux、demo 模型和 createTestVela 在 `src/testing/` 而不在 `test/`：CLI 运行时要加载 faux，扩展作者也要能 `import { createTestVela } from 'vela/testing'` 离线测自己的扩展。测试里可以用相对路径 import，也可以按包名 import（`test/e2e/sdk.test.ts`）。

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
- **e2e/cli.test.ts**：起真实的 `bun src/cli/main.ts` 子进程，用 `VELA_MODEL=faux:<场景.json>` 回放，断言 stdout/stderr/退出码。
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
  embedder: true,                        // 加载 rag 扩展，用 faux embedder（memory 扩展总是加载，同 CLI）
  limits: { maxRetries: 1 },             // 覆盖上限；测试默认 retryBaseMs=0
  dataDir: 'data', sessionId: 'a', cwd: existingDir,   // dataDir 默认 '.vela-data'（相对 cwd，持久化）
  extensionConfig: { web: { tavilyKey: 'x' } },        // 扩展的配置段（vela.config）
  logger,                                // 注入 logger
  extensions: [myExtension],             // 被测的扩展
  session: { role: 'guest', ui, permissions: { bash: 'ask' }, tools: [...] }, // 默认会话的选项
})

t.vela                            // createVela() 的返回值（公开 API）
t.internals                       // 内部对象：registry、hooks、builder、gateway…（只有 test/support 版本有）
t.session                         // 默认会话（id 为 sessionId，默认 'default'）
await t.run('读一下 a.txt')       // = t.session.prompt()
t.vela.session('other')           // 同一个 Vela 再开一个会话
t.eventTypes()                    // 所有会话的事件：['agent_start', 'message', 'turn_start', ...]
t.eventsOf('tool_call')           // 某类事件，带类型
t.eventsIn('other')               // 某个会话的事件
t.streamedText(); t.lastAssistantText(); t.messages
t.model.calls                     // 模型收到的请求
t.dispatch('/context')            // CLI 自己的斜杠命令，返回 true/false/'async'
await t.command('/skill x')       // 异步命令，等它结束
await t.run('/memory')            // 扩展命令走 session.prompt()；输出是 notify 事件：t.eventsOf('notify')
t.readFile('a.txt'); t.readData('sessions/default.jsonl'); t.exists('rag/knowledge.db')  // 数据目录里：sessions/ usage/ memory/ rag/
await t.cleanup({ keepDir: true }) // 一般交给 cleanupTestVelas()
```

CLI 斜杠命令（`t.dispatch` / `t.command`）作用在 `t.session` 上；它们来自 `test/support/vela.ts`，`vela/testing` 里的版本没有命令分发器。扩展注册的命令（`/memory`、`/dream`、`/rag`…）不经过分发器，用 `t.run('/name args')`。

cleanup 时如果 faux 脚本没用完会报错，防止“以为走到了某一步其实没有”。确实不需要用完时传 `allowPendingResponses: true`。

斜杠命令会打印到终端，用 `captureConsole(() => ...)` 收集输出再断言，也让测试输出保持干净。

### 事件

`session.subscribe(listener)` 只收这个会话的事件，`vela.subscribe((event, sessionId) => …)` 收所有会话的。一次 `prompt()` 的顺序是：`agent_start{input}` → `message`（用户输入）→ 每轮 `turn_start` …（`thinking_delta`、`text_delta`、`tool_call`、`tool_result` / `tool_error`、`retry`、`usage`）… `message`（这一轮新增的 assistant / tool 消息，以及循环检测提醒）→ `turn_end` →（运行中 steer 的消息：`message`，再下一轮；模型本来要结束时取 followUp，同样 `message` 后在同一个 loop 里接着跑，同 pi）→ `agent_end{reason}` →（loop 出错 / 中断后还排着的消息开新 loop）→ 最后 `agent_settled`。队列变化发 `queue_update{steering, followUp}`。另有 `context`（压缩）、`audit`、`security_warning`、`session_save_failed`、`notify`（没有界面时扩展的 `ui.notify`），通道会话还有 `channel_message` / `channel_reply` / `channel_error`。

core 不写终端（`test/unit/boundary.test.ts` 守着这条边界）：非事件的诊断输出走 `createVela({ logger })`，默认静默。

### 录制和回放

```ts
import { recordModel, replayScenario } from 'vela/testing'

const recorder = recordModel(realModel, { path: 'run.json' })   // CLI：VELA_RECORD=run.json
vela.subscribe((e) => e.type === 'agent_start' && recorder.addInput(e.input))
// …正常使用 recorder.model…
await recorder.flush()

const { t, errors } = await replayScenario('run.json', { files })  // 离线按 inputs 重跑
```

录下的场景就是普通 faux 场景（多了 `inputs`），请求失败记成 `error`、流中途断开记成 `streamError`、被中断记成 `hang`，`generateText`（摘要）进 `generate` 队列。CLI 也能直接回放：`VELA_MODEL=faux:run.json bun src/cli/main.ts -p "<第一条输入>"`。文件含对话原文，挑出来做测试的放进 `test/fixtures/scenarios/` 前先删掉敏感内容。

### 可调的上限（`src/limits.ts`）

`createVela({ limits })` 可以覆盖：`maxRetries`、`retryBaseMs`、`retryMaxMs`、`tokenBudget`、`microcompactThreshold`、`summaryThreshold`、`minMicroSavings`、`maxInputTokens`、`bashTimeoutMs`。默认值就是 CLI 一直用的值；不认识的键（比如已去掉的 `maxTurns`）直接报错。测试用它把阈值调小，而不是构造巨大的输入；例如 `test/e2e/context.test.ts` 先量出空会话的请求大小，再把摘要阈值设在它上面一点。

## 当前覆盖的场景

| 文件 | 场景 |
|---|---|
| e2e/basic | 纯文本回复的事件序列与落盘；模型收到的 system/工具/用户消息；多轮对话带历史；工具调用后回答 |
| e2e/tools | 一次多个工具调用；write/edit 写入 cwd 并发 audit 事件；bash 在 cwd 运行并带时间戳 hook；危险 bash 被拒绝；工具报错回给模型；未知工具/参数不合法被拒绝并记录；deferred 工具经 tool_search 后才可用；guest 角色不能用 bash |
| e2e/resilience | 429/503 重试后成功；provider 的 APICallError 按 statusCode 判断是否重试；流中途断开后重试且不留半截回答；400 不重试并报真实原因；重试次数用尽；模型流式中 abort 后可继续；工具执行中 abort 记为 cancelled；并发 run 被拒绝；循环检测 warning（排在触发它的调用之后）→ critical；不限轮数（同 pi）；token 预算告警与停止；超过 maxInputTokens 不发请求 |
| e2e/context | `session.compact(focus)` 手动摘要、运行中拒绝；微压缩折叠旧工具结果；摘要压缩替换旧历史、保留近期消息、写盘并在恢复后生效；摘要不合格时停止且历史不变；`defend` 只做微压缩不付费摘要 |
| e2e/session | `--continue` 式恢复；空目录无会话；不同 sessionId 分开存；dataDir 与 cwd 分离；usage 日志；prompt cache 模拟 |
| e2e/memory | memory 扩展：通过工具保存记忆后下一轮 prompt 可见、重启后仍在；搜索记忆；缺字段时保存失败；read/delete 需要 filename；`/memory`（search / lint）、`/dream`；guest 不能执行命令 |
| e2e/rag | rag 扩展：没有 embedder 时不注册 RAG 工具；相对 cwd 导入文档后搜索（离线）；空库提示；知识库跨重启保留；`/rag`、`/rag ingest` 及中断 |
| e2e/commands | `/context` `/usage` `status`；supabase 扩展的工具模型能直接用、`/extensions` 列出；通道消息走同一模型和工具并回发 |
| e2e/extensions | `examples/extensions/` 里每个示例（工具、命令 + notify、registerProvider、before_agent_start 段落、tool_call + confirm、tool_result 打码、setActiveTools、通道 + roleFor）；guest 看不到记忆；tool_call 原地改参数并重新校验；handler 抛错即拦截；会话权限 ask；异步工厂和 session_start / shutdown；工厂失败；重复注册 |
| e2e/models | 按名字选模型（provider、元数据、models.json 价格）；`setModel` 从下一轮起换模型并重算上限；会话各自选模型；thinking 级别映射到 `reasoning`（默认 medium、max→xhigh；`reasoning: false` 的模型 off 不发、其它级别 prompt 报错且不发请求）；Vela 级默认 thinking；恢复会话带回模型和 thinking、保存的模型不可用时告警并保留当前；对象模型不落盘；没有默认模型时要先 setModel；`/model` `/thinking` |
| e2e/queue | steer 在这一步之后、下一次请求前插入；最后一步收到的 steer 让 loop 继续；followUp 等模型要结束时在同一个 loop 里接着跑；one-at-a-time / all；运行中 prompt 要 streamingBehavior；clearQueue + `await abort()`；abort 后队列保留；任务失败后排队消息仍跑、prompt 再 reject；空闲时 steer / followUp 等于 prompt；thinking_delta；扩展命令里 abort 不卡住；compact 占着会话时不能排队 |
| e2e/rpc | `--mode rpc` 子进程：prompt 的 disposition、事件带 sessionId、get_state / get_messages / set_session_name / list_sessions、解析失败和未知命令、new_session / switch_session；运行中 prompt 要 streamingBehavior、steer / follow_up 排队、clear_queue、abort 在停下后才回复；loop 开始前就失败的 prompt（没有模型）再回一条 success:false；扩展界面 confirm / select / notify / setStatus 走 extension_ui_request / response |
| e2e/sessions | 两个会话同时跑（历史、文件、锁、用量互不影响）；会话 id 校验；subscribe 范围；tool_search 发现的工具只对本会话生效；skill 激活属于会话；close / dispose 中断并保存；`vela.listSessions()`（最近的在前，名字随会话保存和恢复） |
| e2e/channels | 每个发送者一个持久化会话；重启后接着聊；同一发送者的消息串行处理；停止网关时中断并报告 |
| e2e/sdk | 按包名 import `vela` / `vela/testing`；core 不写终端，诊断进注入的 logger；不给 dataDir 时会话在内存、临时目录 dispose 时删掉；自定义 SessionStorage |
| e2e/cli | `-p` 只把最后的回答写 stdout（诊断在 stderr）并保存一个新会话；工具在进程 cwd 执行；管道 stdin 拼在 prompt 前；`--mode json` 会话头 + 每个事件一行、模型错误在 agent_end 里且退出码 1；每次启动新会话、`-c` 接最近的；`--session <id>`、`-r` 只能交互；`VELA_RECORD` 录制后用 `faux:` 回放；模型错误退出码 1；扩展注册的 provider 配 `--model` / `--thinking`，`--continue` 恢复保存的模型；未知 provider / 没选模型 / 缺 key 退出码 1，`--thinking` 不合法退出码 2；缺参数退出码 2；`VELA_MODEL=mock`；`~/.vela/extensions` 发现 + settings 的 `extensionConfig`（`$VAR`）；项目扩展要信任（`-p` 跳过、`--approve`、已保存的决定）；`-e` / `--no-extensions`；`--no-session`；settings.json 坏了退出码 2。CLI 子进程的 HOME / VELA_DIR 都是临时目录，不碰真实的 `~/.vela` |
| unit/cli/commands | skill 激活/去重/并发锁（走真实装配） |
| unit/cli/setup | 命令行参数；settings 的扩展配置覆盖环境变量；旧数据搬家提示 |
| unit/models | `provider/id` 解析与错误；thinking → reasoning；按上下文窗口算上限 |
| unit/config | models.json（内置 openai / anthropic、合并、`$VAR`、缺 key、错误带文件名）；settings 的 defaultModel / defaultThinkingLevel 校验；settings 合并（项目覆盖用户、资源列表合并、路径相对所在文件）；不信任时只读用户级；扩展目录发现；±builtin；错误带文件名；`$VAR` 插值；数据目录编码；skill 目录顺序；trust.json；在家目录里运行 |
| unit/session/storage | 内存存储按 id 保存并返回副本；文件存储读写、兼容旧的一行一条消息；两种存储的 list()（最近的在前、跳过没有消息的、名字、第一条消息） |
| unit/testing/record | 录制再回放得到相同事件；错误、流中断、重试、中断（hang）、generate 队列的录制 |
| unit/boundary | core 模块不出现 console、process.stdout/stderr/exit/env、readline |
| unit/public-api | `vela`、`vela/testing` 的公开 API 和 `api/public-api.txt` 一致；改了公开面运行 `bun run api:update` |
| unit/security | 角色（owner / collaborator / guest）、会话权限规则、ask 走 confirm、hooks 链、bash 分类、`/role` 只改当前会话 |
| unit/… | 其余模块级规则，见各文件 |

## 验收一次改动

1. 先写或改测试，让它表达期望的行为（修 bug 时先让它失败）。
2. 定向跑相关文件：`bun test test/unit/<模块> test/e2e/<场景>`。
3. 改到跨模块的东西（agent loop、`createVela`、事件、上下文、CLI）时跑 `bun run test`。
4. `bun run typecheck` 和 `bun run lint` 都要通过（CI 也会跑）。
5. 涉及真实模型行为（provider、usage 字段、工具调用格式）时，有条件就跑一次 `bun run test:live`。
6. 改了事件、faux 接口或测试约定时，同步更新本文件；改了公开 API 时运行 `bun run api:update` 并提交 `api/public-api.txt`。

## 怎么新增测试

- **新模块或新规则** → `test/unit/<与 src 相同的路径>.test.ts`。
- **新功能的整体行为** → 在 `test/e2e/` 里找对应主题的文件加用例；主题不存在时新建一个文件，并把它加进上面的覆盖表。
- **线上遇到的问题**：用 `VELA_RECORD=<file>` 把那次运行录下来，`replayScenario(file)` 重跑并断言；或者手写 faux 脚本复现。只需要 CLI 复现时，写一个 `test/fixtures/scenarios/<名字>.json`，用 `VELA_MODEL=faux:test/fixtures/scenarios/<名字>.json bun run src/cli/main.ts -p "..."` 手动跑，再在 `e2e/cli.test.ts` 里加用例。
- **新事件类型**：在 e2e 里断言它出现在正确的位置（`t.eventTypes()`）。
- **需要等异步命令**：用 `t.command()`，不要写 `while (...) await Bun.sleep()` 轮询；必须轮询时以 1ms 为间隔并有明确的退出条件。

约定：

- 不访问网络，不依赖环境变量；需要 embedding 用 `embedder: true`。
- 不用 `process.chdir`，路径都相对 `t.cwd`。
- 断言事件和数据，而不是终端输出；只有测试命令本身的输出时才用 `captureConsole`。
- 不写固定的 sleep 等待；需要“进行中”状态时用 `fauxHang()` 或在工具里用 Promise 控制时机。
- 一个用例只验证一件事，名字写清楚期望的行为。

## 已知问题

- 交互模式（`src/cli/interactive.ts` 的 readline REPL）没有自动化测试：管道输入现在走单次模式（同 pi），REPL 只在终端里出现。第 2 步下半换成 TUI 时用假终端在进程内测。发现问题时先写一个能复现的 faux 场景，修不了的写在这里，并在测试里按现状断言。
