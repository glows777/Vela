import { join } from 'node:path'
import type {
  ExtensionConfigDefinition,
  SessionScope,
  VelaExtension,
  VelaSession,
} from '../../extension-api.ts'
import {
  customMessageIfChanged,
  customMessageMissing,
  lastCustomMessage,
} from '../../extension-api.ts'
import { MemoryDream } from './dream.ts'
import { MEMORY_RULES, MemoryStore } from './store.ts'
import { createMemoryTool } from './tool.ts'

const EMPTY_MEMORY =
  '[memory] No memories stored yet. Use the memory tool to save important information.'

/**
 * Cross-session memory: local/direct sessions use `<dataDir>/memory`; groups use their own store
 * plus shared global read/search. The same scope applies to the prompt and /memory /dream.
 * Sessions without the memory tool get no index or memory commands.
 */
export function memory(): VelaExtension {
  return function memory(vela) {
    const store = new MemoryStore(
      join(vela.dataDir, 'memory'),
      vela.logger,
      vela.cwd,
    )
    store.init()
    const groups = new Map<string, MemoryStore>()
    const forSession = (scope?: Readonly<SessionScope>): MemoryStore => {
      if (scope?.kind !== 'shared') return store
      const dir = scope.dataDir
      let group = groups.get(dir)
      if (!group) {
        group = new MemoryStore(
          join(dir, 'memory'),
          vela.logger,
          join(dir, 'workspace'),
        )
        group.init()
        groups.set(dir, group)
      }
      return group
    }
    const dreams = new Map<MemoryStore, MemoryDream>()
    const dreamFor = (local: MemoryStore): MemoryDream => {
      let dream = dreams.get(local)
      if (!dream) {
        dream = new MemoryDream(local)
        dreams.set(local, dream)
      }
      return dream
    }
    vela.on('agent_end', (event, ctx) => {
      if (ctx.session.toolDecision('memory') !== 'allow') return
      dreamFor(forSession(ctx.session.scope)).collect(
        ctx.session,
        event.messages,
      )
    })
    vela.on('agent_settled', (_event, ctx) => {
      if (
        vela.config.dream === false ||
        ctx.session.toolDecision('memory') !== 'allow'
      )
        return
      const dream = dreamFor(forSession(ctx.session.scope))
      if (dream.due())
        void dream
          .run(ctx.session)
          .catch((error) =>
            vela.logger.warn(
              `[dream] ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
    })
    vela.onShutdown(async () => {
      await Promise.all([...dreams.values()].map((dream) => dream.stop()))
    })
    vela.registerTool(
      createMemoryTool(store, (context) => forSession(context?.scope)),
    )

    const contentFor = (session: VelaSession): string | null => {
      const local = forSession(session.scope)
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

    /** Sessions whose context carried an index when the prompt started: only those can lose one to compaction. */
    const indexed = new WeakSet<VelaSession>()

    vela.on('before_agent_start', (event, ctx) => {
      if (ctx.session.toolDecision('memory') === 'deny') return
      event.sections.memory = MEMORY_RULES
      const content = contentFor(ctx.session)
      const message = content
        ? customMessageIfChanged(ctx.session, 'memory', content)
        : undefined
      if (message || lastCustomMessage(ctx.session, 'memory'))
        indexed.add(ctx.session)
      else indexed.delete(ctx.session)
      return message ? { message } : undefined
    })

    // Automatic compaction can drop that message after the check above and before this request goes out
    vela.on('context', (event, ctx) => {
      if (!indexed.has(ctx.session)) return
      const markers = ['[memory]', 'Group memory:', 'Global notes (']
      if (!customMessageMissing(event.messages, markers)) return
      const content = contentFor(ctx.session)
      if (content) event.messages.push({ role: 'user', content })
    })

    vela.registerCommand('memory', {
      description:
        'List memories; /memory search <keywords> to search, /memory lint to check',
      handler: (args, ctx) => {
        if (ctx.session.toolDecision('memory') === 'deny')
          return ctx.ui.notify('Memory is not enabled for this session.')
        const local = forSession(ctx.session.scope)
        if (args === 'lint') return ctx.ui.notify(lintReport(local))
        if (args.startsWith('search ')) {
          const query = args.slice('search '.length).trim()
          return ctx.ui.notify(searchReport(local, query))
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
          lines.push(`${flag} [${e.type}] ${e.name} — ${e.description}`)
        }
        ctx.ui.notify(lines.join('\n'))
      },
    })

    vela.registerCommand('dream', {
      description:
        'Consolidate memory against recent conversations in an isolated model call',
      handler: async (_args, ctx) => {
        if (ctx.session.toolDecision('memory') === 'deny')
          return ctx.ui.notify('Memory is not enabled for this session.')
        if (ctx.session.toolDecision('memory') === 'ask')
          return ctx.ui.notify(
            '[dream] Memory permission requires approval; dream is unavailable. Use the memory tool for individually approved operations.',
          )
        ctx.ui.notify('[dream] Starting memory consolidation...')
        try {
          const report = await dreamFor(forSession(ctx.session.scope)).run(
            ctx.session,
            ctx.signal,
          )
          ctx.ui.notify(report)
        } catch (error) {
          if (ctx.signal?.aborted) throw error
          ctx.ui.notify(
            `[dream] Failed: ${error instanceof Error ? error.message : String(error)}. Inbox retained.`,
          )
        }
      },
    })
  }
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
        `  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} — ${h.entry.description}`,
    ),
  ].join('\n')
}

export const memoryConfig: ExtensionConfigDefinition = {
  name: 'memory',
  resolve(section) {
    return { ...section }
  },
}
