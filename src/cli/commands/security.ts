import type { CommandHandler } from './index.ts'

export const securityCommands: CommandHandler[] = [
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
