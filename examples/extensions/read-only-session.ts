/**
 * session_start + setActiveTools：id 以 `review-` 开头的会话只启用只读工具（同 pi 的 setActiveTools）。
 * 工具选择是按会话的，不影响同一个 Vela 里的其它会话。
 */
import type { VelaExtension } from 'vela'

const READ_ONLY = ['read_file', 'list_directory', 'glob', 'grep']

const readOnlyReview: VelaExtension = (vela) => {
  vela.on('session_start', (_event, ctx) => {
    if (ctx.session.id.startsWith('review-'))
      ctx.session.setActiveTools(READ_ONLY)
  })
}

export default readOnlyReview
