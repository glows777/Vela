/**
 * tool_result：模型看到工具结果前把疑似密钥打码。只改模型看到的文本，工具历史里仍是原文。
 * 注意：超长结果这里拿到的是预览，原文仍保存在磁盘上（模型可以按路径读取），所以这只是减少泄露，不是隔离。
 */
import type { VelaExtension } from '@glows777/vela'

const SECRET = /\b(sk-[A-Za-z0-9]{8,}|[A-Z_]*(KEY|TOKEN|SECRET)=\S+)/g

const redact: VelaExtension = (vela) => {
  vela.on('tool_result', (event) => {
    const output = event.output.replace(SECRET, '[已打码]')
    if (output !== event.output) return { output }
  })
}

export default redact
