import { ROLES, type Role } from '../../security/roles.ts'
import type { CommandHandler } from './index.ts'

export const securityCommands: CommandHandler[] = [
  // /role [owner|collaborator|guest]：只改当前会话
  (cmd, { print, session }) => {
    const match = cmd.match(/^\/role(?:\s+(\S+))?$/)
    if (!match) return false
    const role = match[1]
    if (role && !ROLES.includes(role as Role)) return false

    if (role) session.role = role as Role
    const toolCount = session.getActiveTools().length
    print(
      role
        ? `\n[security] 角色切换为 ${role}，可用工具: ${toolCount} 个\n`
        : `\n[security] 当前角色: ${session.role}，可用工具: ${toolCount} 个\n`,
    )
    return true
  },

  // /hooks
  (cmd, { print, internals }) => {
    if (cmd !== '/hooks') return false

    const hooks = internals.hooks.list()
    print('\n[hooks]')
    if (hooks.pre.length > 0) {
      print('  Pre-Tool Hooks:')
      for (const name of hooks.pre) print(`    - ${name}`)
    }
    if (hooks.post.length > 0) {
      print('  Post-Tool Hooks:')
      for (const name of hooks.post) print(`    - ${name}`)
    }
    if (hooks.pre.length === 0 && hooks.post.length === 0) {
      print('  没有注册的 Hook')
    }
    print('')
    return true
  },
]
