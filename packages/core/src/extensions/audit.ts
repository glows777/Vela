import type { VelaExtension } from '../extension-api.ts'

/** Core-installed after user extensions so auditing sees their final tool input. */
export const auditLog: VelaExtension = function auditLog(api) {
  for (const toolName of ['write_file', 'edit_file']) {
    api.on('tool_call', toolName, (event, ctx) => {
      const path = (event.input as { path?: string } | null)?.path || 'unknown'
      ctx.session.emit({ type: 'audit', toolName, path })
    })
  }
}
