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

/** A topic whose job finishes while the run that started it still hangs, so the result queues behind it. */
function queuedResult(extra: Record<string, unknown> = {}) {
  const fake = fakeLark()
  let resultQueued = false
  const t = createTestVela({
    responses: [
      fauxToolCall('bash', { command: 'echo READY', run_in_background: true }),
      fauxHang('Working'),
      fauxText('The command finished.'),
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
    ...extra,
  })
  return { fake, t, queued: () => resultQueued }
}

test('!stop keeps a completed background result queued behind the cancelled run and answers it', async () => {
  const { fake, t, queued } = queuedResult()
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'Start the job and keep working'))
  await until(() => queued() && t.model.calls.length === 2)
  fake.deliver(topicEvent('cancel', '!stop'))
  await until(() =>
    fake.sent.some((message) =>
      message.text.includes('Stopped the current run.'),
    ),
  )
  // A job belongs to its session, so the run it was queued behind ending does not lose its result.
  await until(() =>
    fake.sent.some((message) => message.text.includes('The command finished.')),
  )
  expect(t.model.calls[2]!.lastUserText).toStartWith(
    'Background command bg-1 finished with exit code 0.',
  )
  // A person's next message is still answered in its own turn.
  fake.deliver(topicEvent('next', 'Now answer this human input'))
  await until(() =>
    fake.sent.some((message) =>
      message.text.includes('Answered the next human input.'),
    ),
  )
  expect(t.model.calls[3]!.lastUserText).toContain(
    'Now answer this human input',
  )
})

test('!restart never carries a queued background result into the fresh session', async () => {
  const { fake, t, queued } = queuedResult()
  await t.vela.ready()
  await t.vela.startChannels()
  fake.deliver(topicEvent('trigger', 'Start the job and keep working'))
  await until(() => queued() && t.model.calls.length === 2)
  fake.deliver(topicEvent('cancel', '!restart'))
  await until(() =>
    fake.sent.some((message) =>
      message.text.includes('Restarted with a fresh session'),
    ),
  )
  // The replaced session answers what was already in front of it in the queue; the fresh
  // generation starts empty, so the stale result never reaches it.
  fake.deliver(topicEvent('next', 'Now answer this human input'))
  await until(() =>
    fake.sent.some((message) =>
      message.text.includes('Answered the next human input.'),
    ),
  )
  const answer = t.model.calls.at(-1)!
  expect(answer.lastUserText).toContain('Now answer this human input')
  expect(answer.lastUserText).not.toContain('Background command bg-1')
})
