/**
 * before_agent_start: add a section to this turn's system prompt (like pi's systemPromptOptions.sections).
 * It is computed once per prompt() call, and every model request in the turn uses the same section,
 * so the cache prefix stays stable.
 */
import type { VelaExtension } from '@glows777/vela'

const today: VelaExtension = (vela) => {
  vela.on('before_agent_start', (event) => {
    event.sections.today = `Today is ${new Date().toISOString().slice(0, 10)}.`
  })
}

export default today
