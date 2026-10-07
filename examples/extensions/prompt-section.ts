/**
 * before_agent_start：往这一轮的 system prompt 里加一段（同 pi 的 systemPromptOptions.sections）。
 * 每次 prompt() 算一次，这一轮里的每次模型请求都用同一段，缓存前缀稳定。
 */
import type { VelaExtension } from 'vela'

const today: VelaExtension = (vela) => {
  vela.on('before_agent_start', (event) => {
    event.sections.today = `今天是 ${new Date().toISOString().slice(0, 10)}。`
  })
}

export default today
