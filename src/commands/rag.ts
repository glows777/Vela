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
    const path = cmd.slice('ingest '.length).trim()
    console.log(`\n[导入] 正在处理 ${path}...`)
    const ragIngestTool = ctx.registry
      .getActiveTools()
      .find((t) => t.name === 'rag_ingest')!
    ragIngestTool.execute!({ path }).then((result: any) => {
      console.log(`  ${result}\n`)
      ctx.ask()
    })
    return 'async'
  },
]
