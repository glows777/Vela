import { expect, test } from 'bun:test'
import {
  createDispatcher,
  type CommandContext,
  type CommandHandler,
} from '../../../../src/cli/commands/index.ts'

const fakeCtx = {} as CommandContext

test('the first handler that returns true wins', () => {
  const history: string[] = []
  const handlers: CommandHandler[] = [
    (cmd) => {
      history.push('a')
      return cmd === 'x'
    },
    () => {
      history.push('b')
      return false
    },
    () => {
      history.push('c')
      return true
    },
  ]
  const dispatch = createDispatcher(handlers)
  expect(dispatch('y', fakeCtx)).toBe(true)
  expect(history).toEqual(['a', 'b', 'c'])
})

test('a handler returning a Promise (async command) short-circuits immediately', async () => {
  const history: string[] = []
  const handlers: CommandHandler[] = [
    () => {
      history.push('a')
      return Promise.resolve()
    },
    () => {
      history.push('b')
      return true
    },
  ]
  const result = createDispatcher(handlers)('x', fakeCtx)
  expect(result).toBeInstanceOf(Promise)
  await result
  expect(history).toEqual(['a'])
})

test('returns false when nothing matches', () => {
  const dispatch = createDispatcher([() => false, () => false])
  expect(dispatch('anything', fakeCtx)).toBe(false)
})
