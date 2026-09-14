import type { ChannelGateway } from '../channels/gateway'
import type { ToolDefinition, ToolRegistry } from '../tools/registry'
import type { PluginApi, PluginConfig, PluginDefinition } from './types'

interface LoadedPlugin {
  definition: PluginDefinition
  tools: string[]
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()
  private registry: ToolRegistry

  constructor(
    registry: ToolRegistry,
    private gateway: ChannelGateway,
  ) {
    this.registry = registry
  }

  async load(
    definition: PluginDefinition,
    config?: PluginConfig,
  ): Promise<string[]> {
    if (this.plugins.has(definition.name)) {
      throw new Error(`插件 "${definition.name}" 已加载`)
    }

    const resolvedConfig = this.resolveEnvVars({
      ...definition.config,
      ...config,
    })

    const registeredTools: string[] = []

    const api: PluginApi = {
      registerChannel: (channel) => {
        this.gateway.register(channel)
      },
      registerTools: (tools: ToolDefinition[]) => {
        for (const tool of tools) {
          const prefixedName = `${definition.name}__${tool.name}`
          const prefixedTool: ToolDefinition = {
            ...tool,
            name: prefixedName,
            description: `[Plugin:${definition.name}] ${tool.description}`,
          }
          this.registry.register(prefixedTool)
          registeredTools.push(prefixedName)
        }
      },
      getConfig: () => resolvedConfig,
      log: (message: string) => {
        console.log(`  [plugin:${definition.name}] ${message}`)
      },
    }

    try {
      await definition.activate(api)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  [plugin:${definition.name}] 激活失败: ${msg}`)
      throw err
    }

    this.plugins.set(definition.name, {
      definition,
      tools: registeredTools,
    })

    return registeredTools
  }

  async unload(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name)
    if (!plugin) return false

    if (plugin.definition.destroy) {
      try {
        await plugin.definition.destroy()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  [plugin:${name}] destroy 出错: ${msg}`)
      }
    }

    for (const toolName of plugin.tools) {
      this.registry.unregister(toolName)
    }

    this.plugins.delete(name)
    return true
  }

  async unloadAll(): Promise<void> {
    const names = Array.from(this.plugins.keys())
    for (const name of names) {
      await this.unload(name)
    }
  }

  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name)
  }

  list(): Array<{
    name: string
    version: string
    description: string
    tools: string[]
  }> {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.definition.name,
      version: p.definition.version,
      description: p.definition.description,
      tools: p.tools,
    }))
  }

  private resolveEnvVars(config: PluginConfig): PluginConfig {
    const resolved: PluginConfig = {}
    for (const [key, value] of Object.entries(config)) {
      if (
        typeof value === 'string' &&
        value.startsWith('${') &&
        value.endsWith('}')
      ) {
        const envKey = value.slice(2, -1)
        resolved[key] = process.env[envKey] || ''
      } else {
        resolved[key] = value
      }
    }
    return resolved
  }
}
