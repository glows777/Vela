/**
 * before_agent_start: add a section to this turn's system prompt (like pi's systemPromptOptions.sections).
 * It is rendered as `<today>...</today>` after the built sections, computed once per prompt() call, so
 * every model request in the turn uses the same section and the cache prefix stays stable.
 * Returning `{ systemPrompt }` instead replaces the whole prompt for that turn.
 */
import type { VelaExtension } from '@glows777/vela/extension-api'

const today: VelaExtension = (vela) => {
  vela.on('before_agent_start', (event) => {
    event.sections.today = `Today is ${new Date().toISOString().slice(0, 10)}.`
  })
}

export default today
