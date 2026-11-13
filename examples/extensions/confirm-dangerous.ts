/**
 * tool_call + ctx.ui.confirm: ask the user before running a bash command that contains `rm`
 * Load this user extension to add confirmation; Vela has no built-in command gate.
 * ctx.hasUI guards sessions without a frontend (SDK, `-p`, channel sessions):
 * they block the call instead of asking. With a UI, ctx.ui.confirm asks the user.
 * This simple pattern catches mistakes; it is not a security boundary.
 */
import type { VelaExtension } from '@glows777/vela'

const confirmDangerous: VelaExtension = (vela) => {
  vela.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return
    const command = String(event.input.command ?? '')
    if (!/\brm\b/.test(command)) return
    if (!ctx.hasUI)
      return { block: true, reason: 'Deletion blocked: no UI for confirmation' }
    const ok = await ctx.ui.confirm('Delete files?', command)
    if (!ok) return { block: true, reason: 'User did not allow the deletion' }
  })
}

export default confirmDangerous
