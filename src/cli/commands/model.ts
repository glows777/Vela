import { THINKING_LEVELS, type ThinkingLevel } from '../../models/index.ts'
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
      lines.push('  Configured models (switch with /model <provider/id>; unlisted ids work too):')
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
      lines.push('  Switch with /model <provider/id>, e.g. /model anthropic/<model id>')
    print(lines.join('\n'))
    return true
  },
  (cmd, { print, session }) => {
    if (cmd !== '/thinking' && !cmd.startsWith('/thinking ')) return false
    const level = cmd.slice('/thinking'.length).trim()
    if (!level) {
      print(
        `\n[thinking] Current: ${session.thinkingLevel}; options: ${THINKING_LEVELS.join(' / ')}`,
      )
      return true
    }
    if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
      print(`\n[thinking] Must be one of ${THINKING_LEVELS.join(' / ')}`)
      return true
    }
    session.setThinkingLevel(level as ThinkingLevel)
    print(`\n[thinking] Session now uses: ${session.thinkingLevel}`)
    return true
  },
]
