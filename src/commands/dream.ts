import type { ModelMessage } from 'ai'
import { agentLoop } from '../agent'
import type { CommandHandler } from './index.js'

const DREAM_PROMPT = [
  '请对记忆库做一次完整的整理（dream），按以下四个阶段执行：',
  '',
  '**阶段 1：定位** — 用 memory lint 扫描全库（lint 结果已包含内容预览和问题清单，不需要再逐条 read）。',
  '**阶段 2：整理** — 根据 lint 报告直接操作：',
  '  - 路径过期且长期未用的，直接 memory delete（传 filename）删掉',
  '  - 同名重复的，用 memory save 保存合并后的版本（同名自动覆盖），再 delete 多余的',
  '  - 内容仍然有效但描述不准确的，用 memory save 覆盖更新',
  '**阶段 3：报告** — 用一段文字总结这次整理做了什么。',
  '',
  '注意：memory 的 read 和 delete 都需要传 filename 参数（如 project_deploy-process.md），不是 name。lint 报告里已经有 filename 了，直接用。',
].join('\n')

export const dreamCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== '/dream' && cmd !== 'dream') return false
    if (ctx.busy.locked) {
      console.log('\n[dream] 有任务正在执行中，请稍候再试\n')
      return true
    }
    console.log('\n[dream] 开始记忆整理...')

    const userMsg: ModelMessage = { role: 'user', content: DREAM_PROMPT }
    ctx.messages.push(userMsg)
    ctx.tracker.addMessage(userMsg)
    ctx.timestamps.set(userMsg, Date.now())

    ctx.busy.locked = true
    ctx.busy.controller = new AbortController()
    void agentLoop({
      model: ctx.model,
      systemPrompt: () => ctx.builder.build(ctx.makePromptCtx()),
      toolRegistry: ctx.registry,
      messages: ctx.messages,
      tokenTracker: ctx.tracker,
      prepareContext: ctx.prepareContext,
      abortSignal: ctx.busy.controller.signal,
      onEvent: ctx.onEvent,
    })
      .then(async () => {
        await ctx.saveSession()
        console.log(`  [dream 完成]\n`)
        ctx.busy.locked = false
        ctx.busy.controller = undefined
        ctx.ask()
      })
      .catch(async (error: unknown) => {
        try {
          await ctx.saveSession()
        } catch (saveError) {
          console.error('[Session] 保存失败:', saveError)
        }
        console.error(
          `  [dream 失败] ${error instanceof Error ? error.message : error}`,
        )
        ctx.busy.locked = false
        ctx.busy.controller = undefined
        ctx.ask()
      })

    return 'async'
  },
]
