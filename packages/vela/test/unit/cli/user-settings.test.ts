import { afterAll, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveUserSettings } from '../../../src/cli/user-settings.ts'

const root = mkdtempSync(join(tmpdir(), 'vela-user-settings-test-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('an interrupted write leaves the previous settings.json intact', () => {
  const dir = mkdtempSync(join(root, 'agent-'))
  const path = join(dir, 'settings.json')
  writeFileSync(path, '{"old":true}\n', { mode: 0o600 })
  expect(() =>
    saveUserSettings(dir, {
      toJSON() {
        throw new Error('boom')
      },
    }),
  ).toThrow('boom')
  expect(readFileSync(path, 'utf8')).toBe('{"old":true}\n')
  expect(readdirSync(dir)).toEqual(['settings.json'])
})
