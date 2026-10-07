import { THINKING_LEVELS, type ThinkingLevel } from '../../models'
import type { CommandHandler } from './index'

/** `/model [provider/id]`、`/thinking [级别]`：查看或切换当前会话的模型和 thinking（选择器 UI 留给 TUI）。 */
export const modelCommands: CommandHandler[] = [
  (cmd, { print, vela, session }) => {
    if (cmd !== '/model' && !cmd.startsWith('/model ')) return false
    const ref = cmd.slice('/model'.length).trim()
    if (ref) {
      try {
        session.setModel(ref)
        print(`\n[模型] 当前会话改用 ${session.modelInfo.ref}`)
      } catch (error) {
        print(
          `\n[模型] ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return true
    }
    let current: string
    try {
      current = session.modelInfo.ref
    } catch (error) {
      current = `（不可用: ${error instanceof Error ? error.message : error}）`
    }
    const lines = [`\n[模型] 当前: ${current}`]
    const models = vela.models()
    if (models.length) {
      lines.push('  已配置的模型（/model <provider/id> 切换，没列出的 id 也可以直接写）:')
      for (const m of models) {
        const meta = [
          m.contextWindow && `${Math.round(m.contextWindow / 1000)}k`,
          m.reasoning === false && '无 thinking',
        ].filter(Boolean)
        lines.push(
          `    ${m.ref === current ? '*' : ' '} ${m.ref}${m.name ? ` — ${m.name}` : ''}${meta.length ? ` (${meta.join(', ')})` : ''}`,
        )
      }
    } else
      lines.push('  /model <provider/id> 切换，例如 /model anthropic/<模型 id>')
    print(lines.join('\n'))
    return true
  },
  (cmd, { print, session }) => {
    if (cmd !== '/thinking' && !cmd.startsWith('/thinking ')) return false
    const level = cmd.slice('/thinking'.length).trim()
    if (!level) {
      print(
        `\n[thinking] 当前: ${session.thinkingLevel}；可选 ${THINKING_LEVELS.join(' / ')}`,
      )
      return true
    }
    if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
      print(`\n[thinking] 只能是 ${THINKING_LEVELS.join(' / ')}`)
      return true
    }
    session.setThinkingLevel(level as ThinkingLevel)
    print(`\n[thinking] 当前会话: ${session.thinkingLevel}`)
    return true
  },
]
