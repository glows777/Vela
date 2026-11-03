import { afterAll, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyToClipboard } from '../../../src/cli/clipboard.ts'

const dir = mkdtempSync(join(tmpdir(), 'vela-clipboard-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const linuxTest = process.platform === 'win32' ? test.skip : test

/** A fake `xclip` on PATH that saves its stdin */
function fakeXclip(): string {
  const bin = join(dir, 'bin')
  const out = join(dir, 'copied.txt')
  Bun.spawnSync(['mkdir', '-p', bin])
  writeFileSync(join(bin, 'xclip'), `#!/bin/sh\ncat > '${out}'\n`)
  chmodSync(join(bin, 'xclip'), 0o755)
  return out
}

linuxTest(
  'with a display, the text goes through xclip and no OSC 52 is sent',
  async () => {
    const out = fakeXclip()
    const written: string[] = []
    await copyToClipboard('héllo', {
      platform: 'linux',
      env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, DISPLAY: ':0' },
      writeTerminal: (data) => written.push(data),
    })
    expect(readFileSync(out, 'utf8')).toBe('héllo')
    expect(written).toEqual([])
  },
)

test('without a display, OSC 52 goes to the terminal', async () => {
  const written: string[] = []
  await copyToClipboard('hi', {
    platform: 'linux',
    env: { PATH: '/nonexistent', WSL_DISTRO_NAME: undefined },
    writeTerminal: (data) => written.push(data),
  })
  expect(written).toEqual([
    `\x1b]52;c;${Buffer.from('hi').toString('base64')}\x07`,
  ])
})

linuxTest(
  'over SSH, OSC 52 is sent even after a local copy (it reaches the client)',
  async () => {
    fakeXclip()
    const written: string[] = []
    await copyToClipboard('hi', {
      platform: 'linux',
      env: {
        PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        DISPLAY: ':0',
        SSH_CONNECTION: '1 2 3 4',
      },
      writeTerminal: (data) => written.push(data),
    })
    expect(written).toHaveLength(1)
  },
)

test('a display with no clipboard tool fails loudly with what to install', async () => {
  await expect(
    copyToClipboard('hi', {
      platform: 'linux',
      env: { PATH: '/nonexistent', DISPLAY: ':0' },
      writeTerminal: () => {},
    }),
  ).rejects.toThrow('install `xclip` or `xsel`')
})

test('Windows copies Unicode text through an explicit UTF-8 file read', async () => {
  const text = '中文 clipboard 🙂\nsecond line\n'.repeat(100)
  const copied: string[] = []
  const commands: string[] = []
  await copyToClipboard(text, {
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32' },
    runCommand: async (command, args, _env, input) => {
      commands.push(command)
      expect(input).toBeUndefined()
      expect(command).toBe('powershell.exe')
      expect(args.slice(0, 2)).toEqual(['-NoProfile', '-Command'])
      const script = args[2] ?? ''
      expect(script).toContain('Set-Clipboard -Value')
      expect(script).toContain('[System.Text.Encoding]::UTF8')
      const path = /ReadAllText\('((?:[^']|'')*)'/.exec(script)?.[1]
      expect(path).toBeString()
      copied.push(readFileSync(path!.replaceAll("''", "'"), 'utf8'))
      return Buffer.alloc(0)
    },
  })

  expect(commands).toEqual(['powershell.exe'])
  expect(copied).toEqual([text])
})
