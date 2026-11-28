/**
 * tool_call + ctx.notify: block bash commands that contain `rm` and notify the session.
 * Load this user extension to guard against accidental deletion; Vela has no built-in command gate.
 * This simple pattern catches mistakes; it is not a security boundary.
 */
import type { VelaExtension } from '@glows777/vela/extension-api'

const confirmDangerous: VelaExtension = (vela) => {
  vela.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return
    const command = String(event.input.command ?? '')
    if (!/\brm\b/.test(command)) return
    ctx.notify(`Blocked dangerous command: ${command}`, 'warning')
    return {
      block: true,
      reason: 'Deletion blocked by confirm-dangerous extension',
    }
  })
}

export default confirmDangerous
