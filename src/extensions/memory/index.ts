import { join } from 'node:path'
import type { VelaExtension } from '../../index.ts'
import { MemoryStore } from './store.ts'
import { createMemoryTool } from './tool.ts'

const DREAM_PROMPT = [
  'Do a full cleanup of the memory store (dream), in the following phases:',
  '',
  '**Phase 1: Locate** — Scan the whole store with memory lint (the lint output already includes content previews and the list of issues; no need to read entries one by one).',
  '**Phase 2: Clean up** — Act directly on the lint report:',
  '  - Stale paths that have gone unused for a long time: delete them with memory delete (pass filename)',
  '  - Duplicates with the same name: save the merged version with memory save (same name overwrites automatically), then delete the extras',
  '  - Content still valid but description inaccurate: overwrite it with memory save',
  '**Phase 3: Report** — Summarize what this cleanup did in one paragraph.',
  '',
  'Note: memory read and delete both take the filename parameter (e.g. project_deploy-process.md), not name. The lint report already lists the filename; use it as is.',
].join('\n')

/**
 * Cross-session memory (stored in `<dataDir>/memory`): the `memory` tool, the memory index in the
 * system prompt, and the `/memory [search <keywords> | lint]` and `/dream` commands.
 * Memory is the owner's private data: guest sessions (e.g. outside senders on a channel) get neither
 * the tool nor the index.
 */
export function memory(): VelaExtension {
  return function memory(vela) {
    const store = new MemoryStore(
      join(vela.dataDir, 'memory'),
      vela.logger,
      vela.cwd,
    )
    store.init()
    vela.registerTool(createMemoryTool(store))

    vela.on('before_agent_start', (event, ctx) => {
      if (ctx.session.role === 'guest') return
      event.sections.memory = store.buildPromptSection()
    })

    vela.registerCommand('memory', {
      description:
        'List memories; /memory search <keywords> to search, /memory lint to check',
      handler: (args, ctx) => {
        if (args === 'lint') return ctx.ui.notify(lintReport(store))
        if (args.startsWith('search ')) {
          const query = args.slice('search '.length).trim()
          return ctx.ui.notify(searchReport(store, query))
        }
        const entries = store.list()
        const reports = store.lint()
        const lines = [
          `[memory] ${entries.length} memories, ${reports.length} with warnings`,
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
      description:
        'Have the model clean up the memory store (merge duplicates, delete stale entries)',
      handler: async (_args, ctx) => {
        ctx.ui.notify('[dream] Starting memory cleanup...')
        await ctx.session.prompt(DREAM_PROMPT, { signal: ctx.signal })
        ctx.ui.notify('[dream] Done')
      },
    })
  }
}

function lintReport(store: MemoryStore): string {
  const reports = store.lint()
  if (reports.length === 0)
    return '[lint] Memory store is healthy; no issues found.'
  const lines = [`[lint] ${reports.length} memories with warnings:`]
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
    return `[memory search] No memories found for "${query}".`
  return [
    `[BM25 search] "${query}" → ${results.length} results:`,
    ...results.map(
      (h) =>
        `  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} — ${h.entry.description}`,
    ),
  ].join('\n')
}
