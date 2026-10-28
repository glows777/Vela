import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { EventReceiver } from '../../src/event-receiver.ts'

function receiver(
  publish: ConstructorParameters<typeof EventReceiver>[1] = async () => {},
) {
  const logs: string[] = []
  const instance = new EventReceiver(
    { port: 0, github: { secret: 'fixture', repositories: ['owner/repo'] } },
    publish,
    {
      debug() {},
      info: (s) => logs.push(s),
      warn: (s) => logs.push(s),
      error: (s) => logs.push(s),
    },
  )
  return {
    instance,
    url: () =>
      logs.join('\n').match(/http:\/\/127\.0\.0\.1:\d+\/events\/github/)![0],
  }
}

test('dispose racing receiver listen waits for startup and leaves no listening socket', async () => {
  const f = receiver()
  const start = f.instance.start()
  await f.instance.stop()
  await start
  try {
    expect(await fetch(f.url()).catch(() => undefined)).toBeUndefined()
  } finally {
    await f.instance.stop()
  }
})

test('an accepted delivery id is not retried after publication failure', async () => {
  let calls = 0
  const f = receiver(async () => {
    calls++
    throw new Error('fixture storage outage')
  })
  await f.instance.start()
  const raw = JSON.stringify({
    action: 'closed',
    repository: { full_name: 'owner/repo' },
    pull_request: {
      number: 1,
      merged: true,
      title: 'Fixture',
      user: { login: 'author' },
      head: { sha: 'a'.repeat(40) },
      html_url: 'https://github.com/owner/repo/pull/1',
    },
  })
  const send = () =>
    fetch(f.url(), {
      method: 'POST',
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'same',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'fixture').update(raw).digest('hex')}`,
      },
      body: raw,
    })
  try {
    expect((await send()).status).toBe(503)
    expect((await send()).status).toBe(202)
    expect(calls).toBe(1)
  } finally {
    await f.instance.stop()
  }
})
