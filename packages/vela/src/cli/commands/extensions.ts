import type { CommandHandler } from './index.ts'

export const extensionCommands: CommandHandler[] = [
  (cmd, { print, session }) => {
    if (cmd !== '/extensions') return false
    return (async () => {
      const snap = await session.refresh()
      const extensions = snap.extensions
      if (extensions.length === 0) {
        print('\n[extensions] No extensions loaded.\n')
        return
      }
      print('\n[extensions]')
      for (const ext of extensions) {
        print(`  ${ext.name}`)
        if (ext.tools.length) print(`    Tools: ${ext.tools.join(', ')}`)
        if (ext.commands.length)
          print(`    Commands: ${ext.commands.map((c) => `/${c}`).join(', ')}`)
        if (ext.providers.length)
          print(`    Providers: ${ext.providers.join(', ')}`)
      }
      print('')
    })()
  },
]
