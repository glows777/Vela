import { afterEach, expect, test } from 'bun:test'
import { createTestFixture, type TestFixture } from '../testing/harness'
import { dreamCommands } from './dream'

const fixtures: TestFixture[] = []

afterEach(() => {
  for (const fixture of fixtures) fixture.cleanup()
  fixtures.length = 0
})

test('/dream 在 agentLoop 前执行 prepareContext', async () => {
  const fixture = createTestFixture({ commands: dreamCommands })
  fixtures.push(fixture)

  let prepareCount = 0
  fixture.ctx.prepareContext = async () => {
    prepareCount++
  }

  expect(fixture.dispatch('/dream', fixture.ctx)).toBe('async')

  const start = Date.now()
  while (fixture.askCount() === 0) {
    if (Date.now() - start > 10_000) {
      throw new Error('dream 未在超时内完成')
    }
    await Bun.sleep(50)
  }

  expect(prepareCount).toBeGreaterThan(0)
})

test('dream persists the updated summary produced during preparation', async () => {
  const fixture = createTestFixture({ commands: dreamCommands })
  fixtures.push(fixture)
  await fixture.contextManager.commit([], 'old summary')
  fixture.ctx.prepareContext = async () => {
    await fixture.contextManager.commit(fixture.ctx.messages.slice(), 'new summary')
  }
  fixture.dispatch('/dream', fixture.ctx)
  const start = Date.now()
  while (!fixture.askCount()) {
    if (Date.now() - start > 10000) throw new Error('dream timeout')
    await Bun.sleep(50)
  }
  expect((await fixture.ctx.sessionStore.loadState()).summary).toBe('new summary')
})
