import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { tempDir } from '@glows777/vela/testing'
import {
  createFauxModel,
  fauxText,
} from '../../packages/vela/src/testing/core/index.ts'
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
