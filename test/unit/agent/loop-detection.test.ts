import { expect, test } from 'bun:test'
import {
  LoopDetector,
  recordToolCall,
  recordToolCallResult,
  resetHistory,
} from '../../../src/agent/loop-detection'

test('matches parallel tool results by toolCallId', () => {
  resetHistory()
  const input = { path: 'same' }
  recordToolCall('call-a', 'read_file', input)
  recordToolCall('call-b', 'read_file', input)

  expect(recordToolCallResult('call-b', 'read_file', input, 'result-b')).toBe(true)
  expect(recordToolCallResult('call-a', 'read_file', input, 'result-a')).toBe(true)
  expect(recordToolCallResult('call-b', 'read_file', input, 'duplicate')).toBe(false)
  resetHistory()
})

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

test('argument order does not matter; different arguments are different calls', () => {
  const detector = new LoopDetector()
  for (let i = 0; i < 10; i++) detector.record(`c${i}`, 't', { a: 1, b: 2 })
  expect(detector.detect('t', { b: 2, a: 1 })).toMatchObject({ stuck: true, level: 'warning' })
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
