import { ROLES, type Role } from '../../security/roles.ts'
import type { CommandHandler } from './index.ts'

export const securityCommands: CommandHandler[] = [
  // /role [owner|collaborator|guest]: changes the current session only
  (cmd, { print, session }) => {
    const match = cmd.match(/^\/role(?:\s+(\S+))?$/)
    if (!match) return false
    const role = match[1]
    if (role && !ROLES.includes(role as Role)) return false

    if (role) session.role = role as Role
    const toolCount = session.getActiveTools().length
    print(
      role
        ? `\n[security] Role switched to ${role}, available tools: ${toolCount}\n`
        : `\n[security] Current role: ${session.role}, available tools: ${toolCount}\n`,
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
      print('  No hooks registered')
    }
    print('')
    return true
  },
]
