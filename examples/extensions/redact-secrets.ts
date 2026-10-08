/**
 * tool_result: mask likely secrets before the model sees a tool result. Only the text the model sees
 * changes; the tool history keeps the original.
 * Note: for oversized results this hook gets a preview, and the full output stays on disk (the model
 * can read it by path). This reduces leaks; it does not isolate secrets.
 */
import type { VelaExtension } from '@glows777/vela'

const SECRET = /\b(sk-[A-Za-z0-9]{8,}|[A-Z_]*(KEY|TOKEN|SECRET)=\S+)/g

const redact: VelaExtension = (vela) => {
  vela.on('tool_result', (event) => {
    const output = event.output.replace(SECRET, '[REDACTED]')
    if (output !== event.output) return { output }
  })
}

export default redact
