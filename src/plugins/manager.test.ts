import { expect, spyOn, test } from 'bun:test'
import { MockLanguageModelV4 } from 'ai/test'
import { FeishuChannel } from '../channels/built-in-channels/lark'
import { ChannelGateway } from '../channels/gateway'
import { ToolRegistry } from '../tools/registry'
import { feishuPlugin } from './built-in-plugins/feishu-plugin'
import { PluginManager } from './manager'

test('飞书插件注册到 gateway，由 gateway 统一启停', async () => {
  const registry = new ToolRegistry()
  const gateway = new ChannelGateway({
    model: new MockLanguageModelV4(),
    registry,
    buildSystem: () => '',
    prepareContext: async () => {},
  })
  const manager = new PluginManager(registry, gateway)
  const start = spyOn(FeishuChannel.prototype, 'start').mockResolvedValue()
  const stop = spyOn(FeishuChannel.prototype, 'stop').mockResolvedValue()

  try {
    expect(gateway.list()).toEqual([])
    expect(
      await manager.load(feishuPlugin, {
        appId: '',
        appSecret: '',
        port: '',
      }),
    ).toEqual([])
    expect(gateway.list().map((channel) => channel.name)).toEqual(['feishu'])
    expect(manager.get('feishu')).toBeDefined()
    expect(start).not.toHaveBeenCalled()

    await gateway.startAll()
    expect(start).toHaveBeenCalledTimes(1)
    await gateway.stopAll()
    expect(stop).toHaveBeenCalledTimes(1)
    await expect(manager.load(feishuPlugin)).rejects.toThrow('已加载')
  } finally {
    start.mockRestore()
    stop.mockRestore()
  }
})
