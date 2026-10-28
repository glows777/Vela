import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { tempDir } from '@glows777/vela/testing'
import { createFauxModel, fauxText } from '@glows777/vela-core/testing'
import { createVela } from '../support/compat-vela.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function causes(error: unknown): unknown[] {
  return error instanceof AggregateError
    ? error.errors.flatMap(causes)
    : [error]
}

for (const failure of [-1, 0, 1, 2]) {
  for (const asyncStop of [false, true]) {
    test(`dispose attempts all cleanup after ${asyncStop ? 'async' : 'sync'} channel failure ${failure}`, async () => {
      const dir = tempDir()
      const stopped: number[] = []
      const order: string[] = []
      const fault = new Error('channel stop failed')
      let notified = 0
      const vela = createVela({
        cwd: dir.path,
        contextFiles: false,
        model: createFauxModel({ responses: [fauxText('ready')] }),
        extensions: [
          function cleanup(api) {
            for (let i = 0; i < 3; i++)
              api.registerChannel({
                name: `test${i}`,
                description: 'cleanup probe',
                start() {},
                async send() {},
                stop() {
                  stopped.push(i)
                  if (i === failure) {
                    if (asyncStop) return Promise.reject(fault)
                    throw fault
                  }
                },
              })
            api.on('session_shutdown', () => {
              order.push('session')
            })
            api.onShutdown(() => {
              order.push('extension')
            })
          },
        ],
      })
      try {
        await vela.ready()
        await vela.startChannels()
        const session = vela.session('probe')
        await session.prompt('hello')
        vela.subscribe(() => {
          notified++
        })
        const first = vela.dispose()
        expect(vela.dispose()).toBe(first)
        const [result] = await Promise.allSettled([first])
        expect(result!.status).toBe(failure === -1 ? 'fulfilled' : 'rejected')
        if (result!.status === 'rejected')
          expect(causes(result!.reason)).toEqual([fault])
        expect(vela.dispose()).toBe(first)
        expect(stopped).toEqual([0, 1, 2])
        expect(order).toEqual(['session', 'extension'])
        expect(vela.sessions()).toEqual([])
        expect(existsSync(vela.dataDir)).toBe(false)
        session.emit({
          type: 'notify',
          message: 'after disposal',
          level: 'info',
        })
        expect(notified).toBe(0)
        expect(() => vela.session('new')).toThrow('disposed')
      } finally {
        await vela.dispose().catch(() => {})
        dir.cleanup()
      }
    })
  }
}

test('shutdown hook errors reach disposal only after all sessions and extension handlers settle', async () => {
  const dir = tempDir()
  const gate = deferred()
  const entered = deferred()
  const sessionFault = new Error('session shutdown failed')
  const extensionFault = new Error('shared shutdown failed')
  const order: string[] = []
  const logged: string[] = []
  const vela = createVela({
    cwd: dir.path,
    contextFiles: false,
    model: createFauxModel({ responses: [fauxText('a'), fauxText('b')] }),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(message) {
        logged.push(message)
      },
    },
    extensions: [
      function cleanup(api) {
        api.on('session_shutdown', async (_event, ctx) => {
          if (ctx.session.id === 'slow') {
            entered.resolve()
            await gate.promise
          }
          order.push(`first:${ctx.session.id}`)
          if (ctx.session.id === 'fail') throw sessionFault
        })
        api.on('session_shutdown', (_event, ctx) => {
          order.push(`second:${ctx.session.id}`)
        })
        api.onShutdown(() => {
          order.push('shared:first')
          throw extensionFault
        })
        api.onShutdown(() => {
          order.push('shared:second')
        })
      },
    ],
  })
  try {
    const failed = vela.session('fail')
    const slow = vela.session('slow')
    await failed.prompt('one')
    await slow.prompt('two')
    const first = vela.dispose()
    const result = Promise.allSettled([first])
    expect(vela.dispose()).toBe(first)
    await entered.promise
    expect(order).not.toContain('shared:first')
    gate.resolve()
    const [settled] = await result
    expect(settled!.status).toBe('rejected')
    if (settled!.status === 'rejected')
      expect(causes(settled!.reason)).toEqual([sessionFault, extensionFault])
    expect(order).toEqual([
      'first:fail',
      'second:fail',
      'first:slow',
      'second:slow',
      'shared:first',
      'shared:second',
    ])
    expect(logged).toHaveLength(2)
    expect(vela.sessions()).toEqual([])
    expect(existsSync(vela.dataDir)).toBe(false)
    expect(vela.dispose()).toBe(first)
    await expect(failed.close()).rejects.toThrow('Session shutdown failed')
    expect(order).toHaveLength(6)
  } finally {
    gate.resolve()
    await vela.dispose().catch(() => {})
    dir.cleanup()
  }
})

test('a rejected session close does not skip other close attempts or shared teardown', async () => {
  const dir = tempDir()
  const gate = deferred()
  const entered = deferred()
  const fault = new Error('close failed')
  let shutdown = false
  const vela = createVela({
    cwd: dir.path,
    contextFiles: false,
    extensions: [
      function cleanup(api) {
        api.onShutdown(() => {
          shutdown = true
        })
      },
    ],
  })
  const failed = vela.session('failed')
  const realClose = failed.close.bind(failed)
  failed.close = () => {
    throw fault
  }
  const slow = vela.session('slow')
  const slowClose = slow.close.bind(slow)
  slow.close = async () => {
    entered.resolve()
    await gate.promise
    await slowClose()
  }
  try {
    const result = Promise.allSettled([vela.dispose()])
    await entered.promise
    expect(shutdown).toBe(false)
    gate.resolve()
    const [settled] = await result
    expect(settled!.status).toBe('rejected')
    if (settled!.status === 'rejected')
      expect(causes(settled!.reason)).toEqual([fault])
    expect(shutdown).toBe(true)
    expect(vela.sessions()).toEqual([failed])
    expect(existsSync(vela.dataDir)).toBe(false)
  } finally {
    gate.resolve()
    await realClose()
    await vela.dispose().catch(() => {})
    dir.cleanup()
  }
})

test('dispose waits for late factory registrations even after another async factory fails', async () => {
  const dir = tempDir()
  const gate = deferred()
  const stopped: string[] = []
  const vela = createVela({
    cwd: dir.path,
    contextFiles: false,
    extensions: [
      async function failed() {
        throw new Error('factory failed')
      },
      async function late(api) {
        await gate.promise
        api.registerChannel({
          name: 'late',
          description: 'late',
          start() {},
          async send() {},
          stop() {
            stopped.push('channel')
          },
        })
        api.onShutdown(() => {
          stopped.push('extension')
        })
      },
    ],
  })
  try {
    await expect(vela.ready()).rejects.toThrow('factory failed')
    const first = vela.dispose()
    let settled = false
    void first.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.resolve()
    await first
    expect(stopped).toEqual(['channel', 'extension'])
    expect(existsSync(vela.dataDir)).toBe(false)
  } finally {
    gate.resolve()
    await vela.dispose()
    dir.cleanup()
  }
})
