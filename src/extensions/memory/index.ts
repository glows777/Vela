import type { VelaExtension } from '../../index'
import { MemoryStore } from './store'
import { createMemoryTool } from './tool'

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

/**
 * 跨会话记忆（存在 `<dataDir>/.memory`）：`memory` 工具、system prompt 里的记忆索引，
 * 以及 `/memory [search <关键词> | lint]`、`/dream` 命令。
 * 记忆是主人的私有数据：guest 会话（例如通道里的外部发送者）既不能用工具，也不注入索引。
 */
export function memory(): VelaExtension {
  return function memory(vela) {
    const store = new MemoryStore(vela.dataDir, vela.logger)
    store.init()
    vela.registerTool(createMemoryTool(store))

    vela.on('before_agent_start', (event, ctx) => {
      if (ctx.session.role === 'guest') return
      event.sections.memory = store.buildPromptSection()
    })

    vela.registerCommand('memory', {
      description: '列出记忆；/memory search <关键词> 搜索，/memory lint 检查',
      handler: (args, ctx) => {
        if (args === 'lint') return ctx.ui.notify(lintReport(store))
        if (args.startsWith('search ')) {
          const query = args.slice('search '.length).trim()
          return ctx.ui.notify(searchReport(store, query))
        }
        const entries = store.list()
        const reports = store.lint()
        const lines = [
          `[记忆系统] 共 ${entries.length} 条记忆，${reports.length} 条有警告`,
        ]
        for (const e of entries) {
          const flag = reports.some((r) => r.entry.filePath === e.filePath)
            ? '⚠️ '
            : '   '
          lines.push(`${flag} [${e.type}] ${e.name} — ${e.description}`)
        }
        ctx.ui.notify(lines.join('\n'))
      },
    })

    vela.registerCommand('dream', {
      description: '让模型整理记忆库（合并重复、删除过期）',
      handler: async (_args, ctx) => {
        ctx.ui.notify('[dream] 开始记忆整理...')
        await ctx.session.prompt(DREAM_PROMPT, { signal: ctx.signal })
        ctx.ui.notify('[dream] 完成')
      },
    })
  }
}

function lintReport(store: MemoryStore): string {
  const reports = store.lint()
  if (reports.length === 0) return '[lint] 记忆库健康，没有发现问题。'
  const lines = [`[lint] 记忆库 ${reports.length} 条有警告：`]
  for (const r of reports) {
    lines.push(
      `  📁 ${r.entry.filePath.split('/').pop()}  [${r.entry.type}] ${r.entry.name}`,
    )
    for (const issue of r.issues)
      lines.push(`     • ${issue.kind}: ${issue.message}`)
  }
  return lines.join('\n')
}

function searchReport(store: MemoryStore, query: string): string {
  const results = store.search(query, 5)
  if (results.length === 0)
    return `[记忆搜索] 没有找到与 "${query}" 相关的记忆。`
  return [
    `[BM25 搜索] "${query}" → ${results.length} 条结果：`,
    ...results.map(
      (h) =>
        `  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} — ${h.entry.description}`,
    ),
  ].join('\n')
}
