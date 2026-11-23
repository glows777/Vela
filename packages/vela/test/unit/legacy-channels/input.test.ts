import { expect, test } from 'bun:test'
import {
  modelInputText,
  UNTAGGED_INPUT,
} from '../../../src/legacy-channels/input.ts'
import type { IncomingMessage } from '../../../src/legacy-channels/types.ts'

const input = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  channelId: 'oc_group',
  chatKind: 'group',
  senderId: 'ou_alice',
  senderName: 'Alice',
  text: '[09:40] Alice: the build is green',
  ...overrides,
})

test('a passive input identifies itself and every other input passes through', () => {
  expect(modelInputText(input())).toBe('[09:40] Alice: the build is green')
  expect(modelInputText(input({ passive: true }))).toBe(
    `${UNTAGGED_INPUT}\n[09:40] Alice: the build is green`,
  )
})

test('a replayed passive input keeps the single marker it was saved with', () => {
  const replayed = input({
    passive: true,
    text: `${UNTAGGED_INPUT}\n[09:40] Alice: hi`,
  })
  expect(modelInputText(replayed)).toBe(replayed.text)
})
