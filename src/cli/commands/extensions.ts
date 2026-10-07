import type { CommandHandler } from './index.ts'

export const extensionCommands: CommandHandler[] = [
  // /extensions：已加载的扩展和它们注册的东西
  (cmd, { print, vela }) => {
    if (cmd !== '/extensions') return false

    const extensions = vela.extensions()
    if (extensions.length === 0) {
      print('\n[extensions] 没有加载扩展。\n')
      return true
    }

    print('\n[extensions]')
    for (const ext of extensions) {
      print(`  ${ext.name}`)
      if (ext.tools.length) print(`    工具: ${ext.tools.join(', ')}`)
      if (ext.commands.length)
        print(`    命令: ${ext.commands.map((c) => `/${c}`).join(', ')}`)
      if (ext.channels.length)
        print(`    通道: ${ext.channels.join(', ')}`)
    }
    print('')
    return true
  },
]
