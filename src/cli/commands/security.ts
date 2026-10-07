import type { HookPipeline } from '../../security/hooks'
import type { Role } from '../../security/roles'
import type { ToolRegistry } from '../../tools/registry'
import type { CommandHandler } from './index'

export function createSecurityCommands(
  registry: ToolRegistry,
  hookPipeline: HookPipeline,
): CommandHandler[] {
  return [
    // /role [owner|collaborator|guest]
    (cmd, _ctx) => {
      const match = cmd.match(/^\/role(?:\s+(owner|collaborator|guest))?$/)
      if (!match) return false

      if (match[1]) {
        const role = match[1] as Role
        registry.setRole(role)
        const toolCount = registry.getActiveTools().length
        console.log(
          `\n[security] 角色切换为 ${role}，可用工具: ${toolCount} 个\n`,
        )
      } else {
        const role = registry.getRole()
        const toolCount = registry.getActiveTools().length
        console.log(
          `\n[security] 当前角色: ${role}，可用工具: ${toolCount} 个\n`,
        )
      }
      return true
    },

    // /hooks
    (cmd, _ctx) => {
      if (cmd !== '/hooks') return false

      const hooks = hookPipeline.list()
      console.log('\n[hooks]')
      if (hooks.pre.length > 0) {
        console.log('  Pre-Tool Hooks:')
        for (const name of hooks.pre) console.log(`    - ${name}`)
      }
      if (hooks.post.length > 0) {
        console.log('  Post-Tool Hooks:')
        for (const name of hooks.post) console.log(`    - ${name}`)
      }
      if (hooks.pre.length === 0 && hooks.post.length === 0) {
        console.log('  没有注册的 Hook')
      }
      console.log('')
      return true
    },
  ]
}
