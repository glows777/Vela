import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveShellPath } from '../../../src/cli/shell.ts'

const root = mkdtempSync(join(tmpdir(), 'vela-shell-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function fakeBash(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  return path
}

test('Windows prefers the Git for Windows bash wrapper over a bash.cmd shim on PATH', () => {
  const gitRoot = join(root, 'Program Files', 'Git')
  const bash = fakeBash(join(gitRoot, 'bin', 'bash.exe'))
  const shimDir = join(root, 'npm')

  expect(
    resolveShellPath(undefined, {
      platform: 'win32',
      env: {
        ProgramFiles: join(root, 'Program Files'),
        PATH: `${shimDir};${join(gitRoot, 'cmd')}`,
      },
    }),
  ).toBe(bash)
})

test('Windows finds a custom Git for Windows installation from its cmd directory on PATH', () => {
  const gitRoot = join(root, 'portable-git')
  const bash = fakeBash(join(gitRoot, 'bin', 'bash.exe'))

  expect(
    resolveShellPath(undefined, {
      platform: 'win32',
      env: { PATH: join(gitRoot, 'cmd') },
    }),
  ).toBe(bash)
})

test('an explicit shellPath wins and non-Windows defaults remain bash on PATH', () => {
  const configured = join(root, 'custom', 'bash.exe')
  fakeBash(configured)

  expect(resolveShellPath(configured, { platform: 'win32', env: {} })).toBe(
    configured,
  )
  expect(resolveShellPath(undefined, { platform: 'linux', env: {} })).toBe(
    'bash',
  )
})
