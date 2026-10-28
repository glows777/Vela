import type { ThinkingLevel } from '@glows777/vela-core'
import { THINKING_LEVELS } from '../session-options.ts'
import type { CommandHandler } from './index.ts'

/** `/model [provider/id]`, `/thinking [level]`: show or switch the session's model and thinking level (the picker UI lives in the TUI). */
export const modelCommands: CommandHandler[] = [
  (cmd, { print, vela, session }) => {
    if (cmd !== '/model' && !cmd.startsWith('/model ')) return false
    const ref = cmd.slice('/model'.length).trim()
    if (ref) {
      try {
        session.setModel(ref)
        print(`\n[model] Session now uses ${session.modelInfo.ref}`)
      } catch (error) {
        print(
          `\n[model] ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return true
    }
    let current: string
    try {
      current = session.modelInfo.ref
    } catch (error) {
      current = `(unavailable: ${error instanceof Error ? error.message : error})`
    }
    const lines = [`\n[model] Current: ${current}`]
    const models = vela.models()
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
    } else
      lines.push(
        '  No provider has a credential: sign in with /login or set an API key; or switch with /model <provider/id>',
      )
    print(lines.join('\n'))
    return true
  },
  (cmd, { print, session }) => {
    if (cmd !== '/thinking' && !cmd.startsWith('/thinking ')) return false
    const level = cmd.slice('/thinking'.length).trim()
    if (!level) {
      print(
        `\n[thinking] Current: ${session.thinkingLevel}; this model supports: ${session.availableThinkingLevels().join(' / ')}`,
      )
      return true
    }
    if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
      print(`\n[thinking] Must be one of ${THINKING_LEVELS.join(' / ')}`)
      return true
    }
    session.setThinkingLevel(level as ThinkingLevel)
    // Like pi, a level the model doesn't support is clamped; say so rather than pretend it applies
    print(
      session.thinkingLevel === level
        ? `\n[thinking] Session now uses: ${level}`
        : `\n[thinking] ${session.modelInfo.ref} does not support ${level}; using ${session.thinkingLevel} (switching to a model that supports ${level} uses it)`,
    )
    return true
  },
]
