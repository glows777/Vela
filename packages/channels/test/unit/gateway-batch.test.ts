import { expect, test } from 'bun:test'
import { silentLogger } from '@glows777/vela-core'
import type { TopicCommands } from '../../src/commands.ts'
import type { ChannelDirectory } from '../../src/directory.ts'
import type { RunFeedback } from '../../src/feedback.ts'
import type { GatewayIdle } from '../../src/gateway-idle.ts'
import { GatewayInput } from '../../src/gateway-input.ts'
import type { IncomingMessage } from '../../src/types.ts'

const passive = (id: string): IncomingMessage => ({
  channelId: 'oc_group',
  chatKind: 'group',
  senderId: 'ou_bob',
  senderName: 'Bob',
  text: id,
  replyToId: id,
  passive: true,
})

test('a queued message whose admission fails does not swallow the rest of its batch', async () => {
  const errors: unknown[] = []
  const processed: string[][] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let working = false
  let failAdmission = false
  const directory: Pick<ChannelDirectory, 'load' | 'get' | 'admit'> = {
    load: async () => {},
    get: () => undefined,
    admit: async () => {
      if (!failAdmission) return
      failAdmission = false
      throw new Error('index write failed')
    },
  }
  const commands: Pick<TopicCommands, 'controllable' | 'receive'> = {
    controllable: () =>
      working ? { stopped: false, runId: 'run', preparing: true } : undefined,
    receive: (_key, _name, _msg, admit) => {
      const admitted = admit()
      return { blocked: false, available: admitted, admitted }
    },
  }
  const feedback: Pick<RunFeedback, 'receive' | 'feedbackError'> = {
    receive: () => async () => false,
    feedbackError: async (_channel, _msg, error) => {
      errors.push(error)
    },
  }
  const idle: Pick<GatewayIdle, 'cancel' | 'schedule'> = {
    cancel() {},
    schedule() {},
  }
  const input = new GatewayInput(
    directory as ChannelDirectory,
    {} as never,
    commands as TopicCommands,
    feedback as RunFeedback,
    idle as GatewayIdle,
    () => undefined,
    async (_id, _name, messages) => {
      processed.push(messages.map((message) => message.text))
      if (processed.length > 1) return
      working = true
      entered.resolve()
      await release.promise
      working = false
    },
    () => {},
    () => false,
    silentLogger,
  )
  void input.enqueue('lark', passive('first'))
  await entered.promise
  // The run is working, so these two share its queue slot; the first cannot be saved.
  failAdmission = true
  void input.enqueue('lark', passive('failing'))
  void input.enqueue('lark', passive('accepted'))
  release.resolve()
  const deadline = Date.now() + 2000
  while (processed.length < 2) {
    if (Date.now() > deadline) throw new Error('Batch did not settle')
    await Bun.sleep(1)
  }
  expect(processed).toEqual([['first'], ['accepted']])
  expect(errors).toHaveLength(1)
})
