import { expect, test } from 'bun:test'
import { restoreDraft } from '../../apps/desktop/src/shared/draft.ts'

test('a rejected submission keeps its text and a newer draft', () => {
  expect(restoreDraft('first draft', '')).toBe('first draft')
  expect(restoreDraft('first draft', 'second draft')).toBe(
    'first draft\nsecond draft',
  )
  expect(restoreDraft('first draft', 'second\nthird')).toBe(
    'first draft\nsecond\nthird',
  )
})
