import type { CommandHandler } from './index'

export const extensionCommands: CommandHandler[] = [
  // /extensions：已加载的扩展和它们注册的东西
  (cmd, { vela }) => {
    if (cmd !== '/extensions') return false

    const extensions = vela.extensions()
    if (extensions.length === 0) {
      console.log('\n[extensions] 没有加载扩展。\n')
      return true
    }

    console.log('\n[extensions]')
    for (const ext of extensions) {
      console.log(`  ${ext.name}`)
      if (ext.tools.length) console.log(`    工具: ${ext.tools.join(', ')}`)
      if (ext.commands.length)
        console.log(`    命令: ${ext.commands.map((c) => `/${c}`).join(', ')}`)
      if (ext.channels.length)
        console.log(`    通道: ${ext.channels.join(', ')}`)
    }
    console.log('')
    return true
  },
]
