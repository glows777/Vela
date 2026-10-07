import { expect, test } from 'bun:test'
import {
  createDispatcher,
  type CommandContext,
  type CommandHandler,
} from '../../../../src/cli/commands/index.ts'

const fakeCtx = {} as CommandContext

test('第一个返回 true 的 handler 获胜', () => {
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

test('handler 返回 Promise（异步命令）时立即短路', async () => {
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

test('全部未匹配时返回 false', () => {
  const dispatch = createDispatcher([() => false, () => false])
  expect(dispatch('anything', fakeCtx)).toBe(false)
})
