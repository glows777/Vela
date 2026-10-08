import { expect, test } from 'bun:test'
import { LoopDetector } from '../../../src/agent/loop-detection.ts'

test('generic repeat: warning at 10 identical calls, critical at 20', () => {
  const detector = new LoopDetector()
  const levels: string[] = []
  for (let i = 0; i < 21; i++) {
    const result = detector.detect('grep', { pattern: 'x' })
    levels.push(result.stuck ? result.level : 'ok')
    detector.record(`c${i}`, 'grep', { pattern: 'x' })
  }
  expect(levels.slice(0, 10).every((l) => l === 'ok')).toBe(true)
  expect(levels[10]).toBe('warning')
  expect(levels[20]).toBe('critical')
})

test('the first critical for any repetition is at most the 21st call, well inside the 30-call window', () => {
  // Identical calls (whatever their results) and two-call ping-pong both stop at the 21st call,
  // so no detector needs a full window of 30 identical calls
  for (const argsAt of [() => ({ p: 'x' }), (i: number) => ({ p: i % 2 ? 'a' : 'b' })]) {
    const detector = new LoopDetector()
    let firstCritical = -1
    for (let i = 0; i < 30 && firstCritical < 0; i++) {
      const result = detector.detect('t', argsAt(i))
      if (result.stuck && result.level === 'critical') firstCritical = i
      detector.record(`c${i}`, 't', argsAt(i))
    }
    expect(firstCritical).toBeGreaterThanOrEqual(0)
    expect(firstCritical).toBeLessThanOrEqual(20)
  }
})

test('argument order does not matter; different arguments are different calls', () => {
  const detector = new LoopDetector()
  for (let i = 0; i < 10; i++) detector.record(`c${i}`, 't', { a: 1, b: 2 })
  expect(detector.detect('t', { b: 2, a: 1 })).toMatchObject({
    stuck: true,
    level: 'warning',
  })
  expect(detector.detect('t', { a: 1, b: 3 })).toEqual({ stuck: false })
})

test('ping-pong between two calls is detected', () => {
  const detector = new LoopDetector()
  let last: ReturnType<LoopDetector['detect']> = { stuck: false }
  for (let i = 0; i < 12; i++) {
    const args = { path: i % 2 ? 'a' : 'b' }
    last = detector.detect('read_file', args)
    detector.record(`c${i}`, 'read_file', args)
  }
  expect(last).toMatchObject({ stuck: true, detector: 'ping_pong' })
})

test('each detector instance has its own history', () => {
  const a = new LoopDetector()
  const b = new LoopDetector()
  for (let i = 0; i < 10; i++) a.record(`c${i}`, 't', {})
  expect(a.detect('t', {}).stuck).toBe(true)
  expect(b.detect('t', {}).stuck).toBe(false)
})
