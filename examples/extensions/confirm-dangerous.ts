/**
 * tool_call + ctx.ui.confirm：跑带 `rm` 的 bash 命令前先问用户（仿 pi 的 permission-gate 示例）。
 * 没有界面（SDK、`-p`、通道会话）时 confirm 返回 false，于是直接拦下。
 * 也可以不写扩展，用会话权限 `vela.session(id, { permissions: { bash: 'ask' } })`。
 */
import type { VelaExtension } from 'vela'

const confirmDangerous: VelaExtension = (vela) => {
  vela.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return
    const command = String(event.input.command ?? '')
    if (!/\brm\b/.test(command)) return
    const ok = await ctx.ui.confirm('要删除文件', command)
    if (!ok) return { block: true, reason: '用户没有允许删除' }
  })
}

export default confirmDangerous
