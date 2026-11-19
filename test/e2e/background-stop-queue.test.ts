import { afterEach, expect, test } from 'bun:test'
import { fauxHang, fauxText, fauxToolCall } from '@glows777/vela-core/testing'
import { lark } from '@glows777/vela-lark'
import { background } from '../../packages/core/src/extensions/background/index.ts'
import { fakeLark, larkEvent } from '../support/lark.ts'
import { cleanupTestVelas, createTestVela } from '../support/vela.ts'

afterEach(cleanupTestVelas)

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for channel')
    await Bun.sleep(5)
  }
}
const topicEvent = (message_id: string, text: string) =>
  larkEvent({
    message_id,
    root_id: 'root',
    thread_id: 'thread',
    content: JSON.stringify({ text }),
  })

for (const command of ['!stop', '!restart'])
  test(`${command} drops a completed background result still queued behind the cancelled turn`, async () => {
    const fake = fakeLark()
    let resultQueued = false
    const t = createTestVela({
      responses: [
        fauxToolCall('bash', {
          command: 'echo READY',
          run_in_background: true,
        }),
        fauxHang('Working'),
        fauxText('Answered the next human input.'),
      ],
      extensions: [
        background(),
        lark({
          appId: 'bot',
          owners: ['ou_alice'],
          chats: ['oc_group'],
          transport: fake.transport,
        }),
        function observeResult(api) {
          api.on('session_start', (_event, { session }) => {
            const host = session.host
            const notify = host?.background?.bind(host)
            if (!host || !notify) return
            host.background = async (event) => {
              await notify(event)
              if (event.type === 'result') resultQueued = true
            }
          })
        },
      ],
    })
    await t.vela.ready()
    await t.vela.startChannels()
    fake.deliver(topicEvent('trigger', 'Start the job and keep working'))
    await until(() => resultQueued && t.model.calls.length === 2)
    fake.deliver(topicEvent('cancel', command))
    await until(() =>
      fake.sent.some((message) =>
        message.text.includes(
          command === '!restart'
            ? 'Restarted with a fresh session'
            : 'Stopped the current run.',
        ),
      ),
    )
    // Ordinary queued work is unaffected; only the invalidated background token is dropped.
    fake.deliver(topicEvent('next', 'Now answer this human input'))
    await until(() =>
      fake.sent.some((message) =>
        message.text.includes('Answered the next human input.'),
      ),
    )
    expect(t.model.calls).toHaveLength(3)
    expect(t.model.calls[2]!.lastUserText).toContain(
      'Now answer this human input',
    )
    expect(
      t.model.calls.some((call) =>
        call.lastUserText.startsWith('Background command'),
      ),
    ).toBe(false)
    expect(fake.sent.some((message) => message.messageId === 'root')).toBe(
      false,
    )
  })
