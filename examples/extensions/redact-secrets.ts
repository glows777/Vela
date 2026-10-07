/**
 * tool_result：模型看到工具结果前把疑似密钥打码。只改模型看到的文本，工具历史里仍是原文。
 */
import type { VelaExtension } from 'vela'

const SECRET = /\b(sk-[A-Za-z0-9]{8,}|[A-Z_]*(KEY|TOKEN|SECRET)=\S+)/g

const redact: VelaExtension = (vela) => {
  vela.on('tool_result', (event) => {
    const output = event.output.replace(SECRET, '[已打码]')
    if (output !== event.output) return { output }
  })
}

export default redact
