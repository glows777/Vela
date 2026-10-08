import type { CommandHandler } from './index.ts'

export const extensionCommands: CommandHandler[] = [
  // /extensions: loaded extensions and what they registered
  (cmd, { print, vela }) => {
    if (cmd !== '/extensions') return false

    const extensions = vela.extensions()
    if (extensions.length === 0) {
      print('\n[extensions] No extensions loaded.\n')
      return true
    }

    print('\n[extensions]')
    for (const ext of extensions) {
      print(`  ${ext.name}`)
      if (ext.tools.length) print(`    Tools: ${ext.tools.join(', ')}`)
      if (ext.commands.length)
        print(`    Commands: ${ext.commands.map((c) => `/${c}`).join(', ')}`)
      if (ext.channels.length)
        print(`    Channels: ${ext.channels.join(', ')}`)
    }
    print('')
    return true
  },
]
