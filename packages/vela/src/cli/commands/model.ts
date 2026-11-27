import { THINKING_LEVELS } from '../../driver/diagnostics.ts'
import type { ThinkingLevel } from '../../driver/index.ts'
import type { CommandHandler } from './index.ts'

/** `/model [provider/id]`, `/thinking [level]`: show or switch the session's model and thinking level. */
export const modelCommands: CommandHandler[] = [
  (cmd, { print, runtime, session }) => {
    if (cmd !== '/model' && !cmd.startsWith('/model ')) return false
    const ref = cmd.slice('/model'.length).trim()
    return (async () => {
      if (ref) {
        try {
          const info = await session.setModel(ref)
          print(`\n[model] Session now uses ${info.ref}`)
        } catch (error) {
          print(
            `\n[model] ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return
      }
      const snap = await session.refresh()
      const current = snap.modelInfo
        ? snap.modelInfo.ref
        : `(unavailable: ${snap.modelError ?? 'no model selected'})`
      const lines = [`\n[model] Current: ${current}`]
      const models = await runtime.models({
        channel: snap.channel,
        ...(session.modelEnv ? { env: session.modelEnv } : {}),
      })
      if (models.length) {
        lines.push(
          '  Available models (switch with /model <provider/id>; unlisted ids work too):',
        )
        for (const m of models) {
          const meta = [
            m.contextWindow && `${Math.round(m.contextWindow / 1000)}k`,
            m.reasoning === false && 'no thinking',
          ].filter(Boolean)
          lines.push(
            `    ${m.ref === current ? '*' : ' '} ${m.ref}${m.name ? ` — ${m.name}` : ''}${meta.length ? ` (${meta.join(', ')})` : ''}`,
          )
        }
      } else {
        lines.push(
          '  No provider has a credential: sign in with /login or set an API key; or switch with /model <provider/id>',
        )
      }
      print(lines.join('\n'))
    })()
  },
  (cmd, { print, session }) => {
    if (cmd !== '/thinking' && !cmd.startsWith('/thinking ')) return false
    const level = cmd.slice('/thinking'.length).trim()
    return (async () => {
      const snap = session.snapshot ?? (await session.refresh())
      if (!level) {
        print(
          `\n[thinking] Current: ${snap.thinkingLevel}; this model supports: ${snap.availableThinkingLevels.join(' / ')}`,
        )
        return
      }
      if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
        print(`\n[thinking] Must be one of ${THINKING_LEVELS.join(' / ')}`)
        return
      }
      const next = await session.setThinkingLevel(level as ThinkingLevel)
      const currentModelRef = session.modelInfo?.ref ?? 'current model'
      print(
        next === level
          ? `\n[thinking] Session now uses: ${level}`
          : `\n[thinking] ${currentModelRef} does not support ${level}; using ${next} (switching to a model that supports ${level} uses it)`,
      )
    })()
  },
]
