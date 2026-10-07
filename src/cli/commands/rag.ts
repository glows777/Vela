import type { CommandHandler } from './index'

export const ragCommands: CommandHandler[] = [
  (cmd, { internals }) => {
    if (cmd !== '/rag' && cmd !== 'rag') return false
    const vs = internals.vectorStore
    console.log(`\n[知识库] ${vs.size()} 个片段`)
    const sources = vs.sources()
    if (sources.length > 0) console.log(`  来源: ${sources.join(', ')}`)
    console.log('')
    return true
  },

  (cmd, { session, ask }) => {
    if (!cmd.startsWith('ingest ')) return false
    const busy = session.busy
    if (busy.locked) return true
    const path = cmd.slice('ingest '.length).trim()
    console.log(`\n[导入] 正在处理 ${path}...`)
    const ragIngestTool = session.registry
      .getActiveTools()
      .find((t) => t.name === 'rag_ingest')
    if (!ragIngestTool) {
      console.error('[导入] rag_ingest 工具不可用')
      return true
    }
    const controller = new AbortController()
    busy.controller = controller
    busy.locked = true
    void ragIngestTool
      .execute(
        { path },
        {
          results: session.registry.results,
          signal: controller.signal,
          registry: session.registry,
        },
      )
      .then((result) => console.log(`  ${result}\n`))
      .catch((error) =>
        console.error(
          '[导入] 已停止:',
          error instanceof Error ? error.message : error,
        ),
      )
      .finally(() => {
        busy.locked = false
        busy.controller = undefined
        ask()
      })
    return 'async'
  },
]
