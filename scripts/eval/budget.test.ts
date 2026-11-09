import { expect, test } from 'bun:test'
import {
  isolatedOutputLimit,
  RequestBudget,
  requestReservation,
} from './budget.ts'

test('a request is refused before starting when its peak reservation cannot fit', async () => {
  await expect(
    new RequestBudget(requestReservation - 0.001).admit(),
  ).rejects.toThrow('before provider request')
})

test('unknown usage retains the full reservation and prevents an unaffordable next request', async () => {
  const budget = new RequestBudget(requestReservation + 0.01, 5)
  const ticket = await budget.admit()
  budget.settle(ticket, undefined)
  expect(budget.upperBound).toBe(requestReservation)
  await expect(budget.admit()).rejects.toThrow('budget exhausted')
})

test('known usage releases unused reserve without dropping other in-flight reservations', async () => {
  const budget = new RequestBudget(requestReservation * 2, 5)
  const first = await budget.admit()
  await budget.admit()
  budget.settle(first, {
    inputTokens: { total: 1000, cacheRead: 500, noCache: 500, cacheWrite: 0 },
    outputTokens: { total: 100, text: 100, reasoning: 0 },
  })
  expect(budget.upperBound).toBeCloseTo(requestReservation + 0.000273, 9)
  await expect(budget.admit()).rejects.toThrow('budget exhausted')
  expect(isolatedOutputLimit).toBe(8192)
})

test('a concurrent request waits for a known settlement instead of aborting an affordable run', async () => {
  const budget = new RequestBudget(0.5)
  const first = await budget.admit()
  let admitted = false
  const waiting = Promise.resolve(budget.admit()).then((ticket) => {
    admitted = true
    return ticket
  })
  await Bun.sleep(5)
  expect(admitted).toBe(false)
  expect(budget.upperBound).toBe(requestReservation)
  budget.settle(first, {
    inputTokens: { total: 1000, cacheRead: 500, noCache: 500, cacheWrite: 0 },
    outputTokens: { total: 100, text: 100, reasoning: 0 },
  })
  await waiting
  expect(admitted).toBe(true)
  expect(budget.upperBound).toBeCloseTo(requestReservation + 0.000273, 9)
  expect(budget.upperBound).toBeLessThan(0.5)
})

test('multiple waiting requests cannot claim the same released reserve', async () => {
  const budget = new RequestBudget(0.5)
  const first = await budget.admit()
  let admitted = 0
  const second = budget.admit().then((ticket) => {
    admitted++
    return ticket
  })
  const third = budget.admit().then((ticket) => {
    admitted++
    return ticket
  })
  const usage = {
    inputTokens: { total: 1000, cacheRead: 500, noCache: 500, cacheWrite: 0 },
    outputTokens: { total: 100, text: 100, reasoning: 0 },
  }
  budget.settle(first, usage)
  const ticket = await second
  expect(admitted).toBe(1)
  expect(budget.upperBound).toBeLessThan(0.5)
  budget.settle(ticket, usage)
  await third
  expect(admitted).toBe(2)
  expect(budget.upperBound).toBeCloseTo(requestReservation + 0.000546, 9)
})
