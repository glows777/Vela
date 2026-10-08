/**
 * tool_call + ctx.ui.confirm: ask the user before running a bash command that contains `rm`
 * (modeled on pi's permission-gate example).
 * With no UI (SDK, `-p`, channel sessions) confirm returns false, so the call is blocked.
 * You can also skip the extension and use session permissions:
 * `vela.session(id, { permissions: { bash: 'ask' } })`.
 */
import type { VelaExtension } from '@glows777/vela'

const confirmDangerous: VelaExtension = (vela) => {
  vela.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return
    const command = String(event.input.command ?? '')
    if (!/\brm\b/.test(command)) return
    const ok = await ctx.ui.confirm('Delete files?', command)
    if (!ok) return { block: true, reason: 'User did not allow the deletion' }
  })
}

export default confirmDangerous
