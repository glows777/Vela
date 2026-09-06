import type { CommandHandler } from './index'

export const ragCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== '/rag' && cmd !== 'rag') return false
    const vs = ctx.vectorStore
    console.log(`\n[知识库] ${vs.size()} 个片段`)
    const sources = vs.sources()
    if (sources.length > 0) console.log(`  来源: ${sources.join(', ')}`)
    console.log('')
    return true
  },

  (cmd, ctx) => {
    if (!cmd.startsWith('ingest ')) return false
    if (ctx.busy.locked) return true
    const path = cmd.slice('ingest '.length).trim()
    console.log(`\n[导入] 正在处理 ${path}...`)
    const ragIngestTool = ctx.registry
      .getActiveTools()
      .find((t) => t.name === 'rag_ingest')
    if (!ragIngestTool) {
      console.error('[导入] rag_ingest 工具不可用')
      return true
    }
    const controller = new AbortController()
    ctx.busy.controller = controller
    ctx.busy.locked = true
    void ragIngestTool
      .execute(
        { path },
        { results: ctx.registry.results, signal: controller.signal },
      )
      .then((result) => console.log(`  ${result}\n`))
      .catch((error) =>
        console.error(
          '[导入] 已停止:',
          error instanceof Error ? error.message : error,
        ),
      )
      .finally(() => {
        ctx.busy.locked = false
        ctx.busy.controller = undefined
        ctx.ask()
      })
    return 'async'
  },
]
