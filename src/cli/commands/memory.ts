import type { CommandHandler } from './index'

export const memoryCommands: CommandHandler[] = [
  (cmd, { internals }) => {
    if (cmd !== '/memory' && cmd !== 'memory') return false
    const entries = internals.memoryStore.list()
    const reports = internals.memoryStore.lint()
    console.log(
      `\n[记忆系统] 共 ${entries.length} 条记忆，${reports.length} 条有警告`,
    )
    for (const e of entries) {
      const hasIssue = reports.some((r) => r.entry.filePath === e.filePath)
      const flag = hasIssue ? '⚠️ ' : '   '
      console.log(`${flag} [${e.type}] ${e.name} — ${e.description}`)
    }
    console.log('')
    return true
  },

  (cmd, { internals }) => {
    if (cmd !== '/lint' && cmd !== 'lint') return false
    const reports = internals.memoryStore.lint()
    if (reports.length === 0) {
      console.log('\n[lint] 记忆库健康，没有发现问题。\n')
      return true
    }
    console.log(`\n[lint] 记忆库 ${reports.length} 条有警告：`)
    for (const r of reports) {
      console.log(
        `  📁 ${r.entry.filePath.split('/').pop()}  [${r.entry.type}] ${r.entry.name}`,
      )
      for (const issue of r.issues)
        console.log(`     • ${issue.kind}: ${issue.message}`)
    }
    console.log('')
    return true
  },

  (cmd, { internals }) => {
    if (!cmd.startsWith('/memory search ') && !cmd.startsWith('搜记忆 '))
      return false
    const query = cmd.replace(/^\/memory search |^搜记忆 /, '').trim()
    const results = internals.memoryStore.search(query, 5)
    if (results.length === 0) {
      console.log(`\n[记忆搜索] 没有找到与 "${query}" 相关的记忆。\n`)
      return true
    }
    console.log(`\n[BM25 搜索] "${query}" → ${results.length} 条结果：`)
    for (const h of results) {
      console.log(
        `  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} — ${h.entry.description}`,
      )
    }
    console.log('')
    return true
  },
]
