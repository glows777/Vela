import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as atomic from '../../src/atomic-json.ts'
import { ChannelDirectory } from '../../src/directory.ts'

test('a background start committing during Stop preserves both the job and the stopped state on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vela-bg-directory-'))
  const directory = new ChannelDirectory(root)
  const msg = {
    channelId: 'chat',
    senderId: 'owner',
    senderName: 'Owner',
    text: 'start',
    replyToId: 'trigger',
  }
  await directory.admit('task', 'local', msg)
  await directory.begin('task', msg)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = atomic.writeAtomicJson
  let hold = true
  const write = spyOn(atomic, 'writeAtomicJson').mockImplementation(
    async (path, value) => {
      await original(path, value)
      if (hold) {
        hold = false
        entered.resolve()
        await release.promise
      }
    },
  )
  try {
    const started = directory.startBackground('task', 'task', {
      token: 'unique-job',
      id: 'bg-1',
      commandHead: 'sleep',
    })
    await entered.promise
    const stopped = directory.finish('task', 'stopped')
    release.resolve()
    await Promise.all([started, stopped])
    const disk = JSON.parse(
      await readFile(join(root, 'channels/index.json'), 'utf8'),
    ).records[0]
    expect(disk.state).toBe('stopped')
    expect(disk.outstandingJobs).toEqual([
      {
        token: 'unique-job',
        id: 'bg-1',
        commandHead: 'sleep',
        sessionId: 'task',
      },
    ])
    expect(directory.get('task')?.state).toBe('stopped')
  } finally {
    release.resolve()
    write.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

test('an in-memory directory rejects an inactive generation through its Promise contract', async () => {
  const directory = new ChannelDirectory()
  let result!: Promise<void>
  expect(() => {
    result = directory.startBackground('missing', 'old', {
      token: 'token',
      id: 'bg-1',
      commandHead: 'sleep',
    })
  }).not.toThrow()
  await expect(result).rejects.toThrow('inactive channel session')
})
