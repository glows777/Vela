import { join } from 'node:path'
import { channelScopes, chatDirectory } from '../../channels/scope.ts'
import type { VelaSession } from '../../vela-session.ts'
import {
  customMessageIfChanged,
  customMessageMissing,
  lastCustomMessage,
} from '../custom-message.ts'
import type { VelaExtension } from '../types.ts'
import { MEMORY_RULES, MemoryStore } from './store.ts'
import { createMemoryTool } from './tool.ts'

const EMPTY_MEMORY =
  '[memory] No memories stored yet. Use the memory tool to save important information.'

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
    const forSession = (registry?: object): MemoryStore => {
      const scope = registry && channelScopes.get(registry)
      if (scope?.chatKind !== 'group') return store
      const dir = chatDirectory(vela.dataDir, scope.channel, scope.chatId)
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
    vela.registerTool(
      createMemoryTool(store, (context) => forSession(context?.registry)),
    )

    const contentFor = (session: VelaSession): string | null => {
      const local = forSession(session.registry)
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
      if (ctx.session.registry.decide('memory') === 'deny') return
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
        if (ctx.session.registry.decide('memory') === 'deny')
          return ctx.ui.notify('Memory is not enabled for this session.')
        const local = forSession(ctx.session.registry)
        if (args === 'lint') return ctx.ui.notify(lintReport(local))
        if (args.startsWith('search ')) {
          const query = args.slice('search '.length).trim()
          return ctx.ui.notify(searchReport(local, query))
        }
        const entries = local.list()
        const reports = local.lint()
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
        if (ctx.session.registry.decide('memory') === 'deny')
          return ctx.ui.notify('Memory is not enabled for this session.')
        ctx.ui.notify('[dream] Starting memory cleanup...')
        await ctx.session.prompt(DREAM_PROMPT, { signal: ctx.signal })
        ctx.ui.notify('[dream] Done')
      },
    })
  }
}

function promptLayer(label: string, store: MemoryStore): string | null {
  const index = store.buildIndex()
  if (!index) return null
  const section = `${label}:\n${index}`
  const suffix = '\n...(truncated)'
  return section.length > 4000
    ? section.slice(0, 4000 - suffix.length) + suffix
    : section
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
