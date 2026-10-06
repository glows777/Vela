import type { Vela } from '../app'
import {
  contextCommands,
  createDispatcher,
  debugCommands,
  memoryCommands,
} from '../commands'
import { createChannelCommands } from '../commands/channel'
import { dreamCommands } from '../commands/dream'
import { createPluginCommands } from '../commands/plugin'
import { ragCommands } from '../commands/rag'
import { createSecurityCommands } from '../commands/security'
import { createSkillCommands } from '../commands/skill'
import { feishuPlugin } from '../plugins/built-in-plugins/feishu-plugin'
import { supabasePlugin } from '../plugins/built-in-plugins/supabase-plugin'
import type { PluginDefinition } from '../plugins/types'

/** CLI 启动时加载的内置插件。 */
export function builtInPlugins(): Map<string, PluginDefinition> {
  return new Map<string, PluginDefinition>([
    ['supabase', supabasePlugin],
    ['feishu', feishuPlugin],
  ])
}

/** CLI 的全部斜杠命令；测试用同一份分发器，保证命令行为和真实入口一致。 */
export function createCliDispatcher(
  vela: Vela,
  plugins: Map<string, PluginDefinition> = builtInPlugins(),
) {
  return createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...memoryCommands,
    ...dreamCommands,
    ...ragCommands,
    ...createSkillCommands(vela.skillLoader, vela.activeSkills),
    ...createPluginCommands(vela.pluginManager, plugins),
    ...createChannelCommands(vela.gateway),
    ...createSecurityCommands(vela.registry, vela.hooks),
  ])
}
