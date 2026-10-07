import { afterEach, expect, test } from 'bun:test'
import { fauxText } from '../../../../src/testing/faux'
import {
  captureConsole,
  cleanupTestVelas,
  createTestVela,
} from '../../../support/vela'

afterEach(cleanupTestVelas)

test('/dream 在 agentLoop 前执行 prepareContext，并把整理请求交给模型', async () => {
  const t = createTestVela({ responses: [fauxText('记忆已整理')] })
  let prepareCount = 0
  const prepare = t.session.prepareContext.bind(t.session)
  t.session.prepareContext = async (request, options) => {
    prepareCount++
    await prepare(request, options)
  }

  const { result } = await captureConsole(() => t.command('/dream'))

  expect(result).toBe('async')
  expect(prepareCount).toBeGreaterThan(0)
  expect(t.model.calls).toHaveLength(1)
  expect(t.lastAssistantText()).toBe('记忆已整理')
  expect(t.session.busy.locked).toBe(false)
})

test('dream persists the updated summary produced during preparation', async () => {
  const t = createTestVela({ responses: [fauxText('ok')] })
  await t.session.contextManager.commit([], 'old summary')
  t.session.prepareContext = async () => {
    await t.session.contextManager.commit(t.messages.slice(), 'new summary')
  }
  await captureConsole(() => t.command('/dream'))
  expect((await t.session.store.loadState()).summary).toBe('new summary')
})
