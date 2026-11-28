/**
 * session_start + setActiveTools: sessions whose id starts with `review-` get read-only tools only
 * (like pi's setActiveTools).
 * The tool selection is per session; other sessions in the same Runtime are not affected.
 */
import type { VelaExtension } from '@glows777/vela/extension-api'

const READ_ONLY = ['read', 'ls', 'find', 'grep']

const readOnlyReview: VelaExtension = (vela) => {
  vela.on('session_start', (_event, ctx) => {
    if (ctx.session.id.startsWith('review-'))
      ctx.session.setActiveTools(READ_ONLY)
  })
}

export default readOnlyReview
