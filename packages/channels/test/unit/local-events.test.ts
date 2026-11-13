import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { LocalEvents } from '../../src/local-events.ts'
import type { LocalEvent } from '../../src/local-protocol.ts'

const status = { type: 'status', data: { text: 'Ready' } } as const

class Response extends EventEmitter {
  frames: string[] = []
  headers: unknown
  destroyed = false
  writable = true
  writeHead(status: number, headers: unknown) {
    this.headers = { status, headers }
  }
  write(frame: string) {
    this.frames.push(frame)
    return this.writable
  }
  destroy() {
    this.destroyed = true
    this.emit('close')
  }
  get response() {
    return this as unknown as ServerResponse
  }
}

function decode(frame: string): LocalEvent {
  return JSON.parse(
    frame
      .split('\n')
      .find((line) => line.startsWith('data: '))!
      .slice(6),
  )
}

test('Local bus is future-only, filtered, detached, exception-isolated and unsubscribable', async () => {
  const events = new LocalEvents()
  events.publish(status, { projectId: 'first' })
  const all: LocalEvent[] = []
  const selected: LocalEvent[] = []
  events.subscribe((event) => {
    if (event.type === 'status') event.data.text = 'mutated'
    throw new Error('broken observer')
  })
  events.subscribe(async () => {
    throw new Error('async observer')
  })
  events.subscribe(() => new Promise<void>(() => {}))
  const off = events.subscribe((event) => all.push(event))
  events.subscribe((event) => selected.push(event), { projectId: 'first' })
  expect(all).toEqual([])
  events.publish(status, {
    projectId: 'first',
    sessionId: 'session',
    runId: 'run',
  })
  events.publish(status, { projectId: 'second' })
  await Promise.resolve()
  expect(all).toHaveLength(2)
  expect(selected).toHaveLength(1)
  expect(all[0]).toEqual(selected[0])
  expect(all[0]).not.toBe(selected[0])
  expect(all[0]).toMatchObject({
    version: 1,
    projectId: 'first',
    sessionId: 'session',
    runId: 'run',
    data: { text: 'Ready' },
  })
  expect(all[0]!.id).not.toBe(all[1]!.id)
  expect(Number.isNaN(Date.parse(all[0]!.time))).toBe(false)
  off()
  events.publish(status, { projectId: 'first' })
  expect(all).toHaveLength(2)
  expect(selected).toHaveLength(2)
  events.stop()
  events.publish(status, { projectId: 'first' })
  expect(selected).toHaveLength(2)
})

test('SSE reset belongs only to its connection; frames share the Local bus envelope', async () => {
  const { LocalSse } = await import('../../src/local-sse.ts')
  const events = new LocalEvents()
  const observed: LocalEvent[] = []
  events.subscribe((event) => observed.push(event))
  const sse = new LocalSse(events)
  const first = new Response()
  sse.connect(first.response, 'first')
  expect(decode(first.frames[0]!)).toMatchObject({
    type: 'reset',
    version: 1,
    projectId: 'first',
  })
  expect(observed).toEqual([])
  const second = new Response()
  sse.connect(second.response, 'second')
  expect(first.frames).toHaveLength(1)
  events.publish(status, { projectId: 'first' })
  expect(first.frames).toHaveLength(2)
  expect(second.frames).toHaveLength(1)
  expect(decode(first.frames[1]!)).toEqual(observed[0]!)
  first.destroy()
  events.publish(status, { projectId: 'first' })
  expect(first.frames).toHaveLength(2)
  expect(observed).toHaveLength(2)
  sse.stop()
  expect(second.destroyed).toBe(true)
  events.publish(status, { projectId: 'second' })
  expect(second.frames).toHaveLength(1)
  expect(observed).toHaveLength(3)
})

test('SSE backpressure disconnects only the slow observer without delaying host events', async () => {
  const { LocalSse } = await import('../../src/local-sse.ts')
  const events = new LocalEvents()
  const sse = new LocalSse(events)
  const slow = new Response()
  const healthy = new Response()
  sse.connect(slow.response)
  sse.connect(healthy.response)
  slow.writable = false
  let received = 0
  events.subscribe(() => {
    received++
  })
  events.publish(status, { projectId: 'first' })
  expect(slow.destroyed).toBe(true)
  expect(healthy.destroyed).toBe(false)
  events.publish(status, { projectId: 'first' })
  expect(slow.frames).toHaveLength(2)
  expect(healthy.frames).toHaveLength(3)
  expect(received).toBe(2)
  sse.stop()
})
