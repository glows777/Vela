import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createTestVela } from '@glows777/vela/testing'
import { lark } from '../../packages/vela/src/lark/index.ts'
import { channelSessionId } from '../../packages/vela/src/legacy-channels/index.ts'
import { fauxText } from '../../packages/vela/src/testing/core/index.ts'

const live = process.env.VELA_LARK_HOST_LIVE === '1'

test.skipIf(!live)(
  'real Lark host reads and posts signed bot messages in an owned topic',
  async () => {
    const appId = process.env.LARK_APP_ID
    const appSecret = process.env.LARK_APP_SECRET
    const chatId = process.env.VELA_LARK_TEST_CHAT_ID
    if (!appId || !appSecret || !chatId?.startsWith('oc_'))
      throw new Error(
        'Set the test bot credentials and VELA_LARK_TEST_CHAT_ID for an authorized test group',
      )

    const tag = randomUUID().slice(0, 8)
    const author = { id: 'sdk-live-check', name: 'Vela SDK test' }
    const opening = `#416 ${tag}: opening`
    const following = `#416 ${tag}: continuing`
    const firstAnswer = `#416 ${tag}: first faux reply`
    const secondAnswer = `#416 ${tag}: second faux reply`
    const t = createTestVela({
      responses: [fauxText(firstAnswer), fauxText(secondAnswer)],
      allowPendingResponses: true,
      extensions: [
        lark({
          appId,
          appSecret,
          chats: [{ id: chatId, readUntagged: false }],
        }),
      ],
    })
    try {
      await t.vela.ready()
      const host = t.vela.channel('lark')
      await t.vela.startChannels()
      async function poll(
        check: () => boolean | Promise<boolean>,
        label: string,
      ) {
        const deadline = Date.now() + 15_000
        while (!(await check())) {
          if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`)
          await Bun.sleep(250)
        }
      }
      const group = { chatId, sessionId: channelSessionId('lark', chatId) }
      await poll(() => host.connection().connected, 'Lark connection')
      // Real API call before any writes: verify the full time-range query is accepted.
      await host.messages({ ...group, limit: 5 })
      const receipt = await host.submit({
        chatId,
        author,
        newTopic: { title: `SDK check ${tag}` },
        text: opening,
      })
      const topic = { chatId, sessionId: receipt.sessionId }
      await poll(
        async () =>
          (await host.messages({ ...group, limit: 10 })).messages.some(
            (row) =>
              row.id === receipt.messageId &&
              row.role === 'assistant' &&
              row.text === `${author.name}: ${opening}`,
          ),
        'signed bot message appears in group history',
      )
      await poll(
        async () =>
          (await host.messages(topic)).messages.some(
            (row) => row.role === 'assistant' && row.text === firstAnswer,
          ),
        'first model reply appears in topic history',
      )

      const followup = await host.submit({ ...topic, author, text: following })
      expect(followup.sessionId).toBe(receipt.sessionId)
      await poll(async () => {
        const { messages } = await host.messages(topic)
        return (
          messages.some(
            (row) =>
              row.id === followup.messageId &&
              row.role === 'assistant' &&
              row.text === `${author.name}: ${following}`,
          ) &&
          messages.some(
            (row) => row.role === 'assistant' && row.text === secondAnswer,
          )
        )
      }, 'signed follow-up and its reply appear in the same topic')
      expect(
        host.sessions(chatId).find((s) => s.sessionId === receipt.sessionId)
          ?.topic,
      ).toEqual(receipt.topic)
      expect(t.model.calls).toHaveLength(2)
      console.log(
        `Verified signed group root, owned topic and follow-up for run ${tag}`,
      )
    } finally {
      await t.cleanup()
    }
  },
  90_000,
)
