import { basename, join, resolve } from 'node:path'
import { MemoryRegistry } from '../../../runtime/memory/registry.ts'
import {
  MEMORY_RULES,
  type MemoryStore,
} from '../../../runtime/memory/store.ts'
import type { VelaExtension, VelaSession } from '../../extension-api.ts'
import {
  customMessageIfChanged,
  lastCustomMessage,
} from '../../extension-api.ts'
import { resolveMemoryDatabase } from '../../memory/db-registry.ts'
import { MemoryDream } from '../../memory/dream.ts'
import { sharedScopeDataDir } from '../../memory/legacy-scope.ts'
import { createMemoryTool } from './tool.ts'

const EMPTY_MEMORY =
  '[memory] No memories stored yet. Use the memory tool to save important information.'

/**
 * Cross-session memory: local/direct sessions use `<dataDir>/memory`; groups use their own store
 * plus shared global read/search. The same scope applies to the prompt and /memory /dream.
 * Sessions without the memory tool get no index or memory commands.
 */
export function memory(): VelaExtension {
  const extension: VelaExtension = (vela) => {
    const registry = new MemoryRegistry(vela.logger)
    const store = registry.get(join(vela.dataDir, 'memory'), vela.cwd)
    const db = resolveMemoryDatabase(vela.dataDir)
    const forSession = (
      target?: Parameters<typeof sharedScopeDataDir>[0],
    ): MemoryStore => {
      const dir = sharedScopeDataDir(target)
      if (!dir) return store
      return registry.get(join(dir, 'memory'), join(dir, 'workspace'))
    }
    const dreams = new Map<MemoryStore, MemoryDream>()
    const dreamFor = (local: MemoryStore): MemoryDream => {
      let dream = dreams.get(local)
      if (!dream) {
        dream = new MemoryDream(local, db, {
          kind: 'tagged',
          key: `dir:${resolve(local.memoryDir)}`,
        })
        dreams.set(local, dream)
      }
      return dream
    }
    vela.on('agent_end', (event, ctx) => {
      if (!ctx.session.getActiveTools().includes('memory')) return
      dreamFor(forSession(ctx.session)).collect(ctx.session, event.messages)
    })
    vela.on('agent_settled', (_event, ctx) => {
      if (
        vela.config.dream === false ||
        !ctx.session.getActiveTools().includes('memory')
      )
        return
      dreamFor(forSession(ctx.session)).schedule(ctx.session, vela.logger)
    })
    vela.onShutdown(async () => {
      await Promise.all([...dreams.values()].map((dream) => dream.stop()))
    })
    vela.registerTool(createMemoryTool(store, (context) => forSession(context)))

    const contentFor = (session: VelaSession): string | null => {
      const local = forSession(session)
      const index =
        local === store
          ? local.buildIndex()
          : [
              promptLayer('Group memory', local),
              promptLayer(
                'Global notes (read/search with scope: global; group writes stay in group memory)',
                store,
              ),
            ]
              .filter(Boolean)
              .join('\n\n')
      // Deleting the last entry must replace the old index; a session that never had one stays quiet
      return (
        index || (lastCustomMessage(session, 'memory') ? EMPTY_MEMORY : null)
      )
    }

    vela.on('before_agent_start', (event, ctx) => {
      if (!ctx.session.getActiveTools().includes('memory')) return
      event.sections.memory = MEMORY_RULES
      const content = contentFor(ctx.session)
      const message = content
        ? customMessageIfChanged(ctx.session, 'memory', content)
        : undefined
      return message ? { message } : undefined
    })

    vela.registerCommand('memory', {
      description:
        'List memories; /memory search <keywords> to search, /memory lint to check',
      handler: (args, ctx) => {
        if (!ctx.session.getActiveTools().includes('memory'))
          return ctx.notify('Memory is not enabled for this session.')
        const local = forSession(ctx.session)
        if (args === 'lint') return ctx.notify(lintReport(local))
        if (args.startsWith('search ')) {
          const query = args.slice('search '.length).trim()
          return ctx.notify(searchReport(local, query))
        }
        const entries = local.list()
        const reports = local.lint()
        const lines = [
          `[memory] ${entries.length} memories, ${reports.length} with warnings`,
          dreamFor(local).status(),
          ...local.indexWarnings(),
        ]
        for (const e of entries) {
          const flag = reports.some((r) => r.entry.filePath === e.filePath)
            ? '⚠️ '
            : '   '
          lines.push(
            `${flag} [${e.type}] ${e.name} (${basename(e.filePath)}) — ${e.description}`,
          )
        }
        ctx.notify(lines.join('\n'))
      },
    })

    vela.registerCommand('dream', {
      description:
        'Consolidate memory against recent conversations in an isolated model call',
      handler: async (_args, ctx) => {
        if (!ctx.session.getActiveTools().includes('memory'))
          return ctx.notify('Memory is not enabled for this session.')
        ctx.notify('[dream] Starting memory consolidation...')
        try {
          const report = await dreamFor(forSession(ctx.session)).run(
            ctx.session,
            ctx.signal,
          )
          ctx.notify(report)
        } catch (error) {
          if (ctx.signal?.aborted) throw error
          ctx.notify(
            `[dream] Failed: ${error instanceof Error ? error.message : String(error)}. Inbox retained.`,
          )
        }
      },
    })
  }
  return Object.defineProperty(extension, 'name', { value: 'memory' })
}

function promptLayer(label: string, store: MemoryStore): string | null {
  const index = store.buildIndex(4000 - label.length - 2)
  return index ? `${label}:\n${index}` : null
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
        `  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} (${basename(h.entry.filePath)}) — ${h.entry.description}`,
    ),
  ].join('\n')
}
