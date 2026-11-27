import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRuntime,
  DaemonLarkHost,
} from '../../packages/vela/src/legacy-desktop.ts'
import {
  createFauxModel,
  fauxText,
} from '../../packages/vela/src/testing/core/index.ts'

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

    const agentDir = mkdtempSync(join(tmpdir(), 'vela-lark-live-'))
    const tag = randomUUID().slice(0, 8)
    const author = { id: 'sdk-live-check', name: 'Vela SDK test' }
    const opening = `#416 ${tag}: opening`
    const following = `#416 ${tag}: continuing`
    const firstAnswer = `#416 ${tag}: first faux reply`
    const secondAnswer = `#416 ${tag}: second faux reply`
    const model = createFauxModel({
      responses: [fauxText(firstAnswer), fauxText(secondAnswer)],
    })
    const runtime = createRuntime({
      agentDir,
      defaultModel: model,
      hostEnv: {},
      mcp: false,
    })
    const host = new DaemonLarkHost(runtime, {
      agentDir,
      hostEnv: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    })
    try {
      await runtime.ready()
      await host.sync(
        {
          lark: {
            appId,
            appSecret,
            chats: [{ id: chatId, readUntagged: false }],
          },
        },
        true,
      )
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
      await poll(
        async () =>
          Boolean(
            (await runtime.channels.list()).find((c) => c.name === 'lark')
              ?.connected,
          ),
        'Lark connection',
      )
      const rootBinding = (
        await runtime.bindings.list({ channel: 'lark' })
      ).find((b) => b.externalId === chatId && !b.threadId)
      const project = rootBinding?.projectId
        ? await runtime.projects.get(rootBinding.projectId)
        : undefined
      const groupSessionId = project!.hubSessionId!

      // Real API call before any writes: verify the full time-range query is accepted.
      await runtime.sessions.messages({ sessionId: groupSessionId, limit: 5 })
      const receipt = await runtime.channels.submit('lark', {
        chatId,
        author,
        newTopic: { title: `SDK check ${tag}` },
        text: opening,
      })
      const topicSessionId = receipt.sessionId!
      await poll(
        async () =>
          (
            await runtime.sessions.messages({
              sessionId: groupSessionId,
              limit: 10,
            })
          ).messages.some(
            (row) =>
              row.id === receipt.messageId &&
              row.role === 'assistant' &&
              row.text === `${author.name}: ${opening}`,
          ),
        'signed bot message appears in group history',
      )
      await poll(
        async () =>
          (
            await runtime.sessions.messages({ sessionId: topicSessionId })
          ).messages.some(
            (row) => row.role === 'assistant' && row.text === firstAnswer,
          ),
        'first model reply appears in topic history',
      )

      const followup = await runtime.channels.submit('lark', {
        chatId,
        sessionId: topicSessionId,
        author,
        text: following,
      })
      expect(followup.sessionId).toBe(topicSessionId)
      await poll(async () => {
        const { messages } = await runtime.sessions.messages({
          sessionId: topicSessionId,
        })
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
      const topicBinding = (
        await runtime.bindings.list({ channel: 'lark' })
      ).find((b) => b.sessionId === topicSessionId)
      expect(topicBinding?.threadId).toBe(receipt.topic?.threadId)
      expect(model.calls).toHaveLength(2)
      console.log(
        `Verified signed group root, owned topic and follow-up for run ${tag}`,
      )
    } finally {
      await host.stop()
      await runtime.dispose()
      rmSync(agentDir, { recursive: true, force: true })
    }
  },
  90_000,
)
